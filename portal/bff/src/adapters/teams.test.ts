import { describe, expect, it } from "vitest";
import type { JobEnvelope } from "@m365-assess/contracts";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import { createTeamsProviders } from "./teams.js";
import type { WorkerRunner } from "./workers.js";

const CREDENTIAL: CredentialRecord = {
  id: "c-1",
  tenantId: "t-a",
  authMethod: "certificate-thumbprint",
  clientId: "app-1",
  secretRef: "thumbprint://ABC",
  thumbprint: "ABC",
  environment: "commercial",
  expiresOn: null,
  lastValidated: null,
  createdAt: "",
  updatedAt: "",
};

const credentials: CredentialStoreRow = {
  getCredential: async (tenantId) => (tenantId === "t-a" ? CREDENTIAL : undefined),
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

interface Call {
  readonly entrypoint: string;
  readonly job: Record<string, unknown>;
}

function harness(handler: (entrypoint: string, job: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const run: WorkerRunner = async <T>(entrypoint: string, job: Record<string, unknown>): Promise<T> => {
    calls.push({ entrypoint, job });
    return handler(entrypoint, job) as T;
  };
  return { calls, providers: createTeamsProviders(run, credentials) };
}

function envelope(payload: Record<string, unknown>): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId: "job-1",
    jobType: "remediation",
    tenantId: "t-a",
    runId: "",
    requestId: "req-1",
    correlationId: "corr-1",
    createdAt: "2026-11-07T00:00:00Z",
    payload,
  } as JobEnvelope;
}

