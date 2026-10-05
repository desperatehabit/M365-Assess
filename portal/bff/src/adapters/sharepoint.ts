// EPIC-025 SharePoint & OneDrive worker-backed providers (T-0855).
//
// Each provider turns a route's typed call into a feature-worker job for the tenant
// (createTenantWorker adds the credential block and maps failures to 502s) and maps
// the worker's JSON onto the route's shape. The read workers (sites, browser,
// storage, OneDrive usage, version cleanup) read flat job fields; the write workers
// (create, bulk create, site action) read the T-0007 envelope, so their inputs travel
// under `payload` next to the schemaVersion marker. The workers own every Graph call;
// the BFF never sees tenant data or secrets.
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  OneDriveUsageProvider,
  OneDriveUsageReport,
} from "../routes/onedrive.js";
import type {
  SharePointBrowseProvider,
  SharePointSiteBrowser,
} from "../routes/sharepoint-browse.js";
import type {
  SharePointSiteAuditEvent,
  SharePointSiteLifecyclePlan,
  SharePointSiteLifecycleProvider,
  SharePointSiteOperationResult,
  SharePointRecycleBinActionResult,
  SharePointRecycleBinPage,
} from "../routes/sharepoint-site-lifecycle.js";
import type {
  SharePointSiteItem,
  SharePointSitesFilter,
  SharePointSitesPage,
  SharePointSitesProvider,
} from "../routes/sharepoint-sites.js";
import type {
  SharePointSitePlan,
  SharePointSiteResult,
  SharePointSitesBulkResult,
  SharePointSitesCreateProvider,
} from "../routes/sharepoint-sites-create.js";
import type {
  SharePointStorageProvider,
  SiteStorageComposition,
  VersionCleanupApply,
  VersionCleanupInput,
  VersionCleanupPlan,
} from "../routes/sharepoint-storage.js";
import { createTenantWorker, type WorkerRunner } from "./workers.js";

export interface SharePointProviders {
  readonly sites: SharePointSitesProvider;
  readonly sitesCreate: SharePointSitesCreateProvider;
  readonly lifecycle: SharePointSiteLifecycleProvider;
  readonly browse: SharePointBrowseProvider;
  readonly storage: SharePointStorageProvider;
  readonly onedrive: OneDriveUsageProvider;
}

/** new-sharepoint-site.ps1 answers one row per call; the route shapes the create result. */
interface SiteCreateOutput {
  readonly row?: number;
  readonly name: string;
  readonly alias: string;
  readonly type: string;
  readonly status: "planned" | "created" | "failed";
  readonly id: string | null;
  readonly error: string | null;
}

/** new-sharepoint-site-bulk.ps1 answers the bulk envelope with one row per site. */
interface SiteBulkOutput {
  readonly total: number;
  readonly created: number;
  readonly planned: number;
  readonly failed: number;
  readonly results: readonly SiteCreateOutput[];
}

