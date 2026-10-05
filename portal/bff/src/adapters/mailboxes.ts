// EPIC-020 worker-backed mailbox providers (T-0850).
//
// Each provider turns a route's typed call into a feature-worker job for the tenant
// (createTenantWorker adds the credential block and maps failures to 502s) and returns
// the worker's JSON in the route's shape. Audit events the workers return are recorded
// by the app, which knows the signed-in actor. Mailbox objects stay live in EXO: the
// only persisted rows are the vacation schedule records (vacation_schedules, migration
// 0025), which the EPIC-007 scheduler enables and reverts.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  CreateSharedMailboxInput,
  ConvertMailboxInput,
  MailboxDetail,
  MailboxSettingsInput,
  MailboxSettingsPlan,
  MailboxSettingsProvider,
  MailboxSettingsResult,
  MailboxesFilter,
  MailboxesPage,
  MailboxesProvider,
  MailboxWritePlan,
  MailboxWriteProvider,
  MailboxWriteResult,
} from "../routes/mailboxes.js";
import {
  type GrantMailboxPermissionInput,
  type MailboxPermissionPlan,
  type MailboxPermissionReportEntry,
  type MailboxPermissionReportFilter,
  type MailboxPermissionResult,
  type MailboxPermissionsList,
  type MailboxPermissionsProvider,
  type MailboxPermissionsReportPage,
  type MailboxPermissionsReportProvider,
  type RemoveMailboxPermissionInput,
} from "../routes/mailbox-permissions.js";
import type { MailboxReportFilter, MailboxReportsProvider } from "../routes/mailbox-reports.js";
import type {
  CreateMailboxRuleInput,
  EditMailboxRuleInput,
  MailboxRulePlan,
  MailboxRuleResult,
  MailboxRulesListResponse,
  MailboxRulesProvider,
} from "../routes/mailbox-rules.js";
import type {
  AssignRetentionTagBulkInput,
  AssignRetentionTagInput,
  CreateRetentionTagInput,
  EditRetentionTagInput,
  RetentionAssignBulkPlan,
  RetentionAssignBulkResult,
  RetentionAssignPlan,
  RetentionAssignResult,
  RetentionPolicy,
  RetentionProvider,
  RetentionTag,
  RetentionTagPlan,
  RetentionTagResult,
} from "../routes/retention.js";
import type {
  VacationApplyProvider,
  VacationApplyResult,
  VacationPhase,
  VacationSchedule,
  VacationScheduleInput,
  VacationScheduleState,
  VacationScheduleStore,
} from "../routes/vacation-schedules.js";
import {
  notSoftDeletedError,
  type DeletedMailboxesFilter,
  type DeletedMailboxesPage,
  type DeletedMailboxesProvider,
  type DeletedMailboxRestorePlan,
  type DeletedMailboxRestoreResult,
  type RestoreDeletedMailboxInput,
} from "../routes/deleted-mailboxes.js";
import { asArray, createTenantWorker, raiseWorkerError, WORKER_FAILED, type WorkerRunner } from "./workers.js";
import { AppError } from "../errors.js";
import { MAILBOX_NOT_FOUND } from "../routes/mailboxes.js";

export const RETENTION_TAG_WRITE_UNAVAILABLE = "mailboxes.retention_tag_write_unavailable";
export const RETENTION_TAG_READ_UNAVAILABLE = "mailboxes.retention_tag_read_unavailable";
export const MAILFLOW_REPORT_UNAVAILABLE = "mailboxes.mailflow_report_unavailable";

/** get-mailboxes.ps1 and get-mailbox-permissions.ps1 cap a page at 999 rows (ValidateRange 1..999). */
const WORKER_MAX_PAGE = 999;
/** Upper bound on worker pages followed for one per-mailbox read; a mailbox has far fewer rows. */
const MAX_PERMISSION_PAGES = 50;
const MAX_POLICY_PAGES = 20;

export interface MailboxProviders {
  readonly mailboxes: MailboxesProvider;
  readonly mailboxWrite: MailboxWriteProvider;
  readonly mailboxSettings: MailboxSettingsProvider;
  readonly mailboxPermissions: MailboxPermissionsProvider;
  readonly mailboxPermissionsReport: MailboxPermissionsReportProvider;
  readonly mailboxReports: MailboxReportsProvider;
  readonly mailboxRules: MailboxRulesProvider;
  readonly retention: RetentionProvider;
  readonly vacationStore: VacationScheduleStore;
  readonly vacationApply: VacationApplyProvider;
  readonly deletedMailboxes: DeletedMailboxesProvider;
}

