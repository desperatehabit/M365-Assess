// EPIC-026 Teams & Voice worker-backed providers (T-0856).
//
// The route factories were written against provider seams but never mounted, and
// no adapter bound them to the PowerShell workers. This module does that:
//
//   teams      get-teams.ps1            (flat job: visibility/archived/from/to/top/cursor)
//   activity   get-teams-activity.ps1   (flat job: period/startDate/endDate)
//   lifecycle  invoke-team-action.ps1   (top-level action; payload team fields)
//   lis        invoke-lis-location.ps1  (flat job: action and civic fields)
//   voice      invoke-teams-voice.ps1   (flat job: action/number/target/policy)
//   create     new-team.ps1             (T-0007 envelope; used by the create route's queue)
//
// Every call signs in through the tenant credential block (createTenantWorker) so
// the BFF never calls Graph itself. Team templates and operation records persist
// through the shared repository; team/voice/LIS reads stay live in Graph.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  LisLocationItem,
  LisLocationsListResponse,
  LisLocationsProvider,
} from "../routes/teams-lis.js";
import type {
  TeamItem,
  TeamsFilter,
  TeamsPage,
  TeamsProvider,
} from "../routes/teams.js";
import type {
  TeamsActivityData,
  TeamsActivityFilter,
  TeamsActivityProvider,
} from "../routes/teams-activity.js";
import type {
  TeamLifecycleInput,
  TeamLifecyclePlan,
  TeamOperationResult,
  TeamsLifecycleProvider,
} from "../routes/teams-lifecycle.js";
import type {
  AssignVoiceNumberInput,
  AssignVoicePolicyInput,
  TeamsVoiceLicenseState,
  TeamsVoicePlan,
  TeamsVoiceProvider,
  TeamsVoiceResult,
  VoiceNumber,
} from "../routes/teams-voice.js";
import {
  asArray,
  createTenantWorker,
  raiseWorkerError,
  type WorkerRunner,
} from "./workers.js";

export interface TeamsProviders {
  readonly teams: TeamsProvider;
  readonly activity: TeamsActivityProvider;
  readonly lifecycle: TeamsLifecycleProvider;
  readonly lis: LisLocationsProvider;
  readonly voice: TeamsVoiceProvider;
  /** `queue.enqueue` for the team create route: runs new-team.ps1 and returns its job id. */
  readonly enqueueCreate: (envelope: JobEnvelope) => Promise<string>;
  /** `queue.enqueue` for the LIS write routes: runs invoke-lis-location.ps1. */
  readonly enqueueLis: (envelope: JobEnvelope) => Promise<string>;
}

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
}

function cursorOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function mapTeamsPage(value: unknown, tenantId: string): TeamsPage {
  const record = asRecord(value);
  return {
    tenantId: asString(record["tenantId"], tenantId),
    totalCount: asNumber(record["totalCount"], asArray(record["items"]).length),
    items: asArray(record["items"]) as readonly TeamItem[],
    nextCursor: cursorOrNull(record["nextCursor"]),
  };
}

function mapActivity(value: unknown, tenantId: string): TeamsActivityData {
  const record = asRecord(value);
  const sources = asRecord(record["sources"]);
  return {
    tenantId: asString(record["tenantId"], tenantId),
    generatedAt: asString(record["generatedAt"]),
    period: asString(record["period"], "D7"),
    startDate: typeof record["startDate"] === "string" ? record["startDate"] : null,
    endDate: typeof record["endDate"] === "string" ? record["endDate"] : null,
    teams: asArray(record["teams"]) as TeamsActivityData["teams"],
    users: asArray(record["users"]) as TeamsActivityData["users"],
    sources: {
      teams: asString(sources["teams"]),
      users: asString(sources["users"]),
    },
  };
}

