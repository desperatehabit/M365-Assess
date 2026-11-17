// EPIC-022 Spam, Quarantine & Allow/Block worker-backed providers (T-0852).
//
// Binds the six EPIC-022 route modules to the PowerShell workers:
//
//   quarantine          get-quarantine.ps1             (T-0007 envelope; list + single-message preview)
//   submitProvider      submit-quarantine-review.ps1   (T-0007 envelope; live review status refresh)
//   quarantinePolicies  get-quarantine-policies.ps1    (T-0007 envelope; notification + permission list)
//   allowBlock          get-allow-block.ps1            (T-0007 envelope; sender/domain/url/file list)
//   filters             get-filters.ps1                (T-0007 envelope; spam/antiphish/malware/connection)
//   queue               remediation envelope dispatch  ->
//                         invoke-quarantine-action.ps1   (release/releaseAll/delete)
//                         invoke-quarantine-bulk.ps1     (capped bulk release/releaseAll/delete)
//                         submit-quarantine-review.ps1   (submit for review)
//                         set-allow-block-entry.ps1      (allow/block CRUD + quarantine block-sender)
//                         set-quarantine-policy.ps1      (quarantine policy CRUD)
//                         set-filter.ps1                 (filter CRUD + template deploy)
//
// Every call signs in through the tenant credential block (createTenantWorker /
// createEnvelopeWorker), so the BFF never imports M365 SDKs or mutates tenants directly.
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import type {
  AllowBlockAction,
  AllowBlockEntry,
  AllowBlockPage,
  AllowBlockProvider,
  AllowBlockType,
} from "../routes/allow-block.js";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  FilterItem,
  FilterPolicy,
  FiltersPage,
  FiltersProvider,
  FilterType,
} from "../routes/filters.js";
import {
  QUARANTINE_SUBMISSION_STATUSES,
  QUARANTINE_TABS,
  type QuarantineFilter,
  type QuarantineMessage,
  type QuarantineMessageDetail,
  type QuarantinePage,
  type QuarantineProvider,
  type QuarantineSubmission,
  type QuarantineSubmissionStatus,
  type QuarantineSubmitProvider,
  type QuarantineTab,
} from "../routes/quarantine.js";
import type {
  QuarantinePoliciesPage,
  QuarantinePoliciesProvider,
  QuarantinePolicy,
  QuarantinePolicyState,
  QuarantinePolicyType,
} from "../routes/quarantine-policies.js";
import {
  asArray,
  createEnvelopeWorker,
  createTenantWorker,
  raiseWorkerError,
  WORKER_FAILED,
  type WorkerRunner,
} from "./workers.js";

export interface SpamQuarantineAdapters {
  readonly quarantine: QuarantineProvider;
  readonly submitProvider: QuarantineSubmitProvider;
  readonly quarantinePolicies: QuarantinePoliciesProvider;
  readonly allowBlock: AllowBlockProvider;
  readonly filters: FiltersProvider;
  readonly queue: {
    enqueue(envelope: JobEnvelope): Promise<string>;
  };
}

type Row = Record<string, unknown>;

interface TrackedSubmission {
  readonly submissionId: string;
  readonly submittedAt: string;
}

const VALID_SUBMISSION_STATUSES: ReadonlySet<string> = new Set(QUARANTINE_SUBMISSION_STATUSES);
const VALID_QUARANTINE_TABS: ReadonlySet<string> = new Set(QUARANTINE_TABS);

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Row {
  return isRecord(value) ? value : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cursorOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === WORKER_FAILED &&
    /NotFound|not found|couldn't be found|could not be found|ManagementObjectNotFound|404/i.test(
      error.message,
    )
  );
}

function normalizeTab(value: unknown, fallback: QuarantineTab): QuarantineTab {
  if (typeof value === "string" && VALID_QUARANTINE_TABS.has(value)) {
    return value as QuarantineTab;
  }
  return fallback;
}

