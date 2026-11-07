// EPIC-024 Email Tools worker-backed providers (T-0854).
//
// The route factories were written against provider seams but never mounted, and
// no adapter bound them to the PowerShell workers. This module does that:
//
//   messageTrace      get-message-trace.ps1        (T-0007 envelope; payload filters)
//   historicalSearch  start-historical-search.ps1  (start / poll / cancel)
//   messages          get-message-detail.ps1       (payload messageId + includeBody)
//   mailRestores      start-mailbox-restore.ps1    (plan / apply; RestoreJob persisted)
//   encryption        get-message-encryption.ps1   (read / apply; top-level action)
//
// Every call signs in through the tenant credential block (createTenantWorker) so
// the BFF never calls EXO itself. Message data stays live in EXO: only the
// RestoreJob records persist, through the shared db repository (migration 0032).
import { randomUUID } from "node:crypto";
import type { RestoreJob, RestoreJobInput, RestoreJobUpdate } from "@m365-assess/db";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  EncryptionProvider,
  MessageEncryption,
  MessageEncryptionTemplatePlan,
  MessageEncryptionTemplateResult,
} from "../routes/encryption.js";
import type {
  HistoricalSearchInput,
  HistoricalSearchJob,
  HistoricalSearchMatch,
  HistoricalSearchProvider,
  HistoricalSearchResult,
} from "../routes/historical-search.js";
import type {
  MailRestoreInput,
  MailRestoreJob,
  MailRestorePlan,
  MailRestoresProvider,
  MailRestoreResult,
} from "../routes/mail-restores.js";
import type {
  MessageDetail,
  MessagesProvider,
} from "../routes/messages.js";
import type {
  MessageTraceFilter,
  MessageTracePage,
  MessageTraceProvider,
  MessageTraceRow,
} from "../routes/message-trace.js";
import {
  asArray,
  createTenantWorker,
  raiseWorkerError,
  WORKER_FAILED,
  type WorkerRunner,
} from "./workers.js";
import { AppError } from "../errors.js";

export interface EmailToolsProviders {
  readonly messageTrace: MessageTraceProvider;
  readonly historicalSearch: HistoricalSearchProvider;
  readonly messages: MessagesProvider;
  readonly mailRestores: MailRestoresProvider;
  readonly encryption: EncryptionProvider;
}

/** The RestoreJob repository methods the restore provider persists through. */
export interface RestoreJobRepository {
  createRestoreJob(input: RestoreJobInput): Promise<RestoreJob>;
  getRestoreJob(tenantId: string, jobId: string): Promise<RestoreJob | undefined>;
  updateRestoreJob(tenantId: string, jobId: string, update: RestoreJobUpdate): Promise<RestoreJob | undefined>;
}

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** The workers emit an empty string, not null, when a page is the last one. */
function cursorOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === WORKER_FAILED &&
    /not.?found|couldn't be found|could not be found/i.test(error.message)
  );
}

function mapTracePage(value: unknown, tenantId: string): MessageTracePage {
  const record = asRecord(value);
  return {
    tenantId: asString(record["tenantId"], tenantId),
    items: asArray(record["items"]) as readonly MessageTraceRow[],
    nextCursor: cursorOrNull(record["nextCursor"]),
    totalCount: typeof record["totalCount"] === "number" ? record["totalCount"] : asArray(record["items"]).length,
    retrievedAt: asString(record["retrievedAt"], nowIso()),
  };
}

function mapHistoricalSearchJob(value: unknown, tenantId: string): HistoricalSearchJob {
  const record = asRecord(value);
  const updatedAt = asString(record["updatedAt"], nowIso());
  return {
    id: asString(record["jobId"] ?? record["id"]),
    tenantId: asString(record["tenantId"], tenantId),
    searchName: asString(record["searchName"]),
    state: (asString(record["state"], "queued") as HistoricalSearchJob["state"]),
    ...(typeof record["progressPercent"] === "number"
      ? { progressPercent: record["progressPercent"] }
      : {}),
    ...(typeof record["createdBy"] === "string" ? { createdBy: record["createdBy"] } : {}),
    createdAt: asString(record["createdAt"], updatedAt),
    updatedAt,
  };
}

