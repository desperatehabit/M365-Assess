// EPIC-032 Audit Logs & Webhooks worker-backed providers (T-0862).
//
// The route factories were written against provider seams but never mounted, and
// no adapter bound them to the PowerShell workers, so every §6 endpoint 404'd.
// This module does that:
//
//   search            search-audit.ps1           (T-0007 envelope: action search)
//   directory         search-audit.ps1           (T-0007 envelope: action directory)
//   saved-search run  search-audit.ps1           (re-dispatches the saved filter)
//   coverage          get-audit-coverage.ps1     (flat job: lastSearchAt/finding)
//   webhooks          manage-webhooks.ps1        (flat job: action + subscription fields)
//
// Every call signs in through the tenant credential block (createTenantWorker) so
// the BFF never calls Graph or Purview itself. Audit records stay ephemeral; the
// only persistence is the audit event the search route writes and the webhook
// subscription rows the adapter mirrors into the repository.
import { randomUUID } from "node:crypto";
import type { AuditRepository } from "@m365-assess/db";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  AuditDirectoryInput,
  AuditDirectoryRun,
  AuditSearchInput,
  AuditSearchProvider as AuditSearchRouteProvider,
  AuditSearchRun,
} from "../routes/audit-search.js";
import type {
  AuditCoverageJobInput,
  AuditCoverageProvider,
  AuditCoverageWorkerReport,
} from "../routes/audit-coverage.js";
import type {
  AuditSearchJob,
  AuditSearchProvider as SavedAuditSearchProvider,
} from "../routes/audit-searches.js";
import type {
  WebhookAlertEvent,
  WebhookAuditEvent,
  WebhookDeleteResult,
  WebhookListResult,
  WebhookMutationResult,
  WebhookSubscription,
  WebhookSubscriptionState,
  WebhooksProvider,
  WebhookTestResult,
} from "../routes/webhooks.js";
import {
  asArray,
  createTenantWorker,
  raiseWorkerError,
  type WorkerRunner,
} from "./workers.js";

export const SEARCH_AUDIT_WORKER = "search-audit.ps1";
export const AUDIT_COVERAGE_WORKER = "get-audit-coverage.ps1";
export const MANAGE_WEBHOOKS_WORKER = "manage-webhooks.ps1";

export interface AuditProviders {
  /** The manual search + directory routes' provider. */
  readonly search: AuditSearchRouteProvider;
  /** The saved-search Run action's provider. */
  readonly savedSearch: SavedAuditSearchProvider;
  readonly coverage: AuditCoverageProvider;
  readonly webhooks: WebhooksProvider;
}

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asState(value: unknown): WebhookSubscriptionState {
  return value === "expiring" || value === "expired" ? value : "active";
}

function asAuditEvent(value: unknown): WebhookAuditEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Row;
  const id = asString(row["id"]);
  if (id.length === 0) return undefined;
  return {
    id,
    tenantId: asString(row["tenantId"]),
    action: asString(row["action"]),
    targetId: asString(row["targetId"]),
    targetName: asString(row["targetName"]),
    timestamp: asString(row["timestamp"]),
    ...(typeof row["note"] === "string" ? { note: row["note"] } : {}),
  };
}

function asAlertEvent(value: unknown): WebhookAlertEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Row;
  const kind = asString(row["kind"]);
  if (kind.length === 0) return undefined;
  return {
    kind,
    severity: asString(row["severity"]),
    tenantId: asString(row["tenantId"]),
    subscriptionId: asString(row["subscriptionId"]),
    resource: asString(row["resource"]),
    reason: asString(row["reason"]),
    timestamp: asString(row["timestamp"]),
  };
}

/** Maps the worker's subscription payload onto the route's Graph-shaped record. */
export function mapWebhookSubscription(value: unknown, tenantId: string): WebhookSubscription {
  const row = asRecord(value);
  const notificationUrl = asOptionalString(row["notificationUrl"]);
  const clientState = asOptionalString(row["clientState"]);
  return {
    id: asString(row["id"]),
    tenantId: asString(row["tenantId"], tenantId),
    resource: asString(row["resource"]),
    ...(notificationUrl !== undefined ? { notificationUrl } : {}),
    ...(clientState !== undefined ? { clientState } : {}),
    expirationDateTime: asString(row["expirationDateTime"]),
    state: asState(row["state"]),
  };
}

