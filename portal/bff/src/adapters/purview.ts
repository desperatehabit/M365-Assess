// EPIC-030 Purview worker-backed providers (T-0860).
//
// Reads run the Purview/EXO workers for the tenant over the T-0582 session seam
// (createTenantWorker adds the credential block and maps failures to 502s), so
// the route modules hold no Purview SDK call. The workers list whole
// collections, so single-item reads page through the list; Safe Links changes
// apply through the same worker with -DryRun for plan previews.
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  PurviewDlpFilter,
  PurviewDlpPage,
  PurviewDlpPolicy,
  PurviewDlpProvider,
} from "../routes/purview-dlp.js";
import type { PurviewDlpWriteProvider } from "../routes/purview-dlp-write.js";
import type {
  PurviewLabelFilter,
  PurviewLabelPage,
  PurviewLabelProvider,
  PurviewSitFilter,
  PurviewSitPage,
  SensitiveInfoType,
  SensitivityLabel,
} from "../routes/purview-labels.js";
import type {
  PurviewRetentionFilter,
  PurviewRetentionPage,
  PurviewRetentionPolicy,
  PurviewRetentionProvider,
} from "../routes/purview-retention.js";
import type {
  SafeLinksAuditEvent,
  SafeLinksChangeResult,
  SafeLinksFilter,
  SafeLinksPage,
  SafeLinksPlan,
  SafeLinksPolicy,
  SafeLinksPolicyInput,
  SafeLinksPolicySettings,
  SafeLinksProvider,
} from "../routes/safelinks.js";
import { createTenantWorker, raiseWorkerError, type WorkerRunner } from "./workers.js";

export interface PurviewProviders {
  readonly dlp: PurviewDlpProvider;
  readonly dlpWrite: PurviewDlpWriteProvider;
  readonly labels: PurviewLabelProvider;
  readonly retention: PurviewRetentionProvider;
  readonly safelinks: SafeLinksProvider;
}

/** The workers cap a page at 1000 rows (ValidateRange on -Top). */
const MAX_PAGE_LIMIT = 1000;