describe("Teams providers (T-0856)", () => {
  it("lists teams through the flat get-teams job", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      totalCount: 1,
      items: [
        {
          id: "team-1",
          name: "Project Alpha",
          ownerCount: 1,
          memberCount: 3,
          visibility: "private",
          isArchived: false,
          createdDateTime: "2026-01-01T00:00:00Z",
          sensitivityLabel: "General",
        },
      ],
      nextCursor: "",
    }));

    const page = await providers.teams.listTeams("t-a", {
      visibility: "private",
      archived: false,
      from: "2026-01-01T00:00:00Z",
      cursor: null,
      limit: 50,
    });

    expect(page.nextCursor).toBeNull();
    expect(page.items[0]?.name).toBe("Project Alpha");
    expect(calls[0]!.entrypoint).toBe("get-teams.ps1");
    expect(calls[0]!.job).toMatchObject({
      visibility: "private",
      archived: "false",
      from: "2026-01-01T00:00:00Z",
      top: 50,
      cursor: "",
    });
    expect(calls[0]!.job["credential"]).toMatchObject({ record: { tenantId: "t-a" } });
  });

  it("reads the activity report", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      generatedAt: "2026-11-07T00:00:00Z",
      period: "D30",
      startDate: "2026-10-08",
      endDate: null,
      teams: [],
      users: [],
      sources: { teams: "graph", users: "graph" },
    }));

    const report = await providers.activity.getActivity("t-a", {
      period: "D30",
      startDate: "2026-10-08",
      cursor: null,
      limit: 100,
    });

    expect(report.sources.teams).toBe("graph");
    expect(calls[0]!.entrypoint).toBe("get-teams-activity.ps1");
    expect(calls[0]!.job).toMatchObject({ period: "D30", startDate: "2026-10-08" });
  });

  it("runs the lifecycle worker with the action at the top level", async () => {
    const { calls, providers } = harness((_entrypoint, job) => {
      const payload = job["payload"] as Record<string, unknown>;
      if (payload["dryRun"] === true) {
        return {
          action: "edit",
          teamId: payload["teamId"],
          targetName: "Project Alpha",
          diff: ["rename"],
          valid: true,
          dryRun: true,
          requiresConfirmation: false,
        };
      }
      return {
        success: true,
        state: "succeeded",
        operation: "edit",
        teamId: payload["teamId"],
        targetName: "Project Alpha",
        before: { displayName: "Alpha" },
        after: { displayName: "Beta" },
        error: null,
      };
    });

    const plan = await providers.lifecycle.editTeam(
      "t-a",
      "team-1",
      { changes: { displayName: "Beta" } },
      true,
    );
    expect("dryRun" in plan && plan.dryRun).toBe(true);

    const result = await providers.lifecycle.editTeam(
      "t-a",
      "team-1",
      { changes: { displayName: "Beta" } },
      false,
    );
    expect("state" in result && result.state).toBe("succeeded");

    expect(calls[0]!.entrypoint).toBe("invoke-team-action.ps1");
    expect(calls[0]!.job["action"]).toBe("edit");
    expect(calls[0]!.job["payload"]).toMatchObject({
      teamId: "team-1",
      changes: { displayName: "Beta" },
      dryRun: true,
      confirm: false,
    });
    expect(calls[1]!.job["payload"]).toMatchObject({ dryRun: false, confirm: false });

    await providers.lifecycle.deleteTeam(
      "t-a",
      "team-1",
      { confirm: true, confirmName: "Project Alpha" },
      false,
    );
    expect(calls[2]!.job["action"]).toBe("delete");
    expect(calls[2]!.job["payload"]).toMatchObject({
      dryRun: false,
      confirm: true,
      confirmName: "Project Alpha",
    });
  });

  it("lists LIS locations and finds one by id", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      totalCount: 1,
      items: [
        {
          id: "loc-1",
          displayName: "HQ",
          street: "1 Main St",
          city: "Seattle",
          state: "WA",
          country: "US",
          postalCode: "98101",
        },
      ],
    }));

    const list = await providers.lis.listLocations("t-a");
    expect(list.totalCount).toBe(1);
    const found = await providers.lis.getLocation("t-a", "loc-1");
    expect(found?.displayName).toBe("HQ");
    expect(await providers.lis.getLocation("t-a", "missing")).toBeUndefined();
    expect(calls[0]!.entrypoint).toBe("invoke-lis-location.ps1");
    expect(calls[0]!.job["action"]).toBe("list");
  });

  it("normalizes the voice license and inventory, and runs the voice writes", async () => {
    const { calls, providers } = harness((_entrypoint, job) => {
      const action = job["action"];
      if (action === "list") {
        return {
          tenantId: "t-a",
          license: { Licensed: true, MissingPlans: [], ActivePlans: ["MCOEV"] },
          numbers: [{ id: "n-1", number: "+15550100", type: "user", assignedTo: "user-1", state: "active" }],
        };
      }
      if (job["dryRun"] === true) {
        return { action, diff: ["plan"], valid: true, dryRun: true, requiresConfirmation: false };
      }
      return { success: true, plan: { action, diff: [], valid: true, dryRun: false, requiresConfirmation: false } };
    });

    const inventory = await providers.voice.listNumbers("t-a");
    expect(inventory.license).toEqual({ licensed: true, missingPlans: [], activePlans: ["MCOEV"] });
    expect(inventory.numbers[0]?.number).toBe("+15550100");

    const plan = await providers.voice.assignNumber(
      "t-a",
      { phoneNumber: "+15550100", targetId: "user-1" },
      true,
    );
    expect("dryRun" in plan && plan.dryRun).toBe(true);
    await providers.voice.releaseNumber("t-a", "n-1", false);
    await providers.voice.assignPolicy("t-a", { policyId: "p-1", targetId: "user-1" }, false);

    expect(calls[1]!.job).toMatchObject({ action: "assign", phoneNumber: "+15550100", confirmed: false });
    expect(calls[2]!.job).toMatchObject({ action: "release", numberId: "n-1", confirmed: true });
    expect(calls[3]!.job).toMatchObject({ action: "policy", policyId: "p-1", targetId: "user-1" });
  });

  it("maps the create route's envelope onto new-team.ps1", async () => {
    const { calls, providers } = harness(() => ({ success: true }));

    const jobId = await providers.enqueueCreate(
      envelope({
        area: "teams",
        action: "create",
        name: "Project Alpha",
        owners: ["owner@example.invalid"],
        members: ["member@example.invalid"],
        visibility: "private",
        settings: { allowGiphy: true },
        actor: "user-1",
      }),
    );

    expect(jobId).toBe("job-1");
    expect(calls[0]!.entrypoint).toBe("new-team.ps1");
    expect(calls[0]!.job["schemaVersion"]).toBe("v1");
    expect(calls[0]!.job["payload"]).toMatchObject({
      team: {
        name: "Project Alpha",
        owners: ["owner@example.invalid"],
        members: ["member@example.invalid"],
        visibility: "private",
        settings: { allowGiphy: true },
      },
      dryRun: false,
      actor: "user-1",
    });
  });

  it("maps the LIS route's envelope onto invoke-lis-location.ps1", async () => {
    const { calls, providers } = harness(() => ({ success: true }));

    await providers.enqueueLis(
      envelope({
        area: "teams.lis",
        action: "delete",
        locationId: "loc-1",
        displayName: "HQ",
      }),
    );

    expect(calls[0]!.entrypoint).toBe("invoke-lis-location.ps1");
    expect(calls[0]!.job).toMatchObject({
      action: "delete",
      locationId: "loc-1",
      displayName: "HQ",
      confirmName: "HQ",
      dryRun: false,
    });
  });
});
