// EPIC-023 Contacts & Resources worker-backed adapters (T-0853).
//
// Each provider turns a route's typed call into a T-0007 v1 job envelope for the
// tenant (createEnvelopeWorker adds schemaVersion, correlationId, credential block,
// and maps non-zero exits to 502s) and maps the worker's JSON onto the route's
// contract. Contacts and resources stay live in EXO; contact templates persist
// in SQLite and deploy one target per worker call so every tenant uses its own
// credential block and partial failures are reported per target.
import type { ContactTemplate } from "@m365-assess/db";
import { AppError } from "../errors.js";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  ContactItem,
  ContactsFilter,
  ContactsPage,
  ContactsProvider,
  ContactType,
} from "../routes/contacts.js";
import type {
  ContactAuditEvent,
  ContactCrudResult,
  ContactPlan,
  ContactsCrudProvider,
  CreateContactInput,
  EditContactInput,
} from "../routes/contacts-crud.js";
import type {
  ContactImportRowResult,
  ContactImportRowStatus,
  ContactImportSummary,
  ContactsImportInput,
  ContactsImportProvider,
  ContactsImportReport,
} from "../routes/contacts-import.js";
import type {
  ContactDeployPlan,
  ContactDeployResult,
  ContactDeployTarget,
  ContactTemplateDeployProvider,
} from "../routes/contact-templates-deploy.js";
import type {
  ResourceItem,
  ResourceKind,
  ResourceMember,
  ResourcesFilter,
  ResourcesPage,
  ResourcesProvider,
  ResourceType,
} from "../routes/resources.js";
import type {
  CreateResourceInput,
  EditResourceInput,
  MembershipInput,
  ResourceAuditEvent,
  ResourceCrudResult,
  ResourcePlan,
  ResourcesCrudProvider,
} from "../routes/resources-crud.js";
import {
  asArray,
  createEnvelopeWorker,
  raiseWorkerError,
  WORKER_FAILED,
  type WorkerRunner,
} from "./workers.js";

export const CONTACTS_WORKER = "get-contacts.ps1";
export const CONTACT_ACTION_WORKER = "invoke-contact-action.ps1";
export const CONTACTS_IMPORT_WORKER = "import-contacts.ps1";
export const CONTACT_TEMPLATE_DEPLOY_WORKER = "deploy-contact-template.ps1";
export const RESOURCES_WORKER = "get-resources.ps1";
export const RESOURCE_ACTION_WORKER = "invoke-resource-action.ps1";

/** Page reads in get-contacts.ps1 and get-resources.ps1 validate top in 1..999. */
const WORKER_MAX_PAGE = 999;

export interface ContactsResourcesAdapters {
  readonly contacts: ContactsProvider;
  readonly contactsCrud: ContactsCrudProvider;
  readonly contactsImport: ContactsImportProvider;
  readonly contactTemplateDeploy: ContactTemplateDeployProvider;
  readonly resources: ResourcesProvider;
  readonly resourcesCrud: ResourcesCrudProvider;
}

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function asRecordOrNull(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : null;
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

function clampWorkerTop(limit: number): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(Math.trunc(limit), WORKER_MAX_PAGE));
}

function throwIfFailed(record: Row, domain: "contacts" | "resources", action: string): void {
  if (record["status"] !== "failed") return;
  const message = asString(record["error"], `${domain} ${action} failed`);
  if (/was not found/i.test(message)) {
    throw new AppError(`${domain}.not_found`, message, 404);
  }
  if (domain === "resources" && /already a member/i.test(message)) {
    throw new AppError("resources.member_exists", message, 409);
  }
  if (domain === "resources" && /not a member/i.test(message)) {
    throw new AppError("resources.member_not_found", message, 404);
  }
  throw new AppError(WORKER_FAILED, message, 502);
}

