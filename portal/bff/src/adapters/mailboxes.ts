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
import { paginate } from "../pagination.js";
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
  createMailboxPermissionsReportAdapter,
  type GrantMailboxPermissionInput,
  type MailboxPermissionPlan,
  type MailboxPermissionReportFilter,
  type MailboxPermissionResult,
  type MailboxPermissionsList,
  type MailboxPermissionsProvider,
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
import type {
  DeletedMailboxesFilter,
  DeletedMailboxesPage,
  DeletedMailboxesProvider,
  DeletedMailboxRestorePlan,
  DeletedMailboxRestoreResult,
  RestoreDeletedMailboxInput,
} from "../routes/deleted-mailboxes.js";
import { createTenantWorker, raiseWorkerError, type WorkerRunner } from "./workers.js";
import { AppError } from "../errors.js";

export const RETENTION_TAG_WRITE_UNAVAILABLE = "mailboxes.retention_tag_write_unavailable";

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
      db.prepare(
        `INSERT INTO vacation_schedules
           (id, tenantId, mailboxId, startsAt, endsAt, oooMessage, forwardTo, state, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.tenantId,
        input.mailboxId,
        input.startsAt,
        input.endsAt,
        input.oooMessage,
        input.forwardTo,
        input.state,
        createdAt,
        createdAt,
      );
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
      const updatedAt = nowIso();
      db.prepare("UPDATE vacation_schedules SET state = ?, updatedAt = ? WHERE id = ? AND tenantId = ?").run(
        update.state,
        updatedAt,
        scheduleId,
        tenantId,
      );
      return { ...existing, state: update.state, updatedAt };
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
    top: filter.limit,
    cursor: filter.cursor ?? "",
  });

  const mailboxes: MailboxesProvider = {
    async listMailboxes(tenantId: string, filter: MailboxesFilter): Promise<MailboxesPage> {
      const page = await callMailboxesJob(tenantId, mailboxListPayload(filter));
      raiseWorkerError(page);
      return page as unknown as MailboxesPage;
    },

    async getMailbox(tenantId: string, mailboxId: string): Promise<MailboxDetail | null> {
      const detail = await callMailboxesJob(tenantId, { mailboxId });
      raiseWorkerError(detail);
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
      const page = await call<MailboxPermissionsWorkerPage>("get-mailbox-permissions.ps1", tenantId, {
        scope: "",
        top: 999,
      });
      raiseWorkerError(page);
      const permissions = page.items
        .filter((item) => asString(item["scope"]) === "mailbox")
        .map((item) => ({
          scope: "mailbox" as const,
          permissionType: asString(item["permissionType"]) as "FullAccess" | "SendAs" | "SendOnBehalf",
          principal: asString(item["principal"]),
          accessRights: (item["accessRights"] as readonly string[] | undefined) ?? [],
          automap: Boolean(item["automap"]),
          inherited: Boolean(item["inherited"]),
        }));
      const calendarPermissions = page.items
        .filter((item) => asString(item["scope"]) === "calendar")
        .map((item) => ({
          scope: "calendar" as const,
          permissionType: "Calendar" as const,
          principal: asString(item["principal"]),
          accessRights: (item["accessRights"] as readonly string[] | undefined) ?? [],
          automap: false,
          inherited: false,
        }));
      return {
        tenantId,
        mailboxId,
        permissions,
        calendarPermissions,
        retrievedAt: page.retrievedAt,
      };
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

  const mailboxPermissionsReport: MailboxPermissionsReportProvider = createMailboxPermissionsReportAdapter({
    mailboxes,
    permissions: mailboxPermissions,
  });

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
            ...(filter.search !== undefined ? { search: filter.search } : {}),
            top: filter.limit,
            cursor: filter.cursor ?? "",
          });
          raiseWorkerError(page);
          return { rows: page.items, nextCursor: page.nextCursor, retrievedAt: page.retrievedAt };
        }
        case "statistics":
        case "activity":
        case "forwarding": {
          const page = await callMailboxesJob(tenantId, {
            ...mailboxListPayload({ ...filter, limit: 999 }),
            top: 999,
          });
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
          const page2 = paginate(rows, { cursor: filter.cursor, limit: filter.limit });
          return { rows: page2.items, nextCursor: page2.nextCursor, retrievedAt: page.retrievedAt };
        }
        // No worker entrypoint wraps the module's Get-MailFlowReport collector yet.
        case "mailflow":
          return { rows: [], nextCursor: null, retrievedAt: nowIso() };
      }
    },
  };

  const mailboxRules: MailboxRulesProvider = {
    async listRules(tenantId: string, mailboxId: string): Promise<MailboxRulesListResponse> {
      const detail = await mailboxes.getMailbox(tenantId, mailboxId);
      if (detail === null) {
        return { tenantId, mailboxId, rules: [], retrievedAt: nowIso() };
      }
      return {
        tenantId,
        mailboxId,
        rules: detail.rules.map((rule) => ({ ...rule })),
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
      const page = await call<PurviewRetentionWorkerPage>("get-purview-retention.ps1", tenantId, {
        schemaVersion: "v1",
        top: 999,
      });
      raiseWorkerError(page);
      return page.items.map((item) => ({
        id: asString(item["id"]),
        name: asString(item["name"]),
        enabled: asString(item["state"]) === "enabled",
        retrievedAt: page.retrievedAt,
      }));
    },

    // No worker entrypoint reads retention tags (Get-RetentionComplianceTag) yet.
    async listTags(_tenantId: string): Promise<RetentionTag[]> {
      return [];
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
      return call<VacationApplyResult>("invoke-vacation-schedule.ps1", tenantId, {
        scheduleId: schedule.id,
        phase,
        mailboxId: schedule.mailboxId,
        startsAt: schedule.startsAt,
        endsAt: schedule.endsAt,
        oooMessage: schedule.oooMessage,
        ...(schedule.forwardTo !== null ? { forwardTo: schedule.forwardTo } : {}),
        notAfter: phase === "enable" ? schedule.endsAt : revertNotAfter,
        confirmed: true,
      });
    },
  };

  const deletedMailboxes: DeletedMailboxesProvider = {
    async listDeletedMailboxes(tenantId: string, filter: DeletedMailboxesFilter): Promise<DeletedMailboxesPage> {
      const page = await call<DeletedMailboxesWorkerPage>("restore-mailbox.ps1", tenantId, {
        action: "list",
        ...(filter.search !== undefined ? { search: filter.search } : {}),
        top: filter.limit,
        cursor: filter.cursor ?? "",
      });
      raiseWorkerError(page);
      return page as unknown as DeletedMailboxesPage;
    },

    restoreMailbox: (
      tenantId: string,
      mailboxId: string,
      _input: RestoreDeletedMailboxInput,
      preview: boolean,
    ): Promise<DeletedMailboxRestoreResult | DeletedMailboxRestorePlan> =>
      call<DeletedMailboxRestoreResult | DeletedMailboxRestorePlan>("restore-mailbox.ps1", tenantId, {
        action: "restore",
        mailboxId,
        dryRun: preview,
        confirmed: !preview,
      }),
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
