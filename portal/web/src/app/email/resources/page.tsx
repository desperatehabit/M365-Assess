"use client";

// Resources page (EPIC-023 SPEC.md §3.3, §4.3; T-0449).
// Nav: Email & Exchange → Administration → Resource Management. Tabs: Rooms,
// Equipment, Room Lists. Table: Name · Capacity · Location · Type · Hidden.
// Row actions: View, Edit, Add to room list, Delete. Room lists show
// membership. Every write goes through the BFF with plan preview and
// confirmation on delete. Write controls are disabled unless `canWrite` (RBAC)
// is set.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import {
  ResourceTable,
  type ResourceItem,
  type ResourceKind,
  type ResourceRowAction,
} from "../../../components/resources/ResourceTable";

export interface ResourceFilter {
  readonly search?: string;
}

export interface ResourcePlan {
  readonly action: string;
  readonly targetName?: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export type Fetcher = typeof fetch;

const RESOURCE_KINDS: readonly { readonly kind: ResourceKind; readonly label: string }[] = [
  { kind: "rooms", label: "Rooms" },
  { kind: "equipment", label: "Equipment" },
  { kind: "roomlists", label: "Room Lists" },
];

function buildResourcesQuery(filter: ResourceFilter, limit = 100): string {
  const params = new URLSearchParams();
  if (filter.search) params.set("search", filter.search);
  params.set("limit", String(limit));
  return `?${params.toString()}`;
}

async function readError(response: Response, fallback: string): Promise<Error> {
  let detail = fallback;
  try {
    const body = (await response.json()) as { message?: string };
    if (body?.message) detail = body.message;
  } catch {
    detail = `${fallback}: HTTP ${response.status}`;
  }
  return new Error(detail);
}

export async function listResources(
  tenantId: string,
  kind: ResourceKind,
  filter: ResourceFilter,
  fetcher: Fetcher = fetch,
): Promise<{ items: ResourceItem[]; nextCursor: string | null }> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${kind}${buildResourcesQuery(filter)}`,
  );
  if (!response.ok) throw await readError(response, "List resources");
  const body = (await response.json()) as { items?: ResourceItem[]; nextCursor?: string | null };
  return { items: [...(body.items ?? [])], nextCursor: body.nextCursor ?? null };
}

export async function previewResourceWrite(
  tenantId: string,
  kind: ResourceKind,
  resourceId: string,
  action: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<ResourcePlan> {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${kind}`;
  const path = resourceId ? `${base}/${encodeURIComponent(resourceId)}` : base;
  const method = resourceId ? "PATCH" : "POST";
  const response = await fetcher(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw await readError(response, `Preview ${action}`);
  return (await response.json()) as ResourcePlan;
}

export async function applyResourceWrite(
  tenantId: string,
  kind: ResourceKind,
  resourceId: string,
  action: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${kind}`;
  const path = resourceId ? `${base}/${encodeURIComponent(resourceId)}` : base;
  const method = resourceId ? "PATCH" : "POST";
  const response = await fetcher(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false, confirm: true }),
  });
  if (!response.ok) throw await readError(response, `Apply ${action}`);
  return response.json();
}

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1400px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

const tabStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const activeTabStyle: CSSProperties = {
  ...tabStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, rgba(0,0,0,0.5))",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "560px",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

interface PendingWrite {
  readonly action: string;
  readonly label: string;
  readonly resource: ResourceItem | null;
  readonly payload: Record<string, unknown>;
}

export interface ResourcesViewProps {
  readonly tenantId: string;
  /** False hides write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

export function ResourcesView({ tenantId, canWrite = true, fetcher = fetch }: ResourcesViewProps): ReactElement {
  const [kind, setKind] = useState<ResourceKind>("rooms");
  const [filter, setFilter] = useState<ResourceFilter>({});
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [plan, setPlan] = useState<ResourcePlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const fetchList = useCallback(
    async (nextKind: ResourceKind, nextFilter: ResourceFilter): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const page = await listResources(tenantId, nextKind, nextFilter, fetcher);
        setItems(page.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [tenantId, fetcher],
  );

  useEffect(() => {
    void fetchList(kind, filter);
  }, [kind, filter, fetchList]);

  async function openWriteDialog(action: string, label: string, resource: ResourceItem | null, payload: Record<string, unknown>): Promise<void> {
    setPending({ action, label, resource, payload });
    setPlan(null);
    setPlanError(null);
    setPlanBusy(true);
    try {
      const resourceId = resource?.id ?? "";
      setPlan(await previewResourceWrite(tenantId, kind, resourceId, action, payload, fetcher));
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmPending(): Promise<void> {
    if (!pending) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      const resourceId = pending.resource?.id ?? "";
      await applyResourceWrite(tenantId, kind, resourceId, pending.action, pending.payload, fetcher);
      setNotice(`${pending.label} applied.`);
      setPending(null);
      setPlan(null);
      await fetchList(kind, filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function rowAction(action: ResourceRowAction, resource: ResourceItem): void {
    if (action === "view") {
      setNotice(`Viewing ${resource.name ?? resource.id} (${resource.primarySmtpAddress}).`);
      return;
    }
    if (action === "edit") {
      void openWriteDialog("edit", "Edit resource", resource, {
        displayName: resource.name ?? "",
        capacity: resource.capacity,
        location: resource.location,
        hidden: resource.hidden,
      });
      return;
    }
    if (action === "addMember") {
      void openWriteDialog("addMember", "Add to room list", resource, {
        action: "addMember",
        memberId: resource.id,
      });
      return;
    }
    if (action === "removeMember") {
      void openWriteDialog("removeMember", "Remove from room list", resource, {
        action: "removeMember",
        memberId: resource.id,
      });
      return;
    }
    if (action === "delete") {
      void openWriteDialog("delete", "Delete resource", resource, { confirm: true });
      return;
    }
  }

  function addResource(): void {
    void openWriteDialog("create", "Create resource", null, {
      displayName: "",
      capacity: null,
      location: null,
      hidden: false,
    });
  }

  const writeDisabled = !canWrite;

  return (
    <div style={pageStyle} data-testid="resources-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Administration &gt; Resource Management</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Resources
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Manage rooms, equipment, and room lists. Writes preview a plan before apply.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }} data-testid="resource-tabs">
        {RESOURCE_KINDS.map(({ kind: k, label }) => (
          <button
            key={k}
            type="button"
            style={kind === k ? activeTabStyle : tabStyle}
            onClick={() => setKind(k)}
            data-testid={`resource-tab-${k}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }} data-testid="resource-filters">
        <input
          type="text"
          placeholder="Search name or address..."
          value={filter.search ?? ""}
          onChange={(e) => setFilter({ search: e.target.value || undefined })}
          style={inputStyle}
          aria-label="Search resources"
          data-testid="resource-search"
        />
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="resource-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="resource-error">
          {error}
        </div>
      )}

      <ResourceTable
        resources={items}
        loading={loading}
        error={error}
        kind={kind}
        canWrite={canWrite}
        onAddResource={addResource}
        onAction={rowAction}
      />

      {pending && (
        <div style={overlayStyle} data-testid="resource-action-dialog" role="dialog" aria-modal="true" aria-label={pending.label}>
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{pending.label}{pending.resource ? ` — ${pending.resource.name ?? pending.resource.id}` : ""}</h3>
            <div data-testid="resource-plan-preview">
              {planBusy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
              {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
              {plan && (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "14px" }}>
                  <div data-testid="resource-plan-diff">
                    {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
                  </div>
                  {plan.requiresConfirmation && <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPending(null); setPlan(null); }} data-testid="resource-dialog-cancel">Cancel</button>
              <button
                type="button"
                style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }}
                disabled={planBusy || !plan || !plan.valid}
                onClick={() => void confirmPending()}
                data-testid="resource-dialog-confirm"
              >
                Confirm and apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ResourcesPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <ResourcesView tenantId={tenantId} />
    </RequireTenant>
  );
}