function mapHistoricalSearchResult(value: unknown, tenantId: string): HistoricalSearchResult {
  const record = asRecord(value);
  const job = mapHistoricalSearchJob(record, tenantId);
  const matches = asArray(record["matches"]) as readonly HistoricalSearchMatch[];
  return {
    job,
    matches,
    totalCount: typeof record["totalCount"] === "number" ? record["totalCount"] : matches.length,
    ...(typeof record["downloadRef"] === "string" ? { downloadRef: record["downloadRef"] } : {}),
  };
}

function mapRestorePlan(value: unknown): MailRestorePlan {
  const record = asRecord(value);
  return {
    action: "restore",
    mailboxId: asString(record["mailboxId"]),
    scope: (asString(record["scope"], "mailbox") as MailRestorePlan["scope"]),
    target: asNullableString(record["target"]),
    before: (record["before"] ?? null) as Record<string, unknown> | null,
    after: (record["after"] ?? null) as Record<string, unknown> | null,
    diff: asArray(record["diff"]).map((entry) => String(entry)),
    valid: record["valid"] !== false,
    dryRun: record["dryRun"] !== false,
    requiresConfirmation: record["requiresConfirmation"] !== false,
  };
}

function mapRestoreJob(job: RestoreJob): MailRestoreJob {
  return {
    id: job.id,
    tenantId: job.tenantId,
    mailboxId: job.mailboxId,
    scope: job.scope,
    target: job.target,
    state: job.state,
    result: job.result,
    createdAt: job.createdAt,
    createdBy: job.createdBy,
  };
}

