import { describe, expect, it } from "vitest";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import type { SecureScoreRepository, SecureScoreSnapshotRecord } from "../repository/secure-score.js";
import { createSecureScoreProviders, createSecureScoreSnapshotCommand } from "./secure-score.js";
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
  getCredential: async (tenantId) => ({ ...CREDENTIAL, tenantId }),
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

const SCORE = {
  tenantId: "t-a",
  current: 42.5,
  max: 100,
  percentage: 42.5,
  categories: [{ category: "Identity", achieved: 20, available: 40, percentage: 50 }],
  actions: [
    {
      id: "MS.AAD.3.5v2",
      title: "Ensure multifactor authentication is enabled",
      category: "Identity",
      pointsAchieved: 20,
      pointsAvailable: 40,
      impact: "High",
      implementationStatus: "Implemented",
    },
  ],
  averageComparativeScores: [{ basis: "AllTenants", averageScore: 38.1 }],
};

function harness(handler: (entrypoint: string) => unknown = () => SCORE) {
  const calls: Array<{ entrypoint: string; job: Record<string, unknown> }> = [];
  const run: WorkerRunner = async <T>(entrypoint: string, job: Record<string, unknown>): Promise<T> => {
    calls.push({ entrypoint, job });
    return handler(entrypoint) as T;
  };
  return { calls, providers: createSecureScoreProviders(run, credentials) };
}

describe("Secure Score providers (T-0861)", () => {
  it("reads the current score through get-secure-score.ps1", async () => {
    const { calls, providers } = harness();
    const score = await providers.secureScore.getSecureScore("t-a");

    expect(score.current).toBe(42.5);
    expect(score.max).toBe(100);
    expect(score.categories[0]?.category).toBe("Identity");
    expect(score.actions[0]?.id).toBe("MS.AAD.3.5v2");
    expect(calls[0]!.entrypoint).toBe("get-secure-score.ps1");
    expect(calls[0]!.job["credential"]).toMatchObject({ record: { tenantId: "t-a" } });
  });

  it("surfaces the peer comparisons Graph reports", async () => {
    const { providers } = harness();
    const score = await providers.peers.getSecureScore("t-a");
    expect(score.averageComparativeScores).toEqual([{ basis: "AllTenants", averageScore: 38.1 }]);
  });

  it("omits the comparison list when Graph reports none", async () => {
    const { providers } = harness(() => ({ ...SCORE, averageComparativeScores: undefined }));
    const score = await providers.peers.getSecureScore("t-a");
    expect(score.averageComparativeScores).toBeUndefined();
  });
});

describe("Secure Score daily snapshot command (T-0861)", () => {
  function store() {
    const recorded: SecureScoreSnapshotRecord[] = [];
    const pruned: number[] = [];
    const repository: Pick<SecureScoreRepository, "recordSnapshot" | "pruneSnapshots"> = {
      async recordSnapshot(input) {
        const snapshot: SecureScoreSnapshotRecord = {
          id: `snap-${recorded.length + 1}`,
          tenantId: input.tenantId,
          at: input.at ?? "2026-11-08T01:00:00.000Z",
          current: input.current,
          max: input.max,
          percentage: input.percentage,
          categories: {},
          createdAt: "2026-11-08T01:00:00.000Z",
        };
        recorded.push(snapshot);
        return snapshot;
      },
      async pruneSnapshots(options) {
        pruned.push(options.retentionDays ?? 0);
        return { prunedSnapshotsCount: 2 };
      },
    };
    return { repository, recorded, pruned };
  }

  it("records a snapshot per included tenant and prunes the window", async () => {
    const { repository, recorded, pruned } = store();
    const { providers } = harness();
    const command = createSecureScoreSnapshotCommand({
      tenants: {
        listTenants: async () => [
          { id: "t-a" },
          { id: "t-skip", excluded: true },
          { id: "t-b", status: "excluded" },
        ],
      },
      provider: providers.secureScore,
      store: repository,
      retentionDays: 30,
    });

    const outcome = await command(
      { payload: { outputRef: "schedules/system-secure-score-snapshot/run-1" } } as never,
      new AbortController().signal,
    );

    expect(outcome.status).toBe("succeeded");
    expect(recorded.map((snapshot) => snapshot.tenantId)).toEqual(["t-a"]);
    expect(recorded[0]?.current).toBe(42.5);
    expect(pruned).toEqual([30]);
    expect(outcome.message).toContain("recorded 1 snapshot");
  });

  it("reports a failure without stopping the other tenants", async () => {
    const { repository } = store();
    let call = 0;
    const run: WorkerRunner = async <T>(_entrypoint: string, job: Record<string, unknown>): Promise<T> => {
      call += 1;
      if (job["tenantId"] === "t-b") throw new Error("graph unavailable");
      return SCORE as T;
    };
    const providers = createSecureScoreProviders(run, credentials);
    const command = createSecureScoreSnapshotCommand({
      tenants: { listTenants: async () => [{ id: "t-a" }, { id: "t-b" }] },
      provider: providers.secureScore,
      store: repository,
      retentionDays: 0,
    });

    const outcome = await command(
      { payload: { outputRef: "schedules/system-secure-score-snapshot/run-1" } } as never,
      new AbortController().signal,
    );

    expect(call).toBe(2);
    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain("t-b");
  });
});
