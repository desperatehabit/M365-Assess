"use client";

// Incident detail route (EPIC-028 SPEC.md §2 US-2/US-3, §3.2; T-0547).
// Loads the incident from the T-0545 detail API, renders the header triage
// actions (TriagePanel) and the five §3.2 tabs (IncidentTabs), and drives the
// T-0546 actions API for assign/status/classify/comment, refreshing the view
// after each change. Strictly uses report theme tokens with zero colour literals.

import React, { use, useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import {
  BulkTriageDialog,
  type BulkTriageAction,
  type BulkTriagePayload,
} from "../../../components/incidents/BulkTriageDialog";
import {
  IncidentTabs,
  IncidentSeverityBadge,
  type IncidentDetailData,
  type IncidentTabId,
} from "../../../components/incidents/IncidentTabs";
import {
  TriagePanel,
  type IncidentTriageAction,
  type TriagePayload,
} from "../../../components/incidents/TriagePanel";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

export type IncidentFetcher = typeof fetch;

export interface IncidentActionResponse {
  readonly tenantId: string;
  readonly action: IncidentTriageAction;
  readonly rows: readonly unknown[];
  readonly summary: Record<string, number>;
}

/** One incident in a bulk selection, paired with the tenant that owns it. */
export interface BulkIncidentTarget {
  readonly tenantId: string;
  readonly incidentId: string;
}

/**
 * Parses the `bulk` query parameter the list page builds: comma-separated
 * `tenantId::incidentId` pairs, each component URI-encoded once. A bare id (an older
 * link) is ignored because the action endpoint is tenant-scoped.
 */
export function parseBulkTargets(raw: string | null): BulkIncidentTarget[] {
  if (raw === null || raw.length === 0) return [];
  const targets: BulkIncidentTarget[] = [];
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf("::");
    if (separator <= 0) continue;
    const tenantId = decodeURIComponent(entry.slice(0, separator));
    const incidentId = decodeURIComponent(entry.slice(separator + 2));
    if (tenantId.length > 0 && incidentId.length > 0) targets.push({ tenantId, incidentId });
  }
  return targets;
}

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1400px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

const headerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  paddingBottom: "16px",
  borderBottom: "1px solid var(--border)",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const metaStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "16px",
  alignItems: "center",
  fontSize: "13px",
  color: "var(--text-soft)",
};

const backLinkStyle: CSSProperties = {
  color: "var(--accent-text)",
  textDecoration: "none",
  fontSize: "14px",
  fontWeight: 500,
};

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