function mapContactItem(entry: unknown): ContactItem {
  const row = asRecord(entry);
  const rawType = asString(row["type"], "mailContact");
  const type: ContactType = rawType === "mailUser" ? "mailUser" : "mailContact";
  return {
    id: asString(row["id"]),
    displayName: nullableString(row["displayName"]),
    externalAddress: nullableString(row["externalAddress"]),
    type,
    hiddenFromGal: row["hiddenFromGal"] === true,
    lastModified: nullableString(row["lastModified"]),
  };
}

function mapContactPlan(
  record: Row,
  fallbackAction: ContactPlan["action"],
  fallbackContactId: string | undefined,
  preview: boolean,
): ContactPlan {
  const resolvedId = nullableString(record["contactId"]) ?? fallbackContactId;
  return {
    action: asString(record["action"], fallbackAction) as ContactPlan["action"],
    ...(resolvedId !== undefined ? { contactId: resolvedId } : {}),
    targetName: asString(record["targetName"], resolvedId ?? ""),
    ...(record["before"] !== undefined ? { before: record["before"] as Record<string, unknown> | null } : {}),
    ...(record["after"] !== undefined ? { after: record["after"] as Record<string, unknown> | null } : {}),
    diff: asArray(record["diff"]).map((entry) => String(entry)),
    valid: record["valid"] !== false,
    dryRun: typeof record["dryRun"] === "boolean" ? record["dryRun"] : preview,
    requiresConfirmation:
      typeof record["requiresConfirmation"] === "boolean"
        ? record["requiresConfirmation"]
        : fallbackAction === "delete",
  };
}

function mapResourceMember(entry: unknown): ResourceMember {
  const row = asRecord(entry);
  return {
    name: nullableString(row["name"]),
    primarySmtpAddress: asString(row["primarySmtpAddress"]),
  };
}

function mapResourceItem(entry: unknown): ResourceItem {
  const row = asRecord(entry);
  const rawType = asString(row["type"], "room");
  const type: ResourceType =
    rawType === "equipment" || rawType === "roomlist" ? rawType : "room";
  return {
    id: asString(row["id"]),
    name: nullableString(row["name"]),
    primarySmtpAddress: asString(row["primarySmtpAddress"]),
    capacity: typeof row["capacity"] === "number" && Number.isFinite(row["capacity"]) ? row["capacity"] : null,
    location: nullableString(row["location"]),
    type,
    hidden: row["hidden"] === true,
    members: asArray(row["members"]).map(mapResourceMember),
  };
}

function mapResourcePlan(
  record: Row,
  fallbackAction: ResourcePlan["action"],
  fallbackResourceId: string | undefined,
  preview: boolean,
): ResourcePlan {
  const resolvedId = nullableString(record["resourceId"]) ?? fallbackResourceId;
  return {
    action: asString(record["action"], fallbackAction) as ResourcePlan["action"],
    ...(resolvedId !== undefined ? { resourceId: resolvedId } : {}),
    targetName: asString(record["targetName"], resolvedId ?? ""),
    ...(record["before"] !== undefined ? { before: record["before"] as Record<string, unknown> | null } : {}),
    ...(record["after"] !== undefined ? { after: record["after"] as Record<string, unknown> | null } : {}),
    diff: asArray(record["diff"]).map((entry) => String(entry)),
    valid: record["valid"] !== false,
    dryRun: typeof record["dryRun"] === "boolean" ? record["dryRun"] : preview,
    requiresConfirmation:
      typeof record["requiresConfirmation"] === "boolean"
        ? record["requiresConfirmation"]
        : fallbackAction === "delete",
  };
}

function mapImportRow(entry: unknown): ContactImportRowResult {
  const row = asRecord(entry);
  return {
    row: asNumber(row["row"], 0),
    displayName: asString(row["displayName"]),
    externalAddress: asString(row["externalAddress"]),
    status: asString(row["status"], "failed") as ContactImportRowStatus,
    reason: nullableString(row["reason"]),
    contactId: nullableString(row["contactId"]),
  };
}