function mapMutation(value: unknown, tenantId: string): WebhookMutationResult {
  const row = asRecord(value);
  const subscription = row["subscription"];
  const alertEvent = asAlertEvent(row["alertEvent"]);
  const auditEvent = asAuditEvent(row["auditEvent"]);
  return {
    success: row["success"] !== false,
    ...(subscription !== undefined ? { subscription: mapWebhookSubscription(subscription, tenantId) } : {}),
    ...(asOptionalString(row["error"]) !== undefined ? { error: asString(row["error"]) } : {}),
    ...(alertEvent !== undefined ? { alertEvent } : {}),
    ...(auditEvent !== undefined ? { auditEvent } : {}),
  };
}

function mapSearchRun(value: unknown, tenantId: string): AuditSearchRun {
  const row = asRecord(value);
  return {
    searchId: asString(row["searchId"], randomUUID()),
    tenantId: asString(row["tenantId"], tenantId),
    workloads: asArray(row["workloads"]).map((entry) => String(entry)),
    totalCount: asNumber(row["totalCount"], asArray(row["results"]).length),
    results: asArray(row["results"]) as AuditSearchRun["results"],
  };
}

function mapDirectoryRun(value: unknown, tenantId: string): AuditDirectoryRun {
  const row = asRecord(value);
  return {
    tenantId: asString(row["tenantId"], tenantId),
    category: asString(row["category"]),
    totalCount: asNumber(row["totalCount"], asArray(row["entries"]).length),
    entries: asArray(row["entries"]) as AuditDirectoryRun["entries"],
  };
}

function mapCoverage(value: unknown, tenantId: string): AuditCoverageWorkerReport {
  const row = asRecord(value);
  return {
    tenantId: asString(row["tenantId"], tenantId),
    auditEnabled: row["auditEnabled"] === true,
    lastSearchAt: typeof row["lastSearchAt"] === "string" ? row["lastSearchAt"] : null,
    gaps: asArray(row["gaps"]) as AuditCoverageWorkerReport["gaps"],
  };
}

/** Mirrors a Graph subscription into the portal repository for the webhook pages. */
async function mirrorSubscription(
  store: NonNullable<AuditProviderOptions["webhookStore"]>,
  tenantId: string,
  subscription: WebhookSubscription,
): Promise<void> {
  if (subscription.id.length === 0) return;
  const existing = await store.getWebhookSubscription(tenantId, subscription.id);
  if (existing === undefined) {
    await store.createWebhookSubscription({
      id: subscription.id,
      tenantId,
      resource: subscription.resource,
      expiresOn: subscription.expirationDateTime || null,
      state: subscription.state,
      notificationUrl: subscription.notificationUrl ?? "",
    });
    return;
  }
  await store.updateWebhookSubscription(tenantId, subscription.id, {
    resource: subscription.resource,
    expiresOn: subscription.expirationDateTime || null,
    state: subscription.state,
    notificationUrl: subscription.notificationUrl ?? "",
  });
}

export interface AuditProviderOptions {
  /** Mirrors subscription lifecycle results into the portal repository. */
  readonly webhookStore?: Pick<
    AuditRepository,
    | "getWebhookSubscription"
    | "createWebhookSubscription"
    | "updateWebhookSubscription"
    | "softDeleteWebhookSubscription"
  >;
  readonly now?: () => string;
  readonly newId?: () => string;
}