export async function fetchIncidentDetail(
  tenantId: string,
  incidentId: string,
  fetcher: IncidentFetcher = fetch,
): Promise<IncidentDetailData> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/incidents/${encodeURIComponent(incidentId)}`,
  );
  if (!response.ok) throw await readError(response, "Load incident detail");
  return (await response.json()) as IncidentDetailData;
}

export async function submitIncidentAction(
  tenantId: string,
  incidentId: string,
  action: IncidentTriageAction,
  payload: TriagePayload,
  fetcher: IncidentFetcher = fetch,
  options: { readonly incidentIds?: readonly string[] } = {},
): Promise<IncidentActionResponse> {
  const extraIds = options.incidentIds ?? [];
  const body: Record<string, unknown> = {
    value: payload.value,
    comment: payload.comment,
    reason: payload.reason,
  };
  if (extraIds.length > 0) {
    body.incidentIds = [...extraIds];
    // A change across more than one incident is bulk and must be confirmed.
    body.confirm = true;
  }
  // The T-0546 API refuses a status change to resolved without explicit
  // confirmation, so a single-incident resolve carries it here.
  if (action === "status" && payload.value.trim().toLowerCase() === "resolved") {
    body.confirm = true;
  }
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/incidents/${encodeURIComponent(incidentId)}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw await readError(response, `Apply incident ${action}`);
  return (await response.json()) as IncidentActionResponse;
}

export interface IncidentDetailViewProps {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly fetcher?: IncidentFetcher;
  /** Present when the list page handed off a bulk selection. */
  readonly bulk?: {
    readonly action: BulkTriageAction;
    readonly targets: readonly BulkIncidentTarget[];
  };
}

export function IncidentDetailView({
  tenantId,
  incidentId,
  fetcher = fetch,
  bulk,
}: IncidentDetailViewProps): ReactElement {
  const [detail, setDetail] = useState<IncidentDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<IncidentTabId>("overview");
  const [bulkOpen, setBulkOpen] = useState(bulk !== undefined);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await fetchIncidentDetail(tenantId, incidentId, fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, incidentId, fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleTriage = useCallback(
    async (action: IncidentTriageAction, payload: TriagePayload): Promise<void> => {
      setBusy(true);
      setActionError(null);
      try {
        await submitIncidentAction(tenantId, incidentId, action, payload, fetcher);
        await load();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [tenantId, incidentId, fetcher, load],
  );

  const handleBulkConfirm = useCallback(
    async (payload: BulkTriagePayload): Promise<void> => {
      if (bulk === undefined) return;
      setBulkBusy(true);
      setBulkError(null);
      try {
        // The action endpoint is tenant-scoped, so a cross-tenant selection is split
        // into one request per tenant with the first incident as the path target.
        const byTenant = new Map<string, string[]>();
        for (const target of bulk.targets) {
          const ids = byTenant.get(target.tenantId) ?? [];
          ids.push(target.incidentId);
          byTenant.set(target.tenantId, ids);
        }
        for (const [bulkTenant, ids] of byTenant) {
          const [first, ...rest] = ids;
          if (first === undefined) continue;
          await submitIncidentAction(
            bulkTenant,
            first,
            bulk.action,
            { value: payload.value, comment: "", reason: payload.reason },
            fetcher,
            { incidentIds: rest },
          );
        }
        setBulkOpen(false);
        await load();
      } catch (err) {
        setBulkError(err instanceof Error ? err.message : String(err));
      } finally {
        setBulkBusy(false);
      }
    },
    [bulk, fetcher, load],
  );

  if (loading) {
    return (
      <div style={pageStyle} data-testid="incident-detail-loading">
        <a href="/incidents" style={backLinkStyle}>
          ← Incidents
        </a>
        <div style={{ padding: "48px 0", textAlign: "center", color: "var(--muted)" }}>
          Loading incident…
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div style={pageStyle} data-testid="incident-detail-error">
        <a href="/incidents" style={backLinkStyle}>
          ← Incidents
        </a>
        <div
          role="alert"
          style={{
            padding: "24px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius, 8px)",
            color: "var(--danger-text)",
          }}
        >
          {error ?? "Incident not found"}
        </div>
      </div>
    );
  }

  const { overview } = detail;

  return (
    <div style={pageStyle} data-testid="incident-detail-page">
      <a href="/incidents" style={backLinkStyle} data-testid="back-to-incidents-link">
        ← Incidents
      </a>

      <header style={headerStyle}>
        <h1 style={titleStyle} data-testid="incident-detail-title">
          {overview.title || overview.incidentId}
        </h1>
        <div style={metaStyle}>
          <IncidentSeverityBadge severity={overview.severity} testId="incident-detail-severity" />
          <span data-testid="incident-detail-status">{overview.status}</span>
          <span data-testid="incident-detail-classification">{overview.classification || "—"}</span>
          <span data-testid="incident-detail-assignee">{overview.assignee || "Unassigned"}</span>
        </div>
        <TriagePanel
          incidentId={incidentId}
          status={overview.status}
          classification={overview.classification}
          assignee={overview.assignee}
          busy={busy}
          error={actionError}
          onSubmit={handleTriage}
        />
      </header>

      <IncidentTabs detail={detail} activeTab={tab} onTabChange={setTab} />

      {bulk !== undefined && (
        <BulkTriageDialog
          open={bulkOpen}
          action={bulk.action}
          incidentIds={bulk.targets.map((target) => target.incidentId)}
          busy={bulkBusy}
          error={bulkError}
          onConfirm={handleBulkConfirm}
          onClose={() => setBulkOpen(false)}
        />
      )}
    </div>
  );
}

export interface IncidentDetailPageProps {
  readonly params: Promise<{ incidentId: string }> | { incidentId: string };
}

export default function IncidentDetailPage(props: IncidentDetailPageProps): ReactElement {
  const resolvedParams =
    typeof (props.params as Promise<{ incidentId: string }>).then === "function"
      ? use(props.params as Promise<{ incidentId: string }>)
      : (props.params as { incidentId: string });

  const incidentId = decodeURIComponent(resolvedParams.incidentId);
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  const targets = parseBulkTargets(searchParams.get("bulk"));
  const actionParam = searchParams.get("action");
  const bulkAction: BulkTriageAction | undefined =
    actionParam === "assign" || actionParam === "status" ? actionParam : undefined;

  return (
    <RequireTenant tenantId={tenantId}>
      <IncidentDetailView
        tenantId={tenantId}
        incidentId={incidentId}
        bulk={
          bulkAction !== undefined && targets.length > 0
            ? { action: bulkAction, targets }
            : undefined
        }
      />
    </RequireTenant>
  );
}