export function createContactsResourcesAdapters(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
): ContactsResourcesAdapters {
  const envelope = createEnvelopeWorker(run, credentials);

  async function runContactAction(
    tenantId: string,
    action: ContactPlan["action"],
    payloadFields: Row,
    preview: boolean,
    contactId?: string,
  ): Promise<ContactCrudResult | ContactPlan> {
    const result = await envelope<unknown>(CONTACT_ACTION_WORKER, tenantId, {
      action,
      ...(contactId !== undefined ? { contactId } : {}),
      ...payloadFields,
      dryRun: preview,
      confirm: !preview,
    });
    raiseWorkerError(result);
    const record = asRecord(result);
    throwIfFailed(record, "contacts", action);
    if (preview) {
      return mapContactPlan(record, action, contactId, true);
    }
    return {
      success: record["success"] !== false,
      plan: mapContactPlan(asRecord(record["plan"]), action, contactId, false),
      ...(record["result"] !== undefined && record["result"] !== null
        ? { result: record["result"] as Record<string, unknown> }
        : {}),
      ...(record["auditEvent"] !== undefined && record["auditEvent"] !== null
        ? { auditEvent: record["auditEvent"] as ContactAuditEvent }
        : {}),
    };
  }

  async function runResourceAction(
    tenantId: string,
    kind: string,
    action: ResourcePlan["action"],
    payloadFields: Row,
    preview: boolean,
    resourceId?: string,
  ): Promise<ResourceCrudResult | ResourcePlan> {
    const result = await envelope<unknown>(RESOURCE_ACTION_WORKER, tenantId, {
      kind,
      action,
      ...(resourceId !== undefined ? { resourceId } : {}),
      ...payloadFields,
      dryRun: preview,
      confirm: !preview,
    });
    raiseWorkerError(result);
    const record = asRecord(result);
    throwIfFailed(record, "resources", action);
    if (preview) {
      return mapResourcePlan(record, action, resourceId, true);
    }
    return {
      success: record["success"] !== false,
      plan: mapResourcePlan(asRecord(record["plan"]), action, resourceId, false),
      ...(record["result"] !== undefined && record["result"] !== null
        ? { result: record["result"] as Record<string, unknown> }
        : {}),
      ...(record["auditEvent"] !== undefined && record["auditEvent"] !== null
        ? { auditEvent: record["auditEvent"] as ResourceAuditEvent }
        : {}),
    };
  }

  const contacts: ContactsProvider = {
    async listContacts(tenantId: string, filter: ContactsFilter): Promise<ContactsPage> {
      const result = await envelope<unknown>(CONTACTS_WORKER, tenantId, {
        ...(filter.search ? { search: filter.search } : {}),
        ...(filter.type ? { type: filter.type } : {}),
        ...(filter.hidden !== undefined ? { hidden: String(filter.hidden) } : {}),
        top: clampWorkerTop(filter.limit),
        ...(filter.cursor ? { cursor: filter.cursor } : {}),
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      const items = asArray(record["items"]).map(mapContactItem);
      return {
        tenantId: asString(record["tenantId"], tenantId),
        totalCount: asNumber(record["totalCount"], items.length),
        items,
        nextCursor: nullableString(record["nextCursor"]),
      };
    },
  };

  const contactsCrud: ContactsCrudProvider = {
    createContact: (tenantId: string, input: CreateContactInput, preview: boolean) =>
      runContactAction(
        tenantId,
        "create",
        {
          displayName: input.displayName,
          externalAddress: input.externalAddress,
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.hiddenFromGal !== undefined ? { hiddenFromGal: input.hiddenFromGal } : {}),
        },
        preview,
      ),

    editContact: (tenantId: string, contactId: string, input: EditContactInput, preview: boolean) =>
      runContactAction(
        tenantId,
        "edit",
        {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.externalAddress !== undefined ? { externalAddress: input.externalAddress } : {}),
          ...(input.hiddenFromGal !== undefined ? { hiddenFromGal: input.hiddenFromGal } : {}),
        },
        preview,
        contactId,
      ),

    hideFromGal: (tenantId: string, contactId: string, preview: boolean) =>
      runContactAction(tenantId, "hideFromGal", {}, preview, contactId),

    deleteContact: (tenantId: string, contactId: string, preview: boolean) =>
      runContactAction(tenantId, "delete", {}, preview, contactId),
  };

  const contactsImport: ContactsImportProvider = {
    async importContacts(tenantId: string, input: ContactsImportInput): Promise<ContactsImportReport> {
      const result = await envelope<unknown>(CONTACTS_IMPORT_WORKER, tenantId, {
        ...(input.csv !== undefined ? { csv: input.csv } : {}),
        ...(input.rows !== undefined ? { rows: [...input.rows] } : {}),
        preview: input.preview,
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      const rows = asArray(record["rows"]).map(mapImportRow);
      const rawSummary = asRecord(record["summary"]);
      const summary: ContactImportSummary = {
        total: asNumber(rawSummary["total"], rows.length),
        created: asNumber(rawSummary["created"], 0),
        skippedDuplicate: asNumber(rawSummary["skippedDuplicate"], 0),
        invalid: asNumber(rawSummary["invalid"], 0),
        failed: asNumber(rawSummary["failed"], 0),
        ready: asNumber(rawSummary["ready"], 0),
      };
      return {
        tenantId: asString(record["tenantId"], tenantId),
        preview: typeof record["preview"] === "boolean" ? record["preview"] : input.preview,
        rows,
        summary,
      };
    },
  };

  const contactTemplateDeploy: ContactTemplateDeployProvider = {
    async planDeploy(
      template: ContactTemplate,
      targets: readonly ContactDeployTarget[],
    ): Promise<readonly ContactDeployPlan[]> {
      const plans: ContactDeployPlan[] = [];
      for (const target of targets) {
        try {
          const output = await envelope<unknown>(CONTACT_TEMPLATE_DEPLOY_WORKER, target.tenantId, {
            template,
            targets: [target],
            variables: target.variables,
            dryRun: true,
          });
          raiseWorkerError(output);
          const record = asRecord(output);
          const rows = asArray(record["targets"]);
          const row = rows.length > 0 ? asRecord(rows[0]) : record;
          const type = asString(row["type"], "mailContact");
          const displayName = nullableString(row["displayName"]);
          const externalAddress = nullableString(row["externalAddress"]);
          const valid = typeof row["valid"] === "boolean" ? row["valid"] : row["status"] === "ready";
          const error = nullableString(row["reason"] ?? row["error"]);
          const workerDiff = asArray(row["diff"]).map((entry) => String(entry));
          const diff =
            workerDiff.length > 0
              ? workerDiff
              : valid
                ? [`Create ${type} contact '${displayName ?? externalAddress ?? target.tenantId}'`]
                : [];
          plans.push({
            tenantId: asString(row["tenantId"], target.tenantId),
            displayName,
            externalAddress,
            type,
            diff,
            valid,
            error,
          });
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          plans.push({
            tenantId: target.tenantId,
            displayName: null,
            externalAddress: null,
            type: "mailContact",
            diff: [],
            valid: false,
            error: error.message,
          });
        }
      }
      return plans;
    },

    async executeDeploy(
      template: ContactTemplate,
      targets: readonly ContactDeployTarget[],
      createdBy?: string,
    ): Promise<readonly ContactDeployResult[]> {
      const actor = createdBy ?? "system";
      const results: ContactDeployResult[] = [];
      for (const target of targets) {
        try {
          const output = await envelope<unknown>(CONTACT_TEMPLATE_DEPLOY_WORKER, target.tenantId, {
            template,
            targets: [target],
            variables: target.variables,
            dryRun: false,
            actor,
          });
          raiseWorkerError(output);
          const record = asRecord(output);
          const rows = asArray(record["targets"]);
          const row = rows.length > 0 ? asRecord(rows[0]) : record;
          const auditEvents = asArray(record["auditEvents"]);
          const auditEvent =
            asRecordOrNull(row["auditEvent"]) ??
            (auditEvents.length > 0 ? asRecordOrNull(auditEvents[0]) : null);
          const created = row["status"] === "created";
          results.push({
            tenantId: asString(row["tenantId"], target.tenantId),
            status: created ? "created" : "failed",
            displayName: nullableString(row["displayName"]),
            externalAddress: nullableString(row["externalAddress"]),
            contactId: created ? nullableString(row["contactId"]) : null,
            error: created ? null : nullableString(row["reason"] ?? row["error"]) ?? "template deploy failed",
            auditEvent,
          });
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          results.push({
            tenantId: target.tenantId,
            status: "failed",
            displayName: null,
            externalAddress: null,
            contactId: null,
            error: error.message,
            auditEvent: null,
          });
        }
      }
      return results;
    },
  };

  const resources: ResourcesProvider = {
    async listResources(
      tenantId: string,
      kind: ResourceKind,
      filter: ResourcesFilter,
    ): Promise<ResourcesPage> {
      const result = await envelope<unknown>(RESOURCES_WORKER, tenantId, {
        kind,
        ...(filter.search ? { search: filter.search } : {}),
        top: clampWorkerTop(filter.limit),
        ...(filter.cursor ? { cursor: filter.cursor } : {}),
      });
      raiseWorkerError(result);
      const record = asRecord(result);
      const items = asArray(record["items"]).map(mapResourceItem);
      return {
        tenantId: asString(record["tenantId"], tenantId),
        kind: asString(record["kind"], kind) as ResourceKind,
        totalCount: asNumber(record["totalCount"], items.length),
        items,
        nextCursor: nullableString(record["nextCursor"]),
      };
    },
  };

  const resourcesCrud: ResourcesCrudProvider = {
    createResource: (tenantId: string, kind: string, input: CreateResourceInput, preview: boolean) =>
      runResourceAction(
        tenantId,
        kind,
        "create",
        {
          displayName: input.displayName,
          ...(input.capacity !== undefined && input.capacity !== null ? { capacity: input.capacity } : {}),
          ...(input.location !== undefined && input.location !== null ? { location: input.location } : {}),
          ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
        },
        preview,
      ),

    editResource: (
      tenantId: string,
      kind: string,
      resourceId: string,
      input: EditResourceInput,
      preview: boolean,
    ) =>
      runResourceAction(
        tenantId,
        kind,
        "edit",
        {
          ...(input.displayName !== undefined && input.displayName !== null
            ? { displayName: input.displayName }
            : {}),
          ...(input.capacity !== undefined && input.capacity !== null ? { capacity: input.capacity } : {}),
          ...(input.location !== undefined && input.location !== null ? { location: input.location } : {}),
          ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
        },
        preview,
        resourceId,
      ),

    addMember: (
      tenantId: string,
      kind: string,
      resourceId: string,
      input: MembershipInput,
      preview: boolean,
    ) =>
      runResourceAction(
        tenantId,
        kind,
        "addMember",
        { memberId: input.memberId },
        preview,
        resourceId,
      ),

    removeMember: (
      tenantId: string,
      kind: string,
      resourceId: string,
      input: MembershipInput,
      preview: boolean,
    ) =>
      runResourceAction(
        tenantId,
        kind,
        "removeMember",
        { memberId: input.memberId },
        preview,
        resourceId,
      ),

    deleteResource: (tenantId: string, kind: string, resourceId: string, preview: boolean) =>
      runResourceAction(tenantId, kind, "delete", {}, preview, resourceId),
  };

  return {
    contacts,
    contactsCrud,
    contactsImport,
    contactTemplateDeploy,
    resources,
    resourcesCrud,
  };
}
