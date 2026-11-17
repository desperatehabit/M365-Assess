"use client";

// Groups page — Identity Management -> Administration -> Groups (EPIC-014 SPEC.md §3.1; T-0263, T-0900).
import React, { useEffect, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import { GroupsTable, type GroupRowAction } from "../../../components/groups/GroupsTable";
import { DeliveryManagementDialog, GalDialog } from "../../../components/groups/GalDeliveryDialog";
import { GroupDeleteDialog } from "../../../components/groups/GroupDeleteDialog";
import {
  convertGroup,
  listAllGroups,
  validateDynamicRule,
  type GroupItem,
  type GroupType,
} from "../../../lib/groupsApi";

type GroupDialog = { readonly kind: "delete" | "gal" | "delivery" | "convert"; readonly group: GroupItem } | null;

const CONVERT_TYPE_OPTIONS: ReadonlyArray<{ readonly value: GroupType; readonly label: string }> = [
  { value: "security", label: "Security" },
  { value: "m365", label: "Microsoft 365" },
  { value: "distribution", label: "Distribution" },
  { value: "mailEnabledSecurity", label: "Mail-enabled Security" },
  { value: "dynamic", label: "Dynamic" },
];

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, rgba(0, 0, 0, 0.5))",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  zIndex: 1000,
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "520px",
  background: "var(--bg-elev, #ffffff)",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text, #111827)",
};

const btnStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: "6px",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
  border: "1px solid var(--border, #d1d5db)",
  background: "var(--bg-muted, #f3f4f6)",
  color: "var(--text, #111827)",
};

const primaryBtnStyle: CSSProperties = {
  ...btnStyle,
  border: "none",
  background: "var(--primary, #2563eb)",
  color: "#ffffff",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg, #ffffff))",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "6px",
  fontSize: "14px",
  color: "inherit",
};

function GroupConvertDialog({
  tenantId,
  group,
  onClose,
  onConverted,
}: {
  readonly tenantId: string;
  readonly group: GroupItem;
  readonly onClose: () => void;
  readonly onConverted: () => void;
}): React.ReactElement {
  const defaultTarget: GroupType = group.type === "m365" ? "security" : "m365";
  const [targetType, setTargetType] = useState<GroupType>(defaultTarget);
  const [dynamicRule, setDynamicRule] = useState(group.dynamicRule || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ diff?: readonly string[] } | null>(null);
  const [converted, setConverted] = useState(false);

  const ruleCheck = targetType === "dynamic" ? validateDynamicRule(dynamicRule) : { valid: true };
  const canSubmit = targetType !== group.type && ruleCheck.valid && !loading;

  const buildPayload = (preview: boolean) => ({
    targetType,
    ...(targetType === "dynamic" ? { dynamicRule } : {}),
    preview,
  });

  const handlePreview = async () => {
    if (targetType === "dynamic" && !ruleCheck.valid) {
      setError(ruleCheck.error ?? "Invalid dynamic rule");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await convertGroup(tenantId, group.id, buildPayload(true));
      setPlan((res as { plan?: { diff?: readonly string[] } }).plan ?? (res as { diff?: readonly string[] }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to preview conversion");
    } finally {
      setLoading(false);
    }
  };

  const handleConvert = async () => {
    if (targetType === "dynamic" && !ruleCheck.valid) {
      setError(ruleCheck.error ?? "Invalid dynamic rule");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await convertGroup(tenantId, group.id, buildPayload(false));
      if ((res as { success?: boolean }).success !== true) {
        throw new Error("The BFF did not confirm the group was converted");
      }
      setConverted(true);
      onConverted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to convert group");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={overlayStyle} data-testid="group-convert-overlay">
      <div
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-label="Convert group"
        data-testid="group-convert-dialog"
      >
        <div>
          <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>Convert group</h2>
          <div style={{ fontSize: "12px", color: "var(--text-muted, #6b7280)", marginTop: "4px" }}>
            Target: <strong>{group.name}</strong> (current type: <code>{group.type}</code>)
          </div>
        </div>

        {converted ? (
          <>
            <div
              data-testid="group-convert-success"
              role="status"
              style={{
                padding: "12px",
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: "6px",
                color: "#166534",
                fontSize: "13px",
                fontWeight: 600,
              }}
            >
              Group &quot;{group.name}&quot; was converted to {targetType}.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" style={btnStyle} onClick={onClose} data-testid="group-convert-done">
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label htmlFor="group-convert-target-type" style={{ fontSize: "13px", fontWeight: 600 }}>
                Target Group Type
              </label>
              <select
                id="group-convert-target-type"
                value={targetType}
                onChange={(e) => {
                  setTargetType(e.target.value as GroupType);
                  setPlan(null);
                  setError(null);
                }}
                style={inputStyle}
                data-testid="group-convert-target-type"
              >
                {CONVERT_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {targetType === "dynamic" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <label htmlFor="group-convert-dynamic-rule" style={{ fontSize: "13px", fontWeight: 600 }}>
                  Dynamic Membership Rule
                </label>
                <textarea
                  id="group-convert-dynamic-rule"
                  value={dynamicRule}
                  onChange={(e) => {
                    setDynamicRule(e.target.value);
                    setPlan(null);
                    setError(null);
                  }}
                  rows={3}
                  placeholder='(user.department -eq "Finance")'
                  style={{ ...inputStyle, fontFamily: "monospace", fontSize: "13px" }}
                  data-testid="group-convert-dynamic-rule"
                />
                {dynamicRule && !ruleCheck.valid && (
                  <div style={{ fontSize: "12px", color: "#991b1b" }} data-testid="group-convert-rule-error">
                    {ruleCheck.error}
                  </div>
                )}
              </div>
            )}

            {plan && (
              <div data-testid="group-convert-plan" style={{ fontSize: "13px" }}>
                <div style={{ fontWeight: 600 }}>Preview plan (dry run)</div>
                {plan.diff && plan.diff.length > 0 ? (
                  <ul style={{ margin: 0, paddingLeft: "18px" }}>
                    {plan.diff.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <div>No changes reported.</div>
                )}
              </div>
            )}

            {error && (
              <div
                role="alert"
                data-testid="group-convert-error"
                style={{
                  padding: "10px 12px",
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  borderRadius: "6px",
                  color: "#991b1b",
                  fontSize: "13px",
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <button type="button" style={btnStyle} onClick={onClose} disabled={loading} data-testid="group-convert-cancel">
                Cancel
              </button>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  style={btnStyle}
                  onClick={handlePreview}
                  disabled={loading || targetType === group.type}
                  data-testid="group-convert-preview"
                >
                  Preview
                </button>
                <button
                  type="button"
                  style={{ ...primaryBtnStyle, opacity: canSubmit ? 1 : 0.5 }}
                  onClick={handleConvert}
                  disabled={!canSubmit}
                  data-testid="group-convert-submit"
                >
                  {loading ? "Converting..." : "Convert group"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function GroupsView({ tenantId }: { readonly tenantId: string }): React.ReactElement {
  const router = useRouter();

  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<GroupDialog>(null);
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
      case "convert":
        setDialog({ kind: action, group });
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
          initialGrantSendOnBehalfTo={dialog.group.grantSendOnBehalfTo ?? []}
          onClose={() => setDialog(null)}
          onSuccess={reload}
        />
      )}

      {dialog?.kind === "convert" && (
        <GroupConvertDialog
          tenantId={tenantId}
          group={dialog.group}
          onClose={() => setDialog(null)}
          onConverted={reload}
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