function lifecyclePayload(teamId: string, input: TeamLifecycleInput, preview: boolean): Row {
  return {
    teamId,
    ...(input.changes !== undefined ? { changes: input.changes } : {}),
    ...(input.newName !== undefined ? { newName: input.newName } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    ...(input.partsToClone !== undefined ? { partsToClone: input.partsToClone } : {}),
    ...(input.shouldSetSpoSiteReadOnlyForMembers !== undefined
      ? { shouldSetSpoSiteReadOnlyForMembers: input.shouldSetSpoSiteReadOnlyForMembers }
      : {}),
    dryRun: preview,
    confirm: !preview && input.confirm === true,
    ...(input.confirmName !== undefined ? { confirmName: input.confirmName } : {}),
  };
}

function mapLicense(value: unknown): TeamsVoiceLicenseState {
  const record = asRecord(value);
  return {
    licensed: record["licensed"] === true || record["Licensed"] === true,
    missingPlans: asArray(record["missingPlans"] ?? record["MissingPlans"]).map((entry) => String(entry)),
    activePlans: asArray(record["activePlans"] ?? record["ActivePlans"]).map((entry) => String(entry)),
  };
}

export function createTeamsProviders(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
): TeamsProviders {
  const call = createTenantWorker(run, credentials);

  const teams: TeamsProvider = {
    async listTeams(tenantId: string, filter: TeamsFilter): Promise<TeamsPage> {
      const result = await call<unknown>("get-teams.ps1", tenantId, {
        visibility: filter.visibility ?? "",
        archived: filter.archived === undefined ? "" : String(filter.archived),
        from: filter.from ?? "",
        to: filter.to ?? "",
        top: filter.limit,
        cursor: filter.cursor ?? "",
      });
      raiseWorkerError(result);
      return mapTeamsPage(result, tenantId);
    },
  };

  const activity: TeamsActivityProvider = {
    async getActivity(tenantId: string, filter: TeamsActivityFilter): Promise<TeamsActivityData> {
      const result = await call<unknown>("get-teams-activity.ps1", tenantId, {
        period: filter.period,
        ...(filter.startDate !== undefined ? { startDate: filter.startDate } : {}),
        ...(filter.endDate !== undefined ? { endDate: filter.endDate } : {}),
      });
      raiseWorkerError(result);
      return mapActivity(result, tenantId);
    },
  };

  const lifecycleCall = (
    tenantId: string,
    action: "edit" | "archive" | "clone" | "delete",
    teamId: string,
    input: TeamLifecycleInput,
    preview: boolean,
  ): Promise<TeamOperationResult | TeamLifecyclePlan> =>
    call<TeamOperationResult | TeamLifecyclePlan>("invoke-team-action.ps1", tenantId, {
      action,
      correlationId: randomUUID(),
      payload: lifecyclePayload(teamId, input, preview),
    });

  const lifecycle: TeamsLifecycleProvider = {
    editTeam: (tenantId, teamId, input, preview) => lifecycleCall(tenantId, "edit", teamId, input, preview),
    archiveTeam: (tenantId, teamId, input, preview) =>
      lifecycleCall(tenantId, "archive", teamId, input, preview),
    cloneTeam: (tenantId, teamId, input, preview) => lifecycleCall(tenantId, "clone", teamId, input, preview),
    deleteTeam: (tenantId, teamId, input, preview) => lifecycleCall(tenantId, "delete", teamId, input, preview),
  };

  const listLocations = async (tenantId: string): Promise<LisLocationsListResponse> => {
    const result = await call<unknown>("invoke-lis-location.ps1", tenantId, { action: "list" });
    raiseWorkerError(result);
    const record = asRecord(result);
    const items = asArray(record["items"]) as readonly LisLocationItem[];
    return {
      tenantId: asString(record["tenantId"], tenantId),
      totalCount: asNumber(record["totalCount"], items.length),
      items,
    };
  };

  const lis: LisLocationsProvider = {
    listLocations,
    async getLocation(tenantId: string, locationId: string): Promise<LisLocationItem | undefined> {
      const list = await listLocations(tenantId);
      return list.items.find((item) => item.id === locationId);
    },
  };

  const voiceList = async (
    tenantId: string,
  ): Promise<{ license: TeamsVoiceLicenseState; numbers: VoiceNumber[] }> => {
    const result = await call<unknown>("invoke-teams-voice.ps1", tenantId, { action: "list" });
    raiseWorkerError(result);
    const record = asRecord(result);
    return {
      license: mapLicense(record["license"]),
      numbers: asArray(record["numbers"]) as VoiceNumber[],
    };
  };

  const voice: TeamsVoiceProvider = {
    async getLicenseState(tenantId: string): Promise<TeamsVoiceLicenseState> {
      return (await voiceList(tenantId)).license;
    },

    async listNumbers(
      tenantId: string,
    ): Promise<{ license: TeamsVoiceLicenseState; numbers: VoiceNumber[] }> {
      return voiceList(tenantId);
    },

    assignNumber: (tenantId, input: AssignVoiceNumberInput, preview: boolean) =>
      call<TeamsVoiceResult | TeamsVoicePlan>("invoke-teams-voice.ps1", tenantId, {
        action: "assign",
        phoneNumber: input.phoneNumber,
        targetId: input.targetId,
        dryRun: preview,
        confirmed: !preview,
      }),

    releaseNumber: (tenantId, numberId, preview) =>
      call<TeamsVoiceResult | TeamsVoicePlan>("invoke-teams-voice.ps1", tenantId, {
        action: "release",
        numberId,
        dryRun: preview,
        confirmed: !preview,
      }),

    assignPolicy: (tenantId, input: AssignVoicePolicyInput, preview: boolean) =>
      call<TeamsVoiceResult | TeamsVoicePlan>("invoke-teams-voice.ps1", tenantId, {
        action: "policy",
        policyId: input.policyId,
        targetId: input.targetId,
        dryRun: preview,
        confirmed: !preview,
      }),
  };

  // The create route builds the resolved plan and queues a remediation envelope.
  // There is no remediation dispatcher for team creates, so this shim maps that
  // envelope onto new-team.ps1 and returns the envelope's job id.
  const enqueueCreate = async (envelope: JobEnvelope): Promise<string> => {
    const payload = asRecord(envelope.payload);
    const result = await call<unknown>("new-team.ps1", envelope.tenantId, {
      schemaVersion: "v1",
      correlationId: envelope.correlationId,
      payload: {
        team: {
          name: asString(payload["name"]),
          owners: asArray(payload["owners"]).map((entry) => String(entry)),
          members: asArray(payload["members"]).map((entry) => String(entry)),
          visibility: asString(payload["visibility"], "private"),
          settings: asRecord(payload["settings"]),
        },
        dryRun: false,
        ...(payload["actor"] !== undefined ? { actor: payload["actor"] } : {}),
      },
    });
    raiseWorkerError(result);
    return envelope.jobId;
  };

  // The LIS write routes build a remediation envelope carrying the action and
  // civic fields; map it onto invoke-lis-location.ps1.
  const enqueueLis = async (envelope: JobEnvelope): Promise<string> => {
    const payload = asRecord(envelope.payload);
    const action = asString(payload["action"]);
    const result = await call<unknown>("invoke-lis-location.ps1", envelope.tenantId, {
      action,
      ...(payload["locationId"] !== undefined ? { locationId: payload["locationId"] } : {}),
      ...(payload["displayName"] !== undefined ? { displayName: payload["displayName"] } : {}),
      ...(payload["street"] !== undefined ? { street: payload["street"] } : {}),
      ...(payload["city"] !== undefined ? { city: payload["city"] } : {}),
      ...(payload["state"] !== undefined ? { state: payload["state"] } : {}),
      ...(payload["country"] !== undefined ? { country: payload["country"] } : {}),
      ...(payload["postalCode"] !== undefined ? { postalCode: payload["postalCode"] } : {}),
      ...(payload["companyName"] !== undefined ? { companyName: payload["companyName"] } : {}),
      // The worker re-checks the delete confirmation against the display name.
      ...(action === "delete" ? { confirmName: payload["displayName"] } : {}),
      dryRun: false,
    });
    raiseWorkerError(result);
    return envelope.jobId;
  };

  return { teams, activity, lifecycle, lis, voice, enqueueCreate, enqueueLis };
}