interface WorkerPage<T> {
  readonly tenantId: string;
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

function asPage<T>(value: unknown): WorkerPage<T> {
  const record = (value ?? {}) as Record<string, unknown>;
  const items = Array.isArray(record["items"]) ? (record["items"] as T[]) : [];
  return {
    tenantId: String(record["tenantId"] ?? ""),
    items,
    nextCursor: typeof record["nextCursor"] === "string" ? record["nextCursor"] : null,
    totalCount: typeof record["totalCount"] === "number" ? record["totalCount"] : items.length,
  };
}

function findById<T extends { id: string }>(page: WorkerPage<T>, id: string): T | undefined {
  return page.items.find((item) => item.id === id);
}

function toChangeResult(value: unknown): SafeLinksChangeResult {
  const record = (value ?? {}) as Record<string, unknown>;
  const plan = record["plan"] as SafeLinksPlan;
  return {
    success: record["success"] !== false,
    plan,
    ...(record["result"] !== undefined ? { result: record["result"] as Record<string, unknown> } : {}),
    ...(record["auditEvent"] !== undefined
      ? { auditEvent: record["auditEvent"] as SafeLinksAuditEvent }
      : {}),
  };
}

export function createPurviewProviders(run: WorkerRunner, credentials: CredentialStoreRow): PurviewProviders {
  const call = createTenantWorker(run, credentials);

  async function dlpList(tenantId: string, filter?: PurviewDlpFilter): Promise<PurviewDlpPage> {
    const result = await call<unknown>("get-purview-dlp.ps1", tenantId, {
      ...(filter?.search ? { search: filter.search } : {}),
      ...(filter?.state ? { state: filter.state } : {}),
      top: filter?.limit ?? MAX_PAGE_LIMIT,
      ...(filter?.cursor ? { cursor: filter.cursor } : {}),
    });
    raiseWorkerError(result);
    return asPage<PurviewDlpPolicy>(result);
  }

  async function labelList(tenantId: string, filter?: PurviewLabelFilter): Promise<PurviewLabelPage> {
    const result = await call<unknown>("get-purview-labels.ps1", tenantId, {
      kind: "labels",
      ...(filter?.search ? { search: filter.search } : {}),
      ...(filter?.state ? { state: filter.state } : {}),
      top: filter?.limit ?? MAX_PAGE_LIMIT,
      ...(filter?.cursor ? { cursor: filter.cursor } : {}),
    });
    raiseWorkerError(result);
    return asPage<SensitivityLabel>(result);
  }

  async function sitList(tenantId: string, filter?: PurviewSitFilter): Promise<PurviewSitPage> {
    const result = await call<unknown>("get-purview-labels.ps1", tenantId, {
      kind: "sits",
      ...(filter?.search ? { search: filter.search } : {}),
      ...(filter?.type ? { type: filter.type } : {}),
      top: filter?.limit ?? MAX_PAGE_LIMIT,
      ...(filter?.cursor ? { cursor: filter.cursor } : {}),
    });
    raiseWorkerError(result);
    return asPage<SensitiveInfoType>(result);
  }

  async function retentionList(tenantId: string, filter?: PurviewRetentionFilter): Promise<PurviewRetentionPage> {
    const result = await call<unknown>("get-purview-retention.ps1", tenantId, {
      ...(filter?.search ? { search: filter.search } : {}),
      ...(filter?.state ? { state: filter.state } : {}),
      top: filter?.limit ?? MAX_PAGE_LIMIT,
      ...(filter?.cursor ? { cursor: filter.cursor } : {}),
    });
    raiseWorkerError(result);
    return asPage<PurviewRetentionPolicy>(result);
  }

  async function safeLinksList(tenantId: string, filter: SafeLinksFilter): Promise<SafeLinksPage> {
    const result = await call<unknown>("get-safelinks.ps1", tenantId, {
      ...(filter.search ? { search: filter.search } : {}),
      ...(filter.state ? { state: filter.state } : {}),
      top: filter.limit,
      ...(filter.cursor ? { cursor: filter.cursor } : {}),
    });
    raiseWorkerError(result);
    return asPage<SafeLinksPolicy>(result);
  }

  async function safeLinksChange(
    tenantId: string,
    fields: Record<string, unknown>,
    preview: boolean,
  ): Promise<SafeLinksChangeResult | SafeLinksPlan> {
    const result = await call<unknown>("get-safelinks.ps1", tenantId, {
      ...fields,
      dryRun: preview,
      confirmed: !preview,
    });
    raiseWorkerError(result);
    return preview ? (result as SafeLinksPlan) : toChangeResult(result);
  }

  return {
    dlp: {
      listPolicies: dlpList,
      getPolicy: async (tenantId, policyId) => {
        const page = await dlpList(tenantId, { limit: MAX_PAGE_LIMIT });
        return findById<PurviewDlpPolicy>(page, policyId);
      },
    },

    dlpWrite: {
      getPolicy: async (tenantId, policyId) => {
        const page = await dlpList(tenantId, { limit: MAX_PAGE_LIMIT });
        return findById<PurviewDlpPolicy>(page, policyId);
      },
    },

    labels: {
      listLabels: labelList,
      getLabel: async (tenantId, labelId) => {
        const page = await labelList(tenantId, { limit: MAX_PAGE_LIMIT });
        return findById(page, labelId);
      },
      listSits: sitList,
      getSit: async (tenantId, sitId) => {
        const page = await sitList(tenantId, { limit: MAX_PAGE_LIMIT });
        return findById(page, sitId);
      },
    },

    retention: {
      listPolicies: retentionList,
      getPolicy: async (tenantId, policyId) => {
        const page = await retentionList(tenantId, { limit: MAX_PAGE_LIMIT });
        return findById<PurviewRetentionPolicy>(page, policyId);
      },
    },

    safelinks: {
      listPolicies: safeLinksList,
      createPolicy: (tenantId, input: SafeLinksPolicyInput, preview) =>
        safeLinksChange(
          tenantId,
          {
            action: "create",
            name: input.name ?? "",
            settings: (input.settings ?? {}) as SafeLinksPolicySettings,
          },
          preview,
        ),
      editPolicy: (tenantId, policyId, input: SafeLinksPolicyInput, preview) =>
        safeLinksChange(
          tenantId,
          {
            action: input.action ?? "edit",
            policyId,
            settings: (input.settings ?? {}) as SafeLinksPolicySettings,
          },
          preview,
        ),
      deletePolicy: (tenantId, policyId, confirmName, preview) =>
        safeLinksChange(tenantId, { action: "delete", policyId, confirmName }, preview),
    },
  };
}
