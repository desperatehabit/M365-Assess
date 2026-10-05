"use client";

// Groups page — Identity Management -> Administration -> Groups (EPIC-014 SPEC.md §3.1; T-0263).
import React, { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import { GroupsTable, type GroupRowAction } from "../../../components/groups/GroupsTable";
import { DeliveryManagementDialog, GalDialog } from "../../../components/groups/GalDeliveryDialog";
import { GroupDeleteDialog } from "../../../components/groups/GroupDeleteDialog";
import { listAllGroups, type GroupItem } from "../../../lib/groupsApi";

type GroupDialog = { readonly kind: "delete" | "gal" | "delivery"; readonly group: GroupItem } | null;

function GroupsView({ tenantId }: { readonly tenantId: string }): React.ReactElement {
  const router = useRouter();

  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<GroupDialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    async function fetchGroups() {
      try {
        setLoading(true);
        setError(null);
        const items = await listAllGroups(tenantId);
        if (active) {
          setGroups(items);
        }
      } catch (err: any) {
        if (active) {
          setError(err.message || "Failed to load groups");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    fetchGroups();
    return () => {
      active = false;
    };
  }, [tenantId, reloadKey]);

  const reload = () => setReloadKey((key) => key + 1);

  const handleAction = (action: GroupRowAction, group: GroupItem) => {
    const tenantQuery = `tenantId=${encodeURIComponent(tenantId)}`;
    const id = encodeURIComponent(group.id);
    setNotice(null);
    switch (action) {
      case "view":
        // GroupsTable opens the detail drawer itself.
        break;
      case "edit":
        router.push(`/identity/groups/${id}/edit?${tenantQuery}`);
        break;
      case "manageMembers":
        router.push(`/identity/groups/${id}/bulk?${tenantQuery}&role=members`);
        break;
      case "manageOwners":
        router.push(`/identity/groups/${id}/bulk?${tenantQuery}&role=owners`);
        break;
      case "delete":
      case "gal":
      case "delivery":
        setDialog({ kind: action, group });
        break;
      case "convert":
        // There is no group-convert endpoint in the BFF (the Set-Group worker lists the
        // action, no route exposes it), so say so rather than do nothing.
        setNotice(
          `Convert is not available for "${group.name}": the portal has no group conversion endpoint yet.`,
        );
        break;
    }
  };

  return (
    <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div style={{ fontSize: "12px", color: "var(--text-muted, #6b7280)" }}>
          Identity Management &gt; Administration &gt; Groups
        </div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: 0 }}>Groups</h1>
      </div>

      {notice && (
        <div
          role="status"
          data-testid="groups-notice"
          style={{
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            background: "var(--surface)",
            fontSize: "14px",
          }}
        >
          {notice}
        </div>
      )}

      <GroupsTable
        groups={groups}
        loading={loading}
        error={error}
        onAddGroup={() => router.push(`/identity/groups/new?tenantId=${encodeURIComponent(tenantId)}`)}
        onAction={handleAction}
      />

      {dialog?.kind === "delete" && (
        <GroupDeleteDialog
          tenantId={tenantId}
          group={dialog.group}
          onClose={() => setDialog(null)}
          onDeleted={reload}
        />
      )}

      {dialog?.kind === "gal" && (
        <GalDialog
          isOpen={true}
          tenantId={tenantId}
          groupId={dialog.group.id}
          groupName={dialog.group.name}
          initialHiddenFromAddressListsEnabled={dialog.group.hiddenFromAddressListsEnabled}
          onClose={() => setDialog(null)}
          onSuccess={reload}
        />
      )}

      {dialog?.kind === "delivery" && (
        <DeliveryManagementDialog
          isOpen={true}
          tenantId={tenantId}
          groupId={dialog.group.id}
          groupName={dialog.group.name}
          initialRequireSenderAuthenticationEnabled={dialog.group.deliveryManagementEnabled}
          onClose={() => setDialog(null)}
          onSuccess={reload}
        />
      )}
    </div>
  );
}

export default function GroupsPage(): React.ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <GroupsView tenantId={tenantId} />
    </RequireTenant>
  );
}
