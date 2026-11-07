// EPIC-028 Incidents & Alerts providers (T-0858).
//
// The route factories were written against provider seams but never mounted, and no
// adapter bound them to the PowerShell workers. This module does that:
//
//   incidents      get-incidents.ps1        (flat job fields, createTenantWorker)
//   detail         get-incident-detail.ps1  (portal notes + state changes merged in)
//   actions        invoke-incident-action.ps1 (T-0007 envelope worker)
//   alerts         get-alerts.ps1           (flat job fields)
//   alertActions   invoke-alert-action.ps1  (T-0007 envelope worker)
//   checkAlerts    the latest finished run's non-passing findings, module-wide
//
// The BFF never calls Graph: every read/write goes through a worker, and the
// triage store is the shared SQLite repository (migration 0055).
import type { Finding, SqliteRepository } from "@m365-assess/db";
import { AppError } from "../errors.js";
import { MAX_PAGE_LIMIT } from "../pagination.js";
import type {
  AlertActionProvider,
  AlertsProvider,
  ProviderAlert,
  ProviderAlertActionResult,
  ProviderAlertsPage,
} from "../routes/alerts.js";
import type {
  CheckAlert,
  CheckAlertSeverity,
  CheckAlertStatus,
  CheckAlertsFilter,
  CheckAlertsPage,
  CheckAlertsProvider,
} from "../routes/check-alerts.js";
import type {
  IncidentActionProvider,
  ProviderIncidentActionResult,
} from "../routes/incidents-actions.js";
import {
  isIncidentWorkerError,
  type IncidentDetailProvider,
  type IncidentDetailResult,
} from "../routes/incidents-detail.js";
import type { IncidentItem, IncidentsPage, IncidentsProvider } from "../routes/incidents.js";
import { CHECK_ALERT_STATUSES, CHECK_ALERT_SEVERITIES } from "../routes/check-alerts.js";
import type { TenantStore } from "../routes/tenants.js";
import {
  createEnvelopeWorker,
  createTenantWorker,
  type WorkerRunner,
} from "./workers.js";
import type { CredentialStoreRow } from "../routes/credentials.js";

export interface IncidentDetailReadStore {
  listIncidentNotes(
    tenantId: string,
    incidentId: string,
  ): Promise<ReadonlyArray<{ id: string; incidentId: string; body: string; author: string | null; at: string }>>;
  listAlertStateChanges(
    tenantId: string,
    options: { incidentId?: string },
  ): Promise<
    ReadonlyArray<{
      id: string;
      alertId: string | null;
      incidentId: string | null;
      from: string;
      to: string;
      by: string | null;
      at: string;
      reason: string | null;
    }>
  >;
}

export interface IncidentProviders {
  readonly incidents: IncidentsProvider;
  readonly detail: IncidentDetailProvider;
  readonly actions: IncidentActionProvider;
  readonly alerts: AlertsProvider;
  readonly alertActions: AlertActionProvider;
}

interface WorkerPage<T> {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

function asPage<T>(value: unknown, tenantId: string): WorkerPage<T> {
  const record = (value ?? {}) as Record<string, unknown>;
  const items = Array.isArray(record["items"]) ? (record["items"] as T[]) : [];
  return {
    tenantId: typeof record["tenantId"] === "string" ? record["tenantId"] : tenantId,
    totalCount: typeof record["totalCount"] === "number" ? record["totalCount"] : items.length,
    items,
    nextCursor: typeof record["nextCursor"] === "string" ? record["nextCursor"] : null,
  };
}

/** Worker filters are flat and lowercase, one key per route filter. */
function flatFilter(entries: ReadonlyArray<[string, string | undefined]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (value !== undefined && value.length > 0) out[key] = value;
  }
  return out;
}