function mapQuarantineMessage(value: unknown, fallbackTab: QuarantineTab): QuarantineMessage {
  const row = asRecord(value);
  return {
    messageId: asString(row["messageId"]),
    tab: normalizeTab(row["tab"], fallbackTab),
    received: asString(row["received"]),
    subject: asString(row["subject"]),
    sender: asString(row["sender"]),
    recipient: asString(row["recipient"]),
    reason: asString(row["reason"]),
    policy: asString(row["policy"]),
    expires: nullableString(row["expires"]),
    state: asString(row["state"], "Quarantined"),
    direction: asString(row["direction"]),
  };
}

function mapQuarantineDetail(value: unknown): QuarantineMessageDetail {
  const row = asRecord(value);
  const message = mapQuarantineMessage(row, "email");
  const preview = asRecord(row["preview"]);
  const source = preview["source"] === "exo" ? "exo" : "graph";
  const available = preview["available"] === true;
  const body = typeof preview["body"] === "string" ? preview["body"] : null;
  return {
    ...message,
    preview: {
      source,
      available,
      body,
    },
  };
}

function normalizeSubmissionStatus(value: unknown): QuarantineSubmissionStatus {
  if (typeof value === "string" && VALID_SUBMISSION_STATUSES.has(value)) {
    return value as QuarantineSubmissionStatus;
  }
  return "pending";
}

function normalizeAllowBlockType(value: unknown): AllowBlockType {
  if (value === "sender" || value === "domain" || value === "url" || value === "file") {
    return value;
  }
  return "sender";
}

function mapAllowBlockEntry(value: unknown): AllowBlockEntry {
  const row = asRecord(value);
  return {
    type: normalizeAllowBlockType(row["type"]),
    value: asString(row["value"]),
    action: row["action"] === "allow" ? "allow" : "block",
    expiresOn: nullableString(row["expiresOn"]),
    notes: asString(row["notes"]),
  };
}

function mapQuarantinePolicy(value: unknown): QuarantinePolicy {
  const row = asRecord(value);
  return {
    name: asString(row["name"]),
    policyType: asString(row["policyType"], "notification"),
    esnEnabled: row["esnEnabled"] === true,
    quarantineRetentionPeriod: asNumber(row["quarantineRetentionPeriod"], 0),
    addressForMessages: asString(row["addressForMessages"]),
    lastModified: nullableString(row["lastModified"]),
  };
}

function mapFilterItem(value: unknown): FilterItem {
  const row = asRecord(value);
  return {
    name: asString(row["name"]),
    priority: typeof row["priority"] === "number" && Number.isFinite(row["priority"]) ? row["priority"] : null,
    state: asString(row["state"], "Unknown"),
    summary: asString(row["summary"]),
    lastModified: nullableString(row["lastModified"]),
  };
}

function parseSummaryValue(raw: string): unknown {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (/^-?\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isSafeInteger(num)) return num;
  }
  return trimmed;
}

function parseFilterSummary(summary: string): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const part of summary.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const rawKey = part.slice(0, eqIdx).trim();
    const rawValue = part.slice(eqIdx + 1).trim();
    if (rawKey.length === 0) continue;
    const camelKey = rawKey.charAt(0).toLowerCase() + rawKey.slice(1);
    settings[camelKey] = parseSummaryValue(rawValue);
  }
  return settings;
}

function submissionKey(tenantId: string, messageId: string): string {
  return `${tenantId}\0${messageId}`;
}