/** invoke-sharepoint-site-action.ps1 answers a plan (dry run) or an applied result. */
interface SiteActionPlanOutput {
  readonly action: string;
  readonly siteId: string;
  readonly targetName: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

interface SiteActionAppliedOutput {
  readonly success: boolean;
  readonly state: string;
  readonly operation: string;
  readonly siteId: string;
  readonly targetName: string;
  readonly plan: SiteActionPlanOutput | null;
  readonly auditEvent: Record<string, unknown> | null;
}

type SiteActionOutput = SiteActionPlanOutput | SiteActionAppliedOutput;

interface RecycleBinActionOutput {
  readonly action: string;
  readonly mode: "plan" | "apply";
  readonly results: readonly {
    readonly id: string;
    readonly siteId: string;
    readonly status: string;
    readonly before: unknown;
    readonly after: unknown;
    readonly error: string | null;
  }[];
  readonly auditEvents: readonly Record<string, unknown>[];
  readonly summary: { readonly total: number; readonly succeeded: number; readonly failed: number };
}

function isPlan(output: SiteActionOutput): output is SiteActionPlanOutput {
  return (output as SiteActionPlanOutput).dryRun === true;
}

function toAuditEvent(event: Record<string, unknown>): SharePointSiteAuditEvent {
  return {
    id: String(event["id"] ?? ""),
    tenantId: String(event["tenantId"] ?? ""),
    action: String(event["action"] ?? ""),
    targetId: String(event["targetId"] ?? ""),
    targetName: String(event["targetName"] ?? ""),
    timestamp: String(event["timestamp"] ?? ""),
    result: event["result"] === "failure" ? "failure" : "success",
    ...(event["before"] !== undefined ? { before: event["before"] as Record<string, unknown> } : {}),
    ...(event["after"] !== undefined ? { after: event["after"] as Record<string, unknown> } : {}),
    ...(event["error"] !== undefined ? { error: String(event["error"]) } : {}),
    ...(event["actor"] !== undefined ? { actorUserId: String(event["actor"]) } : {}),
    ...(event["correlationId"] !== undefined ? { correlationId: String(event["correlationId"]) } : {}),
  };
}

function toSiteCreateResult(output: SiteCreateOutput): SharePointSiteResult | SharePointSitePlan {
  if (output.status === "planned") {
    return {
      action: "create",
      targetName: output.name,
      diff: [`Create ${output.name} (${output.type}) with alias ${output.alias}`],
      valid: true,
      dryRun: true,
    };
  }
  return {
    success: output.status === "created",
    siteId: output.status === "created" ? output.id : null,
    plan: {
      action: "create",
      targetName: output.name,
      diff: [],
      valid: output.status === "created",
      dryRun: false,
    },
  };
}

function toLifecycleResult(output: SiteActionOutput): SharePointSiteOperationResult | SharePointSiteLifecyclePlan {
  if (isPlan(output)) {
    return {
      action: output.action as SharePointSiteOperationResult["operation"],
      siteId: output.siteId,
      targetName: output.targetName,
      ...(output.before !== undefined ? { before: output.before as Record<string, unknown> } : {}),
      ...(output.after !== undefined ? { after: output.after as Record<string, unknown> } : {}),
      diff: output.diff,
      valid: output.valid,
      dryRun: true,
      requiresConfirmation: output.requiresConfirmation,
    };
  }
  return {
    success: output.success,
    state: output.state as "succeeded" | "failed",
    operation: output.operation as SharePointSiteOperationResult["operation"],
    siteId: output.siteId,
    targetName: output.targetName,
    before: (output.plan?.before ?? null) as Record<string, unknown> | null,
    after: (output.plan?.after ?? null) as Record<string, unknown> | null,
    error: output.success ? null : `site ${output.operation} failed`,
    ...(output.auditEvent ? { auditEvent: toAuditEvent(output.auditEvent) } : {}),
  };
}

function toRecycleBinResult(output: RecycleBinActionOutput): SharePointRecycleBinActionResult {
  return {
    action: output.action as SharePointRecycleBinActionResult["action"],
    mode: output.mode,
    results: output.results.map((row) => ({
      id: row.id,
      siteId: row.siteId,
      status: row.status as "planned" | "restored" | "emptied" | "failed",
      before: (row.before ?? null) as Record<string, unknown> | null,
      after: (row.after ?? null) as Record<string, unknown> | null,
      error: row.error,
    })),
    ...(output.auditEvents.length > 0 ? { auditEvents: output.auditEvents.map(toAuditEvent) } : {}),
    summary: {
      total: output.summary.total,
      succeeded: output.summary.succeeded,
      failed: output.summary.failed,
    },
  };
}

export function createSharePointProviders(run: WorkerRunner, credentials: CredentialStoreRow): SharePointProviders {
  const call = createTenantWorker(run, credentials);

  return {
    sites: {
      listSites: async (tenantId, filter) =>
        call<SharePointSitesPage>("get-sharepoint-sites.ps1", tenantId, {
          ...(filter.type ? { Type: filter.type } : {}),
          ...(filter.sharing ? { Sharing: filter.sharing } : {}),
          ...(filter.storagePercent !== undefined ? { StoragePercent: String(filter.storagePercent) } : {}),
          ...(filter.lastActivity ? { LastActivity: filter.lastActivity } : {}),
          ...(filter.sensitivity ? { Sensitivity: filter.sensitivity } : {}),
          Top: filter.limit,
          ...(filter.cursor ? { Cursor: filter.cursor } : {}),
        }),
    },

    sitesCreate: {
      createSite: async (tenantId, input, preview) => {
        const output = await call<SiteCreateOutput>("new-sharepoint-site.ps1", tenantId, {
          schemaVersion: "v1",
          payload: {
            site: {
              name: input.name,
              alias: input.alias,
              type: input.type,
              owners: [...input.owners],
              ...(input.template ? { template: input.template } : {}),
              sharing: input.sharing,
            },
            dryRun: preview,
          },
        });
        return toSiteCreateResult(output);
      },

      createSitesBulk: async (tenantId, sites, csv, preview) => {
        const output = await call<SiteBulkOutput>("new-sharepoint-site-bulk.ps1", tenantId, {
          schemaVersion: "v1",
          payload: {
            ...(csv !== undefined ? { csv } : { sites: sites.map((site) => ({
              name: site.name,
              alias: site.alias,
              type: site.type,
              owners: [...site.owners],
              ...(site.template ? { template: site.template } : {}),
              sharing: site.sharing,
            })) }),
            dryRun: preview,
          },
        });
        const result: SharePointSitesBulkResult = {
          success: output.failed === 0,
          total: output.total,
          created: output.created,
          failed: output.failed,
          results: output.results.map((row) => ({
            row: row.row ?? 0,
            name: row.name,
            alias: row.alias,
            status: row.status,
            ...(row.id ? { siteId: row.id } : {}),
            ...(row.error ? { error: row.error } : {}),
          })),
        };
        return result;
      },
    },

    lifecycle: {
      deleteSite: async (tenantId, siteId, input, preview) => {
        const output = await call<SiteActionOutput>("invoke-sharepoint-site-action.ps1", tenantId, {
          schemaVersion: "v1",
          correlationId: globalThis.crypto.randomUUID(),
          action: "delete",
          payload: { siteId, dryRun: preview, confirm: input.confirm === true },
        });
        return toLifecycleResult(output);
      },

      restoreSite: async (tenantId, siteId, input, preview) => {
        const output = await call<SiteActionOutput>("invoke-sharepoint-site-action.ps1", tenantId, {
          schemaVersion: "v1",
          correlationId: globalThis.crypto.randomUUID(),
          action: "restore",
          payload: { siteId, dryRun: preview, confirm: input.confirm === true },
        });
        return toLifecycleResult(output);
      },

      // The recyclebin-list action reads no filter fields from the job envelope
      // (Read-SharePointSiteActionJob carries only the action and the entry ids), so
      // the worker answers its default first page; search/cursor/limit are a no-op.
      listRecycleBin: async (tenantId) =>
        call<SharePointRecycleBinPage>("invoke-sharepoint-site-action.ps1", tenantId, {
          schemaVersion: "v1",
          correlationId: globalThis.crypto.randomUUID(),
          action: "recyclebin-list",
          payload: { dryRun: true },
        }),

      recycleBinAction: async (tenantId, input, preview) => {
        const output = await call<RecycleBinActionOutput>("invoke-sharepoint-site-action.ps1", tenantId, {
          schemaVersion: "v1",
          correlationId: globalThis.crypto.randomUUID(),
          action: input.action === "restore" ? "recyclebin-restore" : "recyclebin-empty",
          payload: {
            recycleBinIds: [...input.itemIds],
            dryRun: preview,
            confirm: input.confirm === true,
          },
        });
        return toRecycleBinResult(output);
      },
    },

    browse: {
      browseSite: async (tenantId, siteId) =>
        call<SharePointSiteBrowser>("get-site-browser.ps1", tenantId, { SiteId: siteId }),
    },

    storage: {
      getSiteStorage: async (tenantId, siteId) =>
        call<SiteStorageComposition>("get-site-storage.ps1", tenantId, { SiteId: siteId }),

      cleanupVersions: async (tenantId, siteId, input) =>
        call<VersionCleanupPlan | VersionCleanupApply>("invoke-version-cleanup.ps1", tenantId, {
          SiteId: siteId,
          AgeThresholdDays: input.ageThresholdDays,
          ...(input.includeVersions ? { IncludeVersions: [...input.includeVersions] } : {}),
          ...(input.excludeVersions ? { ExcludeVersions: [...input.excludeVersions] } : {}),
          Mode: input.preview === true ? "Plan" : "Apply",
          ...(input.confirmCount !== undefined ? { ConfirmCount: input.confirmCount } : {}),
          JobId: globalThis.crypto.randomUUID(),
        }),
    },

    onedrive: {
      getUsage: async (tenantId) => call<OneDriveUsageReport>("get-onedrive-usage.ps1", tenantId, {}),
    },
  };
}
