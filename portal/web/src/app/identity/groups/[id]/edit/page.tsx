"use client";

// Edit Group page — Identity Management -> Administration -> Groups -> [id] -> Edit
// (EPIC-014 SPEC.md §3.1, §4.1; T-0883). The group is read from the tenant's group list
// (the BFF has no single-group read) and saved through PATCH /v1/tenants/:tenantId/groups/:groupId.
import React, { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../../lib/useCurrentTenant";
import { GroupForm } from "../../../../../components/groups/GroupForm";
import { getGroup, type GroupItem } from "../../../../../lib/groupsApi";

function EditGroupView({ tenantId }: { readonly tenantId: string }): React.ReactElement {
  const router = useRouter();
  const params = useParams();
  const groupId = String(params.id || "");

  const [group, setGroup] = useState<GroupItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function loadGroup() {
      try {
        setLoading(true);
        setError(null);
        const data = await getGroup(tenantId, groupId);
        if (active) setGroup(data);
      } catch (err: any) {
        if (active) setError(err.message || "Failed to load group");
      } finally {
        if (active) setLoading(false);
      }
    }
    loadGroup();
    return () => {
      active = false;
    };
  }, [tenantId, groupId]);

  const backToList = () => {
    router.push(`/identity/groups?tenantId=${encodeURIComponent(tenantId)}`);
  };

  return (
    <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div style={{ fontSize: "12px", color: "var(--text-muted, #6b7280)" }}>
          Identity Management &gt; Administration &gt; Groups &gt; {group?.name ?? groupId} &gt; Edit
        </div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: 0 }}>Edit Group</h1>
      </div>

      {loading && <div data-testid="edit-group-loading">Loading group...</div>}

      {!loading && error && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", alignItems: "flex-start" }}>
          <div role="alert" data-testid="edit-group-error" style={{ color: "var(--danger, #dc2626)" }}>
            {error}
          </div>
          <button type="button" onClick={backToList} data-testid="edit-group-back" style={{ padding: "8px 16px", cursor: "pointer" }}>
            Back to groups
          </button>
        </div>
      )}

      {!loading && !error && group && (
        <GroupForm tenantId={tenantId} mode="edit" initialGroup={group} onSuccess={backToList} onCancel={backToList} />
      )}
    </div>
  );
}

export default function EditGroupPage(): React.ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <EditGroupView tenantId={tenantId} />
    </RequireTenant>
  );
}