export function createIncidentProviders(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
  repo: IncidentDetailReadStore,
): IncidentProviders {
  const call = createTenantWorker(run, credentials);
  const envelope = createEnvelopeWorker(run, credentials);

  return {
    incidents: {
      async listIncidents(tenantId, filter): Promise<IncidentsPage> {
        const page = await call<unknown>("get-incidents.ps1", tenantId, {
          ...flatFilter([
            ["severity", filter.severity],
            ["status", filter.status],
            ["classification", filter.classification],
            ["assigned", filter.assigned],
            ["from", filter.from],
            ["to", filter.to],
          ]),
          top: filter.limit,
          ...(filter.cursor ? { cursor: filter.cursor } : {}),
        });
        return asPage<IncidentItem>(page, tenantId);
      },
    },

    detail: {
      async getIncident(tenantId, incidentId) {
        const [notes, changes] = await Promise.all([
          repo.listIncidentNotes(tenantId, incidentId),
          repo.listAlertStateChanges(tenantId, { incidentId }),
        ]);
        const result = await call<unknown>("get-incident-detail.ps1", tenantId, {
          incidentId,
          portalNotes: notes.map((note) => ({
            id: note.id,
            incidentId: note.incidentId,
            body: note.body,
            author: note.author ?? "",
            at: note.at,
          })),
          stateChanges: changes.map((change) => ({
            id: change.id,
            alertId: change.alertId,
            incidentId: change.incidentId,
            from: change.from,
            to: change.to,
            by: change.by,
            at: change.at,
            reason: change.reason,
          })),
        });
        if (isIncidentWorkerError(result)) return result;
        return result as IncidentDetailResult;
      },
    },

    actions: {
      executeAction(tenantId, incidentId, action, options): Promise<ProviderIncidentActionResult> {
        return envelope<ProviderIncidentActionResult>("invoke-incident-action.ps1", tenantId, {
          incidentId,
          action,
          value: options.value,
          comment: options.comment,
          reason: options.reason,
          dryRun: false,
          // The route gates bulk and resolve before it calls the provider, so the
          // worker always receives an explicit confirmation for a real write.
          confirm: true,
        });
      },
    },

    alerts: {
      async listAlerts(tenantId, filter): Promise<ProviderAlertsPage> {
        const page = await call<unknown>("get-alerts.ps1", tenantId, {
          ...flatFilter([
            ["source", filter.source],
            ["severity", filter.severity],
            ["status", filter.status],
          ]),
          top: filter.limit,
          ...(filter.cursor ? { cursor: filter.cursor } : {}),
        });
        return asPage<ProviderAlert>(page, tenantId);
      },
    },

    alertActions: {
      async executeAction(tenantId, alertId, action, options): Promise<ProviderAlertActionResult> {
        try {
          return await envelope<ProviderAlertActionResult>("invoke-alert-action.ps1", tenantId, {
            alertId,
            action,
            value: options.value,
            comment: options.comment,
            reason: options.reason,
            dryRun: false,
            confirm: true,
          });
        } catch (error) {
          // The worker throws alerts.unsupported_action for create-incident on a
          // source that cannot promote; the route expects that as a value so it can
          // answer 400 instead of a 502.
          if (error instanceof AppError && /alerts\.unsupported_action/.test(error.message)) {
            return {
              status: "unsupported",
              writeBack: false,
              from: "",
              to: "",
              before: null,
              after: null,
              note: null,
              error: error.message,
            };
          }
          throw error;
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Check alerts (module findings)
// ---------------------------------------------------------------------------

export interface CheckAlertsProviderOptions {
  readonly tenants: Pick<TenantStore, "listTenants">;
  readonly findings: Pick<SqliteRepository, "listRuns" | "listFindings">;
}

const SEVERITY_RANK: Readonly<Record<string, number>> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Info: 4,
};

function latestFinishedRunId(
  runs: ReadonlyArray<{ readonly id: string; readonly status: string; readonly finishedAt: string | null; readonly trigger: string }>,
): string | null {
  return (
    runs
      .filter((run) => (run.status === "succeeded" || run.status === "partial") && run.trigger !== "parent")
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0]?.id ?? null
  );
}

function asCheckAlert(finding: Finding): CheckAlert | undefined {
  if (!(CHECK_ALERT_STATUSES as readonly string[]).includes(finding.status)) return undefined;
  const severity = (CHECK_ALERT_SEVERITIES as readonly string[]).includes(finding.severity ?? "")
    ? (finding.severity as CheckAlertSeverity)
    : "Info";
  return {
    id: finding.id,
    checkId: finding.checkId,
    title: finding.controlName?.trim() || finding.checkId,
    category: finding.category,
    severity,
    status: finding.status as CheckAlertStatus,
    entity: finding.collector,
    created: finding.createdAt,
    remediation: null,
  };
}

/**
 * `/v1/check-alerts` reads the module's own findings: every included tenant's latest
 * finished run, filtered to the non-passing statuses. The surface is module-wide
 * (SPEC §6), so it is not tenant-scoped, and it never writes.
 */
export function createCheckAlertsProvider(options: CheckAlertsProviderOptions): CheckAlertsProvider {
  return {
    async listCheckAlerts(filter: CheckAlertsFilter): Promise<CheckAlertsPage> {
      const tenants = await options.tenants.listTenants();
      const items: CheckAlert[] = [];
      for (const tenant of tenants) {
        if (tenant.excluded || tenant.status === "excluded") continue;
        const runId = latestFinishedRunId(await options.findings.listRuns(tenant.id));
        if (runId === null) continue;
        for (const finding of await options.findings.listFindings(tenant.id, runId)) {
          const alert = asCheckAlert(finding);
          if (alert === undefined) continue;
          if (filter.status !== undefined && alert.status !== filter.status) continue;
          if (filter.severity !== undefined && alert.severity !== filter.severity) continue;
          items.push(alert);
        }
      }
      items.sort((a, b) => {
        const bySeverity = (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99);
        return bySeverity !== 0 ? bySeverity : b.created.localeCompare(a.created);
      });
      const start = decodeCursorOffset(filter.cursor);
      const page = items.slice(start, start + Math.min(filter.limit, MAX_PAGE_LIMIT));
      const nextOffset = start + page.length;
      return {
        totalCount: items.length,
        items: page,
        nextCursor: nextOffset < items.length ? encodeCursorOffset(nextOffset) : null,
      };
    },
  };
}

function decodeCursorOffset(cursor: string | null): number {
  if (cursor === null || cursor.length === 0) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function encodeCursorOffset(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}