export function createSpamQuarantineAdapters(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
): SpamQuarantineAdapters {
  const call = createTenantWorker(run, credentials);
  const envelopeCall = createEnvelopeWorker(run, credentials);
  const trackedSubmissions = new Map<string, TrackedSubmission>();

  const runEnvelope = <T>(
    entrypoint: string,
    tenantId: string,
    correlationId: string,
    payload: Row,
  ): Promise<T> =>
    call<T>(entrypoint, tenantId, {
      schemaVersion: "v1",
      correlationId,
      payload,
    });

  const quarantine: QuarantineProvider = {
    async listMessages(tenantId: string, filter: QuarantineFilter): Promise<QuarantinePage> {
      const result = await envelopeCall<unknown>("get-quarantine.ps1", tenantId, {
        tab: filter.tab,
        ...(filter.reason !== undefined ? { reason: filter.reason } : {}),
        ...(filter.direction !== undefined ? { direction: filter.direction } : {}),
        ...(filter.recipient !== undefined ? { recipient: filter.recipient } : {}),
        ...(filter.state !== undefined ? { state: filter.state } : {}),
        ...(filter.dateFrom !== undefined ? { dateFrom: filter.dateFrom } : {}),
        ...(filter.dateTo !== undefined ? { dateTo: filter.dateTo } : {}),
        ...(filter.cursor !== null ? { cursor: filter.cursor } : {}),
        limit: filter.limit,
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      const rawItems = asArray(record["items"]);
      return {
        tenantId: asString(record["tenantId"], tenantId),
        tab: normalizeTab(record["tab"], filter.tab),
        items: rawItems.map((item) => mapQuarantineMessage(item, filter.tab)),
        totalCount: asNumber(record["totalCount"], rawItems.length),
        nextCursor: cursorOrNull(record["nextCursor"]),
        retrievedAt: asString(record["retrievedAt"], nowIso()),
      };
    },

    async getMessage(tenantId: string, messageId: string): Promise<QuarantineMessageDetail | undefined> {
      let result: unknown;
      try {
        result = await envelopeCall<unknown>("get-quarantine.ps1", tenantId, { messageId });
      } catch (error) {
        if (isNotFoundError(error)) return undefined;
        throw error;
      }
      if (result === null || result === undefined) {
        return undefined;
      }
      raiseWorkerError(result);
      const record = asRecord(result);
      if (asString(record["messageId"]).length === 0) {
        return undefined;
      }
      return mapQuarantineDetail(record);
    },
  };

  const submitProvider: QuarantineSubmitProvider = {
    async getSubmissionStatus(
      tenantId: string,
      messageId: string,
    ): Promise<QuarantineSubmission | undefined> {
      const tracked = trackedSubmissions.get(submissionKey(tenantId, messageId));
      const submissionId = tracked?.submissionId ?? messageId;

      let result: unknown;
      try {
        result = await envelopeCall<unknown>("submit-quarantine-review.ps1", tenantId, {
          messageId,
          refresh: true,
          submissionId,
        });
      } catch (error) {
        if (isNotFoundError(error)) return undefined;
        throw error;
      }
      if (result === null || result === undefined) {
        return undefined;
      }
      raiseWorkerError(result);
      const record = asRecord(result);
      if (record["found"] === false) {
        return undefined;
      }
      const updatedAt = asString(record["updatedAt"] ?? record["refreshedAt"], nowIso());
      return {
        submissionId: asString(record["submissionId"], submissionId),
        messageId: asString(record["messageId"], messageId),
        status: normalizeSubmissionStatus(record["status"]),
        submittedAt: asString(record["submittedAt"], tracked?.submittedAt ?? updatedAt),
        updatedAt,
      };
    },
  };

  const quarantinePolicies: QuarantinePoliciesProvider = {
    async listPolicies(tenantId: string): Promise<QuarantinePoliciesPage> {
      const result = await envelopeCall<unknown>("get-quarantine-policies.ps1", tenantId, {});
      raiseWorkerError(result);
      const record = asRecord(result);
      const rawItems = asArray(record["items"]);
      return {
        tenantId: asString(record["tenantId"], tenantId),
        items: rawItems.map(mapQuarantinePolicy),
        totalCount: asNumber(record["totalCount"], rawItems.length),
        retrievedAt: asString(record["retrievedAt"], nowIso()),
      };
    },

    async getPolicy(
      tenantId: string,
      policyType: QuarantinePolicyType,
      policyName: string,
    ): Promise<QuarantinePolicyState | undefined> {
      const result = await envelopeCall<unknown>("get-quarantine-policies.ps1", tenantId, {
        policyType,
        policyName,
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      const items = asArray(record["items"]).map(mapQuarantinePolicy);
      const target = policyName.trim().toLowerCase();
      const match =
        items.find((item) => item.name.toLowerCase() === target && item.policyType === policyType) ??
        items.find((item) => item.name.toLowerCase() === target);
      if (!match) {
        return undefined;
      }
      return {
        name: match.name,
        policyType,
        settings: {
          esnEnabled: match.esnEnabled,
          quarantineRetentionPeriod: match.quarantineRetentionPeriod,
          addressForMessages: match.addressForMessages,
        },
      };
    },
  };

  const allowBlock: AllowBlockProvider = {
    async listEntries(tenantId: string): Promise<AllowBlockPage> {
      const result = await envelopeCall<unknown>("get-allow-block.ps1", tenantId, {});
      raiseWorkerError(result);
      const record = asRecord(result);
      const rawItems = asArray(record["items"]);
      return {
        tenantId: asString(record["tenantId"], tenantId),
        items: rawItems.map(mapAllowBlockEntry),
        totalCount: asNumber(record["totalCount"], rawItems.length),
        retrievedAt: asString(record["retrievedAt"], nowIso()),
      };
    },

    async getEntry(
      tenantId: string,
      type: AllowBlockType,
      value: string,
      action: AllowBlockAction,
    ): Promise<AllowBlockEntry | undefined> {
      const result = await envelopeCall<unknown>("get-allow-block.ps1", tenantId, {
        type,
        value,
        action,
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      const items = asArray(record["items"]).map(mapAllowBlockEntry);
      const targetValue = value.trim().toLowerCase();
      return items.find(
        (item) =>
          item.type === type &&
          item.action === action &&
          item.value.trim().toLowerCase() === targetValue,
      );
    },
  };

  const filters: FiltersProvider = {
    async getFilters(tenantId: string, filterType: FilterType): Promise<FiltersPage> {
      const result = await envelopeCall<unknown>("get-filters.ps1", tenantId, { filterType });
      raiseWorkerError(result);
      const record = asRecord(result);
      const rawItems = asArray(record["items"]);
      return {
        tenantId: asString(record["tenantId"], tenantId),
        filterType,
        items: rawItems.map(mapFilterItem),
        totalCount: asNumber(record["totalCount"], rawItems.length),
        retrievedAt: asString(record["retrievedAt"], nowIso()),
      };
    },

    async getFilterPolicy(
      tenantId: string,
      filterType: FilterType,
      policyName: string,
    ): Promise<FilterPolicy | undefined> {
      const result = await envelopeCall<unknown>("get-filters.ps1", tenantId, { filterType });
      raiseWorkerError(result);
      const record = asRecord(result);
      const rawItems = asArray(record["items"]);
      const target = policyName.trim().toLowerCase();
      const rawMatch = rawItems.find(
        (entry) => asString(asRecord(entry)["name"]).trim().toLowerCase() === target,
      );
      if (rawMatch === undefined) {
        return undefined;
      }
      const matchRecord = asRecord(rawMatch);
      const item = mapFilterItem(matchRecord);
      const parsedSettings = parseFilterSummary(item.summary);
      const explicitSettings = isRecord(matchRecord["settings"]) ? matchRecord["settings"] : {};
      const settings = { ...parsedSettings, ...explicitSettings };
      const stateLower = item.state.trim().toLowerCase();
      const enabled =
        stateLower === "enabled"
          ? true
          : stateLower === "disabled"
            ? false
            : settings["enabled"] === true;

      return {
        name: item.name,
        enabled,
        settings,
      };
    },
  };

  const queue = {
    async enqueue(envelope: JobEnvelope): Promise<string> {
      const payload = asRecord(envelope.payload);
      const area = asString(payload["area"]);
      const action = asString(payload["action"]);
      const tenantId = envelope.tenantId;
      const correlationId = envelope.correlationId;

      if (area === "quarantine") {
        if (action === "submit") {
          const messageId = asString(payload["messageId"]);
          const requestedSubmissionId = asString(payload["submissionId"]);
          const result = await runEnvelope<unknown>("submit-quarantine-review.ps1", tenantId, correlationId, {
            messageId,
            recipient: asString(payload["recipient"]),
            category:
              typeof payload["category"] === "string" && payload["category"].length > 0
                ? payload["category"]
                : "spam",
            refresh: payload["refresh"] === true,
            ...(requestedSubmissionId.length > 0 ? { submissionId: requestedSubmissionId } : {}),
            ...(typeof payload["actor"] === "string" ? { actor: payload["actor"] } : {}),
          });
          raiseWorkerError(result);
          const resultRec = asRecord(result);
          const submissionId = asString(resultRec["submissionId"], requestedSubmissionId);
          if (messageId.length > 0 && submissionId.length > 0) {
            trackedSubmissions.set(submissionKey(tenantId, messageId), {
              submissionId,
              submittedAt: asString(resultRec["submittedAt"], envelope.createdAt),
            });
          }
          return envelope.jobId;
        }

        if (action === "block") {
          const result = await runEnvelope<unknown>("set-allow-block-entry.ps1", tenantId, correlationId, {
            type: "sender",
            action: "create",
            value: asString(payload["sender"]),
            entryAction: "block",
            notes: asString(
              payload["notes"],
              `Blocked from quarantine message ${asString(payload["messageId"])}`,
            ),
            dryRun: false,
          });
          raiseWorkerError(result);
          return envelope.jobId;
        }

        const result = await runEnvelope<unknown>("invoke-quarantine-action.ps1", tenantId, correlationId, {
          action,
          messageId: asString(payload["messageId"]),
          ...(payload["recipient"] !== undefined && payload["recipient"] !== null
            ? { recipient: asString(payload["recipient"]) }
            : {}),
          ...(payload["sender"] !== undefined ? { sender: asString(payload["sender"]) } : {}),
          ...(payload["subject"] !== undefined ? { subject: asString(payload["subject"]) } : {}),
          dryRun: false,
          confirm: true,
          ...(payload["actor"] !== undefined ? { actor: asString(payload["actor"]) } : {}),
        });
        raiseWorkerError(result);
        return envelope.jobId;
      }

      if (area === "quarantine-bulk") {
        const result = await runEnvelope<unknown>("invoke-quarantine-bulk.ps1", tenantId, correlationId, {
          action,
          messages: asArray(payload["messages"]),
          ...(typeof payload["cap"] === "number" ? { cap: payload["cap"] } : {}),
          dryRun: false,
          confirm: payload["confirm"] === true,
          ...(payload["actor"] !== undefined ? { actor: asString(payload["actor"]) } : {}),
        });
        raiseWorkerError(result);
        return envelope.jobId;
      }

      if (area === "quarantine-policies") {
        const result = await runEnvelope<unknown>("set-quarantine-policy.ps1", tenantId, correlationId, {
          policyType: asString(payload["policyType"]),
          action,
          policyName: asString(payload["policyName"]),
          ...(isRecord(payload["settings"]) ? { settings: payload["settings"] } : {}),
          confirm: true,
          dryRun: false,
        });
        raiseWorkerError(result);
        return envelope.jobId;
      }

      if (area === "allow-block") {
        const result = await runEnvelope<unknown>("set-allow-block-entry.ps1", tenantId, correlationId, {
          type: asString(payload["type"]),
          action,
          value: asString(payload["value"]),
          entryAction: asString(payload["entryAction"]),
          ...(payload["expiresOn"] !== undefined && payload["expiresOn"] !== null
            ? { expiresOn: asString(payload["expiresOn"]) }
            : {}),
          ...(payload["notes"] !== undefined ? { notes: asString(payload["notes"]) } : {}),
          dryRun: false,
        });
        raiseWorkerError(result);
        return envelope.jobId;
      }

      if (area === "filters") {
        const result = await runEnvelope<unknown>("set-filter.ps1", tenantId, correlationId, {
          filterType: asString(payload["filterType"]),
          action,
          policyName: asString(payload["policyName"]),
          ...(isRecord(payload["settings"]) ? { settings: payload["settings"] } : {}),
          confirm: true,
          dryRun: false,
        });
        raiseWorkerError(result);
        return envelope.jobId;
      }

      throw new AppError(ErrorCodes.validationFailed, `unsupported remediation area '${area}'`, 400, [
        { field: "area", reason: "invalid" },
      ]);
    },
  };

  return {
    quarantine,
    submitProvider,
    quarantinePolicies,
    allowBlock,
    filters,
    queue,
  };
}