type Row = Record<string, unknown>;

interface MailboxesWorkerPage {
  readonly tenantId: string;
  readonly items: readonly Row[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
  readonly retrievedAt: string;
}

interface MailboxPermissionsWorkerPage {
  readonly tenantId: string;
  readonly items: readonly Row[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
  readonly retrievedAt: string;
}

interface PurviewRetentionWorkerPage {
  readonly tenantId: string;
  readonly items: readonly Row[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
  readonly retrievedAt: string;
}

interface DeletedMailboxesWorkerPage {
  readonly tenantId: string;
  readonly items: readonly Row[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
  readonly retrievedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** The workers emit an empty string, not null, when a page is the last one. */
function cursorOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mailboxNotFound(mailboxId: string): AppError {
  return new AppError(MAILBOX_NOT_FOUND, `mailbox '${mailboxId}' was not found`, 404, [
    { field: "mailboxId", reason: "not_found" },
  ]);
}

/** The mailbox workers fail with "NotFound: ..." or EXO's "couldn't be found" for an unknown mailbox. */
function isMailboxNotFound(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === WORKER_FAILED &&
    /NotFound|couldn't be found|could not be found|ManagementObjectNotFound/i.test(error.message)
  );
}

function sameIdentity(a: unknown, b: string): boolean {
  return typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The vacation schedule store over the shared connection. Migration 0025 creates
 * vacation_schedules; the db package's own repository is not exported from the
 * package index, so the store is implemented here against the same table.
 */
export function createSqliteVacationScheduleStore(db: Database.Database): VacationScheduleStore {
  function mapSchedule(row: Row): VacationSchedule {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      mailboxId: asString(row["mailboxId"]),
      startsAt: asString(row["startsAt"]),
      endsAt: asString(row["endsAt"]),
      oooMessage: asString(row["oooMessage"]),
      forwardTo: asNullableString(row["forwardTo"]),
      state: asString(row["state"]) as VacationScheduleState,
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  // Mirrors SqliteVacationScheduleRepository: every create and state change appends an
  // audit_events row in the same transaction, so apply and revert stay audited.
  function writeAuditEvent(
    action: string,
    schedule: VacationSchedule,
    before: VacationSchedule | null,
  ): void {
    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO audit_events
         (id, timestamp, actorUserId, actorType, tenantId, action, targetType, targetId, before, after, result, error, source, correlationId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      timestamp,
      null,
      "system",
      schedule.tenantId,
      action,
      "vacation_schedule",
      schedule.id,
      before === null ? null : JSON.stringify(before),
      JSON.stringify(schedule),
      "success",
      null,
      "request",
      null,
      timestamp,
    );
  }

  return {
    async listVacationSchedules(tenantId: string): Promise<VacationSchedule[]> {
      const rows = db
        .prepare("SELECT * FROM vacation_schedules WHERE tenantId = ? ORDER BY startsAt, id")
        .all(tenantId) as Row[];
      return rows.map(mapSchedule);
    },

    async getVacationSchedule(tenantId: string, scheduleId: string): Promise<VacationSchedule | undefined> {
      const row = db
        .prepare("SELECT * FROM vacation_schedules WHERE id = ? AND tenantId = ?")
        .get(scheduleId, tenantId) as Row | undefined;
      return row === undefined ? undefined : mapSchedule(row);
    },

    async createVacationSchedule(input: {
      id: string;
      tenantId: string;
      mailboxId: string;
      startsAt: string;
      endsAt: string;
      oooMessage: string;
      forwardTo: string | null;
      state: VacationScheduleState;
    }): Promise<VacationSchedule> {
      const createdAt = nowIso();
      const schedule: VacationSchedule = {
        id: input.id,
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        oooMessage: input.oooMessage,
        forwardTo: input.forwardTo,
        state: input.state,
        createdAt,
        updatedAt: createdAt,
      };
      db.transaction(() => {
        db.prepare(
          `INSERT INTO vacation_schedules
             (id, tenantId, mailboxId, startsAt, endsAt, oooMessage, forwardTo, state, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          schedule.id,
          schedule.tenantId,
          schedule.mailboxId,
          schedule.startsAt,
          schedule.endsAt,
          schedule.oooMessage,
          schedule.forwardTo,
          schedule.state,
          schedule.createdAt,
          schedule.updatedAt,
        );
        writeAuditEvent("vacation.schedule.create", schedule, null);
      })();
      const persisted = await this.getVacationSchedule(input.tenantId, input.id);
      if (persisted === undefined) throw new Error(`vacation schedule ${input.id} was not persisted`);
      return persisted;
    },

    async updateVacationSchedule(
      tenantId: string,
      scheduleId: string,
      update: { state: VacationScheduleState },
    ): Promise<VacationSchedule | undefined> {
      const existing = await this.getVacationSchedule(tenantId, scheduleId);
      if (existing === undefined) return undefined;
      const updated: VacationSchedule = { ...existing, state: update.state, updatedAt: nowIso() };
      db.transaction(() => {
        db.prepare("UPDATE vacation_schedules SET state = ?, updatedAt = ? WHERE id = ? AND tenantId = ?").run(
          updated.state,
          updated.updatedAt,
          scheduleId,
          tenantId,
        );
        writeAuditEvent("vacation.schedule.update", updated, existing);
      })();
      return updated;
    },
  };
}

export function createMailboxProviders(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
  db: Database.Database,
): MailboxProviders {
  const call = createTenantWorker(run, credentials);

  // get-mailboxes.ps1 reads its filters from the job envelope's `payload` and
  // requires schemaVersion v1, unlike the other mailbox entrypoints.
  const callMailboxesJob = (
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<MailboxesWorkerPage> =>
    call<MailboxesWorkerPage>("get-mailboxes.ps1", tenantId, { schemaVersion: "v1", payload });

  const mailboxListPayload = (filter: MailboxesFilter): Record<string, unknown> => ({
    search: filter.search ?? "",
    type: filter.type ?? "",
    hold: filter.hold === undefined ? "" : String(filter.hold),
    forwarding: filter.forwarding === undefined ? "" : String(filter.forwarding),
    archive: filter.archive === undefined ? "" : String(filter.archive),
    quotaPercent: filter.quotaPercent ?? 0,
    inactiveDays: filter.inactiveDays ?? 0,
    top: Math.min(filter.limit, WORKER_MAX_PAGE),
    cursor: filter.cursor ?? "",
  });

  const mailboxes: MailboxesProvider = {
    async listMailboxes(tenantId: string, filter: MailboxesFilter): Promise<MailboxesPage> {
      const page = await callMailboxesJob(tenantId, mailboxListPayload(filter));
      raiseWorkerError(page);
      return { ...(page as unknown as MailboxesPage), nextCursor: cursorOrNull(page.nextCursor) };
    },

    async getMailbox(tenantId: string, mailboxId: string): Promise<MailboxDetail | null> {
      let detail: MailboxesWorkerPage;
      try {
        detail = await callMailboxesJob(tenantId, { mailboxId });
      } catch (error) {
        // An unknown mailbox is a 404 (the route maps null), not a worker failure.
        if (isMailboxNotFound(error)) return null;
        throw error;
      }
      raiseWorkerError(detail);
      if (detail === null || detail === undefined || (detail as unknown as Row)["settings"] === undefined) {
        return null;
      }
      return detail as unknown as MailboxDetail;
    },
  };

  const mailboxWrite: MailboxWriteProvider = {
    createSharedMailbox: (tenantId, input: CreateSharedMailboxInput, preview: boolean) =>
      call<MailboxWriteResult | MailboxWritePlan>("set-mailbox.ps1", tenantId, {
        action: "create",
        displayName: input.displayName,
        ...(input.alias !== undefined ? { alias: input.alias } : {}),
        ...(input.primarySmtpAddress !== undefined ? { primarySmtpAddress: input.primarySmtpAddress } : {}),
        dryRun: preview,
        confirmed: !preview,
      }),

    convertToShared: (tenantId, mailboxId: string, _input: ConvertMailboxInput, preview: boolean) =>
      call<MailboxWriteResult | MailboxWritePlan>("set-mailbox.ps1", tenantId, {
        action: "convert",
        mailboxId,
        dryRun: preview,
        confirmed: !preview,
      }),
  };

  const mailboxSettings: MailboxSettingsProvider = {
    setMailboxSettings: (
      tenantId: string,
      mailboxId: string,
      input: MailboxSettingsInput,
      preview: boolean,
    ): Promise<MailboxSettingsResult | MailboxSettingsPlan> =>
      call<MailboxSettingsResult | MailboxSettingsPlan>("set-mailbox-settings.ps1", tenantId, {
        mailboxId,
        settings: input,
        dryRun: preview,
        confirmed: !preview,
      }),
  };

  const mailboxPermissions: MailboxPermissionsProvider = {
    async listPermissions(tenantId: string, mailboxId: string): Promise<MailboxPermissionsList> {
      // The worker reads only this mailbox (mailboxId in the job); the identity filter
      // below is a second guard so a row for another mailbox can never be returned.
      const rows: Row[] = [];
      let retrievedAt = nowIso();
      let cursor = "";
      for (let pages = 0; pages < MAX_PERMISSION_PAGES; pages += 1) {
        let page: MailboxPermissionsWorkerPage;
        try {
          page = await call<MailboxPermissionsWorkerPage>("get-mailbox-permissions.ps1", tenantId, {
            scope: "",
            mailboxId,
            top: WORKER_MAX_PAGE,
            cursor,
          });
        } catch (error) {
          if (isMailboxNotFound(error)) throw mailboxNotFound(mailboxId);
          throw error;
        }
        raiseWorkerError(page);
        rows.push(...page.items);
        retrievedAt = page.retrievedAt;
        const next = cursorOrNull(page.nextCursor);
        if (next === null) break;
        cursor = next;
        if (pages === MAX_PERMISSION_PAGES - 1) {
          throw new AppError(WORKER_FAILED, `mailbox '${mailboxId}' permissions exceed the page limit`, 502);
        }
      }
      const own = rows.filter(
        (item) => sameIdentity(item["mailboxId"], mailboxId) || sameIdentity(item["mailboxPrimarySmtp"], mailboxId),
      );
      const permissions = own
        .filter((item) => asString(item["scope"]) === "mailbox")
        .map((item) => ({
          scope: "mailbox" as const,
          permissionType: asString(item["permissionType"]) as "FullAccess" | "SendAs" | "SendOnBehalf",
          principal: asString(item["principal"]),
          accessRights: asArray<string>(item["accessRights"] as string | readonly string[] | undefined),
          automap: Boolean(item["automap"]),
          inherited: Boolean(item["inherited"]),
        }));
      const calendarPermissions = own
        .filter((item) => asString(item["scope"]) === "calendar")
        .map((item) => ({
          scope: "calendar" as const,
          permissionType: "Calendar" as const,
          principal: asString(item["principal"]),
          accessRights: asArray<string>(item["accessRights"] as string | readonly string[] | undefined),
          automap: false,
          inherited: false,
        }));
      return { tenantId, mailboxId, permissions, calendarPermissions, retrievedAt };
    },

    grantPermission: (
      tenantId: string,
      mailboxId: string,
      input: GrantMailboxPermissionInput,
      preview: boolean,
    ): Promise<MailboxPermissionResult | MailboxPermissionPlan> =>
      call<MailboxPermissionResult | MailboxPermissionPlan>("set-mailbox-permission.ps1", tenantId, {
        action: input.action,
        mailboxId,
        scope: input.scope,
        ...(input.permissionType !== undefined ? { permissionType: input.permissionType } : {}),
        principal: input.principal,
        ...(input.accessRights !== undefined ? { accessRights: input.accessRights } : {}),
        ...(input.automap !== undefined ? { automap: input.automap } : {}),
        dryRun: preview,
        confirmed: !preview,
      }),

    removePermission: (
      tenantId: string,
      mailboxId: string,
      input: RemoveMailboxPermissionInput,
      preview: boolean,
    ): Promise<MailboxPermissionResult | MailboxPermissionPlan> =>
      call<MailboxPermissionResult | MailboxPermissionPlan>("set-mailbox-permission.ps1", tenantId, {
        action: "remove",
        mailboxId,
        scope: input.scope,
        ...(input.permissionType !== undefined ? { permissionType: input.permissionType } : {}),
        principal: input.principal,
        dryRun: preview,
        confirmed: !preview,
      }),
  };

  // The tenant-wide report is one cursor-paged worker read (the worker already pages, filters
  // by scope and search, and emits the report row shape), not a per-mailbox fan-out.
  const mailboxPermissionsReport: MailboxPermissionsReportProvider = {
    async listMailboxPermissions(
      tenantId: string,
      filter: MailboxPermissionReportFilter,
    ): Promise<MailboxPermissionsReportPage> {
      const page = await call<MailboxPermissionsWorkerPage>("get-mailbox-permissions.ps1", tenantId, {
        scope: filter.scope ?? "",
        ...(filter.search !== undefined ? { search: filter.search } : {}),
        top: Math.min(filter.limit, WORKER_MAX_PAGE),
        cursor: filter.cursor ?? "",
      });
      raiseWorkerError(page);
      return {
        tenantId,
        items: page.items as unknown as readonly MailboxPermissionReportEntry[],
        nextCursor: cursorOrNull(page.nextCursor),
        totalCount: page.totalCount,
        retrievedAt: page.retrievedAt,
      };
    },
  };

  const mailboxReports: MailboxReportsProvider = {
    async getMailboxReport(
      tenantId: string,
      filter: MailboxReportFilter,
    ): Promise<{ rows: readonly Record<string, unknown>[]; nextCursor: string | null; retrievedAt: string }> {
      switch (filter.report) {
        case "permissions":
        case "calendarPermissions": {
          const page = await call<MailboxPermissionsWorkerPage>("get-mailbox-permissions.ps1", tenantId, {
            scope: filter.report === "permissions" ? "mailbox" : "calendar",
            ...(filter.mailboxId !== undefined ? { mailboxId: filter.mailboxId } : {}),
            ...(filter.search !== undefined ? { search: filter.search } : {}),
            top: Math.min(filter.limit, WORKER_MAX_PAGE),
            cursor: filter.cursor ?? "",
          });
          raiseWorkerError(page);
          return { rows: page.items, nextCursor: cursorOrNull(page.nextCursor), retrievedAt: page.retrievedAt };
        }
        case "statistics":
        case "activity":
        case "forwarding": {
          // The worker applies the cursor and page size itself (its cursor is the same
          // base64url row offset the BFF uses), so the cursor is forwarded once and the
          // worker's page is returned as is; paginating it again would skip a second time.
          const page = await callMailboxesJob(tenantId, mailboxListPayload(filter));
          raiseWorkerError(page);
          const rows = page.items.map((item) => {
            if (filter.report === "statistics") {
              return {
                id: item["id"],
                displayName: item["displayName"],
                primarySmtpAddress: item["primarySmtpAddress"],
                type: item["type"],
                quotaUsed: item["quotaUsed"],
                quotaPercent: item["quotaPercent"],
                archive: item["archive"],
                hold: item["hold"],
              };
            }
            if (filter.report === "activity") {
              return {
                id: item["id"],
                displayName: item["displayName"],
                primarySmtpAddress: item["primarySmtpAddress"],
                lastActivity: item["lastActivity"],
              };
            }
            return {
              id: item["id"],
              displayName: item["displayName"],
              primarySmtpAddress: item["primarySmtpAddress"],
              forwarding: item["forwarding"],
              forwardingTo: item["forwardingTo"],
              deliverToMailboxAndForward: item["deliverToMailboxAndForward"],
            };
          });
          return { rows, nextCursor: cursorOrNull(page.nextCursor), retrievedAt: page.retrievedAt };
        }
        // No worker entrypoint wraps the module's Get-MailFlowReport collector, so the
        // report is refused rather than answered with an empty (and falsely fresh) page.
        case "mailflow":
          throw new AppError(
            MAILFLOW_REPORT_UNAVAILABLE,
            "the mail-flow report is not available yet: no worker backs it",
            501,
          );
      }
    },
  };

  const mailboxRules: MailboxRulesProvider = {
    async listRules(tenantId: string, mailboxId: string): Promise<MailboxRulesListResponse> {
      const detail = await mailboxes.getMailbox(tenantId, mailboxId);
      if (detail === null) throw mailboxNotFound(mailboxId);
      return {
        tenantId,
        mailboxId,
        rules: asArray(detail.rules).map((rule) => ({ ...rule })),
        retrievedAt: detail.retrievedAt,
      };
    },

    createRule: (
      tenantId: string,
      mailboxId: string,
      input: CreateMailboxRuleInput,
      preview: boolean,
    ): Promise<MailboxRuleResult | MailboxRulePlan> =>
      call<MailboxRuleResult | MailboxRulePlan>("set-mailbox-rule.ps1", tenantId, {
        action: "create",
        mailboxId,
        name: input.name,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.forwardTo !== undefined ? { forwardTo: input.forwardTo } : {}),
        ...(input.forwardAsAttachmentTo !== undefined ? { forwardAsAttachmentTo: input.forwardAsAttachmentTo } : {}),
        ...(input.redirectTo !== undefined ? { redirectTo: input.redirectTo } : {}),
        ...(input.deleteMessage !== undefined ? { deleteMessage: input.deleteMessage } : {}),
        dryRun: preview,
        confirmed: !preview,
      }),

    editRule: (
      tenantId: string,
      mailboxId: string,
      ruleId: string,
      input: EditMailboxRuleInput,
      preview: boolean,
    ): Promise<MailboxRuleResult | MailboxRulePlan> =>
      call<MailboxRuleResult | MailboxRulePlan>("set-mailbox-rule.ps1", tenantId, {
        action: "edit",
        mailboxId,
        ruleId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.forwardTo !== undefined ? { forwardTo: input.forwardTo } : {}),
        ...(input.forwardAsAttachmentTo !== undefined ? { forwardAsAttachmentTo: input.forwardAsAttachmentTo } : {}),
        ...(input.redirectTo !== undefined ? { redirectTo: input.redirectTo } : {}),
        ...(input.deleteMessage !== undefined ? { deleteMessage: input.deleteMessage } : {}),
        dryRun: preview,
        confirmed: !preview,
      }),

    deleteRule: (tenantId: string, mailboxId: string, ruleId: string, preview: boolean) =>
      call<MailboxRuleResult | MailboxRulePlan>("set-mailbox-rule.ps1", tenantId, {
        action: "delete",
        mailboxId,
        ruleId,
        dryRun: preview,
        confirmed: !preview,
      }),
  };

  const retention: RetentionProvider = {
    async listPolicies(tenantId: string): Promise<RetentionPolicy[]> {
      // get-purview-retention.ps1 reads its filters from the envelope's `payload`; follow
      // its cursor until the policy set is exhausted rather than returning the first page.
      const policies: RetentionPolicy[] = [];
      let cursor = "";
      for (let pages = 0; pages < MAX_POLICY_PAGES; pages += 1) {
        const page = await call<PurviewRetentionWorkerPage>("get-purview-retention.ps1", tenantId, {
          schemaVersion: "v1",
          payload: { top: WORKER_MAX_PAGE, cursor },
        });
        raiseWorkerError(page);
        for (const item of page.items) {
          policies.push({
            id: asString(item["id"]),
            name: asString(item["name"]),
            enabled: asString(item["state"]) === "enabled",
            retrievedAt: page.retrievedAt,
          });
        }
        const next = cursorOrNull(page.nextCursor);
        if (next === null) return policies;
        cursor = next;
      }
      throw new AppError(WORKER_FAILED, "retention policies exceed the page limit", 502);
    },

    // No worker entrypoint reads retention tags (Get-RetentionPolicyTag) yet; an empty list
    // would be indistinguishable from a tenant with no tags, so the read is refused like
    // the writes below.
    listTags: (_tenantId: string): Promise<RetentionTag[]> => {
      throw new AppError(
        RETENTION_TAG_READ_UNAVAILABLE,
        "retention tag list is not available yet: no worker backs the read",
        501,
      );
    },

    // set-retention-tag.ps1 covers assign/assignBulk only; no worker creates or
    // edits the tags themselves yet, so those writes are refused with 501.
    createTag: (_tenantId: string, _input: CreateRetentionTagInput, _preview: boolean) => {
      throw new AppError(
        RETENTION_TAG_WRITE_UNAVAILABLE,
        "retention tag create is not available yet: no worker backs the write",
        501,
      );
    },

    editTag: (_tenantId: string, _tagId: string, _input: EditRetentionTagInput, _preview: boolean) => {
      throw new AppError(
        RETENTION_TAG_WRITE_UNAVAILABLE,
        "retention tag edit is not available yet: no worker backs the write",
        501,
      );
    },

    assignTag: (tenantId: string, input: AssignRetentionTagInput, preview: boolean) =>
      call<RetentionAssignResult | RetentionAssignPlan>("set-retention-tag.ps1", tenantId, {
        action: "assign",
        tagId: input.tagId,
        ...(input.policyId !== undefined ? { policyId: input.policyId } : {}),
        mailboxId: input.mailboxId,
        dryRun: preview,
        confirmed: !preview,
      }),

    assignTagBulk: (tenantId: string, input: AssignRetentionTagBulkInput, preview: boolean) =>
      call<RetentionAssignBulkResult | RetentionAssignBulkPlan>("set-retention-tag.ps1", tenantId, {
        action: "assignBulk",
        tagId: input.tagId,
        ...(input.policyId !== undefined ? { policyId: input.policyId } : {}),
        mailboxIds: input.mailboxIds,
        dryRun: preview,
        confirmed: !preview,
      }),
  };

  const vacationApply: VacationApplyProvider = {
    applyVacationPhase: (tenantId: string, schedule: VacationSchedule, phase: VacationPhase) => {
      const revertNotAfter = new Date(Date.parse(schedule.endsAt) + 24 * 3600 * 1000).toISOString();
      return call<VacationApplyResult & { alertEvent?: VacationApplyResult["alert"] }>("invoke-vacation-schedule.ps1", tenantId, {
        scheduleId: schedule.id,
        phase,
        mailboxId: schedule.mailboxId,
        startsAt: schedule.startsAt,
        endsAt: schedule.endsAt,
        oooMessage: schedule.oooMessage,
        ...(schedule.forwardTo !== null ? { forwardTo: schedule.forwardTo } : {}),
        notAfter: phase === "enable" ? schedule.endsAt : revertNotAfter,
        confirmed: true,
      }).then(({ alertEvent, ...result }) => {
        // The worker names the failed-revert alert `alertEvent`; the route type calls it `alert`.
        raiseWorkerError(result);
        return alertEvent === undefined || result.alert !== undefined ? result : { ...result, alert: alertEvent };
      });
    },
  };

  const deletedMailboxes: DeletedMailboxesProvider = {
    async listDeletedMailboxes(tenantId: string, filter: DeletedMailboxesFilter): Promise<DeletedMailboxesPage> {
      const page = await call<DeletedMailboxesWorkerPage>("restore-mailbox.ps1", tenantId, {
        action: "list",
        ...(filter.search !== undefined ? { search: filter.search } : {}),
        top: Math.min(filter.limit, WORKER_MAX_PAGE),
        cursor: filter.cursor ?? "",
      });
      raiseWorkerError(page);
      return { ...(page as unknown as DeletedMailboxesPage), nextCursor: cursorOrNull(page.nextCursor) };
    },

    async restoreMailbox(
      tenantId: string,
      mailboxId: string,
      _input: RestoreDeletedMailboxInput,
      preview: boolean,
    ): Promise<DeletedMailboxRestoreResult | DeletedMailboxRestorePlan> {
      try {
        return await call<DeletedMailboxRestoreResult | DeletedMailboxRestorePlan>("restore-mailbox.ps1", tenantId, {
          action: "restore",
          mailboxId,
          dryRun: preview,
          confirmed: !preview,
        });
      } catch (error) {
        // The worker refuses a mailbox outside the soft-deleted set with "NotFound: ...";
        // the route contract for that is a structured 404, not a worker 502.
        if (isMailboxNotFound(error)) throw notSoftDeletedError(mailboxId);
        throw error;
      }
    },
  };

  return {
    mailboxes,
    mailboxWrite,
    mailboxSettings,
    mailboxPermissions,
    mailboxPermissionsReport,
    mailboxReports,
    mailboxRules,
    retention,
    vacationStore: createSqliteVacationScheduleStore(db),
    vacationApply,
    deletedMailboxes,
  };
}