export function createEmailToolsProviders(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
  restoreJobs: RestoreJobRepository,
): EmailToolsProviders {
  const call = createTenantWorker(run, credentials);
  // Most EPIC-024 workers read the T-0007 envelope. A couple also read a field at
  // the envelope's top level (`action` for encryption), so the envelope is built
  // here rather than through createEnvelopeWorker.
  const envelope = <T>(
    entrypoint: string,
    tenantId: string,
    payload: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<T> =>
    call<T>(entrypoint, tenantId, {
      schemaVersion: "v1",
      correlationId: randomUUID(),
      payload,
      ...extra,
    });

  const messageTrace: MessageTraceProvider = {
    async traceMessages(tenantId: string, filter: MessageTraceFilter): Promise<MessageTracePage> {
      const result = await envelope<unknown>("get-message-trace.ps1", tenantId, {
        ...(filter.sender ? { sender: filter.sender } : {}),
        ...(filter.recipient ? { recipient: filter.recipient } : {}),
        ...(filter.subject ? { subject: filter.subject } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.startDate ? { startDate: filter.startDate } : {}),
        ...(filter.endDate ? { endDate: filter.endDate } : {}),
        top: filter.limit,
        cursor: filter.cursor ?? "",
      });
      raiseWorkerError(result);
      return mapTracePage(result, tenantId);
    },
  };

  const historicalSearch: HistoricalSearchProvider = {
    async startSearch(
      tenantId: string,
      input: HistoricalSearchInput,
      createdBy?: string,
    ): Promise<HistoricalSearchJob> {
      const jobId = randomUUID();
      const result = await envelope<unknown>("start-historical-search.ps1", tenantId, {
        action: "start",
        jobId,
        query: input.query,
        exchangeLocation: input.mailboxes ?? [],
        ...(input.startDate ? { startDate: input.startDate } : {}),
        ...(input.endDate ? { endDate: input.endDate } : {}),
        ...(input.top !== undefined ? { top: input.top } : {}),
        ...(createdBy ? { createdBy } : {}),
      });
      raiseWorkerError(result);
      return mapHistoricalSearchJob(result, tenantId);
    },

    async getSearch(tenantId: string, jobId: string): Promise<HistoricalSearchResult> {
      const result = await envelope<unknown>("start-historical-search.ps1", tenantId, {
        action: "poll",
        jobId,
      });
      raiseWorkerError(result);
      return mapHistoricalSearchResult(result, tenantId);
    },

    async cancelSearch(tenantId: string, jobId: string): Promise<HistoricalSearchJob> {
      const result = await envelope<unknown>("start-historical-search.ps1", tenantId, {
        action: "cancel",
        jobId,
      });
      raiseWorkerError(result);
      return mapHistoricalSearchJob(result, tenantId);
    },
  };

  const messages: MessagesProvider = {
    async getMessage(
      tenantId: string,
      messageId: string,
      includeBody: boolean,
    ): Promise<MessageDetail | null> {
      try {
        const result = await envelope<unknown>("get-message-detail.ps1", tenantId, {
          messageId,
          includeBody,
        });
        raiseWorkerError(result);
        const record = asRecord(result);
        return {
          ...(record as unknown as MessageDetail),
          tenantId: asString(record["tenantId"], tenantId),
          messageId: asString(record["messageId"], messageId),
        };
      } catch (error) {
        // An unknown message is a 404 (the route maps null), not a worker failure.
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };

  const mailRestores: MailRestoresProvider = {
    async planRestore(
      tenantId: string,
      input: MailRestoreInput,
      createdBy?: string,
    ): Promise<MailRestorePlan> {
      const result = await envelope<unknown>("start-mailbox-restore.ps1", tenantId, {
        action: "plan",
        mailboxId: input.mailboxId,
        scope: input.scope,
        ...(input.target ? { target: input.target } : {}),
        ...(input.query ? { query: input.query } : {}),
        ...(input.startDate ? { startDate: input.startDate } : {}),
        ...(input.endDate ? { endDate: input.endDate } : {}),
        ...(createdBy ? { createdBy } : {}),
        dryRun: true,
        confirmed: false,
      });
      raiseWorkerError(result);
      return mapRestorePlan(asRecord(result)["plan"]);
    },

    async applyRestore(
      tenantId: string,
      input: MailRestoreInput,
      createdBy?: string,
    ): Promise<MailRestoreResult> {
      const result = await envelope<unknown>("start-mailbox-restore.ps1", tenantId, {
        action: "apply",
        mailboxId: input.mailboxId,
        scope: input.scope,
        ...(input.target ? { target: input.target } : {}),
        ...(input.query ? { query: input.query } : {}),
        ...(input.startDate ? { startDate: input.startDate } : {}),
        ...(input.endDate ? { endDate: input.endDate } : {}),
        ...(createdBy ? { createdBy } : {}),
        dryRun: false,
        confirmed: true,
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      const workerJob = asRecord(record["job"]);
      const plan = mapRestorePlan(record["plan"]);
      const job = await restoreJobs.createRestoreJob({
        id: asString(workerJob["id"], randomUUID()),
        tenantId,
        mailboxId: asString(workerJob["mailboxId"], plan.mailboxId),
        scope: asString(workerJob["scope"], plan.scope),
        target: asNullableString(workerJob["target"] ?? plan.target),
        state: (asString(workerJob["state"], "completed") as RestoreJob["state"]),
        result: (workerJob["result"] ?? record["result"] ?? null) as Record<string, unknown> | null,
        createdBy: asString(workerJob["createdBy"], createdBy ?? ""),
      });
      return {
        success: record["success"] !== false,
        job: mapRestoreJob(job),
        plan,
        ...(record["result"] !== undefined
          ? { result: record["result"] as Record<string, unknown> }
          : {}),
        ...(record["auditEvent"] !== undefined
          ? { auditEvent: record["auditEvent"] as MailRestoreResult["auditEvent"] }
          : {}),
      };
    },

    async getRestoreJob(tenantId: string, jobId: string): Promise<MailRestoreJob> {
      const job = await restoreJobs.getRestoreJob(tenantId, jobId);
      if (job === undefined) {
        throw new Error(`mailbox restore job '${jobId}' was not found`);
      }
      return mapRestoreJob(job);
    },
  };

  const encryption: EncryptionProvider = {
    async getMessageEncryption(tenantId: string): Promise<MessageEncryption | null> {
      const result = await envelope<unknown>("get-message-encryption.ps1", tenantId, {});
      raiseWorkerError(result);
      if (result === null || result === undefined) return null;
      const record = asRecord(result);
      return {
        ...(record as unknown as MessageEncryption),
        tenantId: asString(record["tenantId"], tenantId),
      };
    },

    async applyMessageEncryptionTemplate(
      tenantId: string,
      input,
      preview: boolean,
    ): Promise<MessageEncryptionTemplateResult | MessageEncryptionTemplatePlan> {
      const result = await envelope<unknown>(
        "get-message-encryption.ps1",
        tenantId,
        {
          ...(input.templateId ? { templateId: input.templateId } : {}),
          settings: input.settings,
          dryRun: preview,
          confirmed: !preview,
        },
        { action: "apply" },
      );
      raiseWorkerError(result);
      if (preview) {
        return asRecord(result) as unknown as MessageEncryptionTemplatePlan;
      }
      return asRecord(result) as unknown as MessageEncryptionTemplateResult;
    },
  };

  return { messageTrace, historicalSearch, messages, mailRestores, encryption };
}