export function createAuditProviders(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
  options: AuditProviderOptions = {},
): AuditProviders {
  const call = createTenantWorker(run, credentials);
  const envelope = <T>(entrypoint: string, tenantId: string, payload: Row): Promise<T> =>
    call<T>(entrypoint, tenantId, {
      schemaVersion: "v1",
      correlationId: randomUUID(),
      payload,
    });
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => randomUUID());

  const search: AuditSearchRouteProvider = {
    async search(tenantId: string, input: AuditSearchInput): Promise<AuditSearchRun> {
      const result = await envelope<unknown>(SEARCH_AUDIT_WORKER, tenantId, {
        action: "search",
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
        ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
        ...(input.user !== undefined ? { user: input.user } : {}),
        ...(input.activity !== undefined ? { activity: input.activity } : {}),
        ...(input.ip !== undefined ? { ip: input.ip } : {}),
        ...(input.workloads !== undefined ? { workloads: [...input.workloads] } : {}),
        ...(input.top !== undefined ? { top: input.top } : {}),
      });
      raiseWorkerError(result);
      return mapSearchRun(result, tenantId);
    },

    async listDirectory(tenantId: string, input: AuditDirectoryInput): Promise<AuditDirectoryRun> {
      const result = await envelope<unknown>(SEARCH_AUDIT_WORKER, tenantId, {
        action: "directory",
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
        ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
        ...(input.top !== undefined ? { top: input.top } : {}),
      });
      raiseWorkerError(result);
      return mapDirectoryRun(result, tenantId);
    },
  };

  // A saved search's Run re-dispatches the same filter through the audit-search
  // worker. The worker runs synchronously; the returned job records the run so the
  // route can stamp lastRunAt and show the completed job.
  const savedSearch: SavedAuditSearchProvider = {
    async startSearch(tenantId, filters, createdBy): Promise<AuditSearchJob> {
      const result = await envelope<unknown>(SEARCH_AUDIT_WORKER, tenantId, {
        action: "search",
        ...filters,
      });
      raiseWorkerError(result);
      const row = asRecord(result);
      const instant = now();
      return {
        id: asString(row["searchId"], newId()),
        tenantId,
        state: "completed",
        ...(createdBy !== undefined ? { createdBy } : {}),
        createdAt: instant,
        updatedAt: instant,
      };
    },
  };

  const coverage: AuditCoverageProvider = {
    async getAuditCoverage(
      tenantId: string,
      input: AuditCoverageJobInput,
    ): Promise<AuditCoverageWorkerReport> {
      const result = await call<unknown>(AUDIT_COVERAGE_WORKER, tenantId, {
        lastSearchAt: input.lastSearchAt ?? "",
        ...(input.finding !== null ? { finding: input.finding } : {}),
      });
      raiseWorkerError(result);
      return mapCoverage(result, tenantId);
    },
  };

  const manage = (tenantId: string, fields: Row): Promise<unknown> =>
    call<unknown>(MANAGE_WEBHOOKS_WORKER, tenantId, fields);

  const webhooks: WebhooksProvider = {
    async list(tenantId: string): Promise<WebhookListResult> {
      const result = await manage(tenantId, { action: "list" });
      raiseWorkerError(result);
      const row = asRecord(result);
      const subscriptions = asArray(row["subscriptions"]).map((entry) =>
        mapWebhookSubscription(entry, tenantId),
      );
      if (options.webhookStore) {
        for (const subscription of subscriptions) {
          await mirrorSubscription(options.webhookStore, tenantId, subscription);
        }
      }
      return {
        success: row["success"] !== false,
        tenantId: asString(row["tenantId"], tenantId),
        subscriptions,
      };
    },

    async create(tenantId, input): Promise<WebhookMutationResult> {
      const result = await manage(tenantId, {
        action: "create",
        resource: input.resource,
        notificationUrl: input.notificationUrl,
      });
      raiseWorkerError(result);
      const mapped = mapMutation(result, tenantId);
      if (options.webhookStore && mapped.subscription) {
        await mirrorSubscription(options.webhookStore, tenantId, mapped.subscription);
      }
      return mapped;
    },

    async renew(tenantId, subscriptionId): Promise<WebhookMutationResult> {
      const result = await manage(tenantId, { action: "renew", subscriptionId });
      raiseWorkerError(result);
      const mapped = mapMutation(result, tenantId);
      if (options.webhookStore && mapped.subscription) {
        await mirrorSubscription(options.webhookStore, tenantId, mapped.subscription);
      }
      return mapped;
    },

    async recreate(tenantId, subscriptionId): Promise<WebhookMutationResult> {
      const result = await manage(tenantId, { action: "recreate", subscriptionId });
      raiseWorkerError(result);
      const mapped = mapMutation(result, tenantId);
      if (options.webhookStore && mapped.subscription) {
        await mirrorSubscription(options.webhookStore, tenantId, mapped.subscription);
      }
      return mapped;
    },

    async remove(tenantId, subscriptionId): Promise<WebhookDeleteResult> {
      const result = await manage(tenantId, { action: "delete", subscriptionId });
      raiseWorkerError(result);
      const row = asRecord(result);
      if (options.webhookStore) {
        await options.webhookStore.softDeleteWebhookSubscription(tenantId, subscriptionId);
      }
      const auditEvent = asAuditEvent(row["auditEvent"]);
      return {
        success: row["success"] !== false,
        deleted: asString(row["deleted"], subscriptionId),
        ...(auditEvent !== undefined ? { auditEvent } : {}),
      };
    },

    async test(tenantId, subscriptionId): Promise<WebhookTestResult> {
      const result = await manage(tenantId, { action: "test", subscriptionId });
      raiseWorkerError(result);
      const row = asRecord(result);
      return {
        success: row["success"] !== false,
        subscription: mapWebhookSubscription(row["subscription"], tenantId),
        healthy: row["healthy"] === true,
      };
    },
  };

  return { search, savedSearch, coverage, webhooks };
}
