// T-0807 — Shadow AI discovery domain service.
import { describe, expect, it } from "vitest";
import {
  SHADOW_AI_DEFENDER_SOURCE,
  SHADOW_AI_INVALID_STATE,
  SHADOW_AI_SIGNIN_SOURCE,
  SHADOW_AI_SOURCES_UNAVAILABLE,
  SHADOW_AI_TENANT_REQUIRED,
  ShadowAiError,
  ShadowAiService,
  type ShadowAiDetection,
  type ShadowAiDetectionSource,
  type ShadowAiFinding,
  type ShadowAiFindingInput,
  type ShadowAiFindingState,
  type ShadowAiFindingStore,
  type ShadowAiSourceKind,
} from "./shadow-ai-service.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";

const DETECTIONS: readonly ShadowAiDetection[] = [
  { tool: "SomeUnsanctionedLlm", user: "user-a", detectedAt: "2026-09-01T10:00:00.000Z" },
  { tool: "AnotherAiTool", user: "user-b", detectedAt: "2026-09-02T11:30:00.000Z" },
];

class FakeSource implements ShadowAiDetectionSource {
  readonly calls: string[] = [];
  constructor(
    readonly kind: ShadowAiSourceKind,
    private readonly detections: readonly ShadowAiDetection[] | null,
  ) {}

  async listDetections(tenantId: string): Promise<readonly ShadowAiDetection[] | null> {
    this.calls.push(tenantId);
    return this.detections;
  }
}

class MemoryStore implements ShadowAiFindingStore {
  readonly saved: ShadowAiFindingInput[][] = [];
  private readonly byId = new Map<string, ShadowAiFinding>();

  async saveFindings(findings: readonly ShadowAiFindingInput[]): Promise<readonly ShadowAiFinding[]> {
    this.saved.push([...findings]);
    const persisted = findings.map((finding) => {
      const record: ShadowAiFinding = {
        id: finding.id,
        tenantId: finding.tenantId,
        tool: finding.tool,
        user: finding.user,
        detectedAt: finding.detectedAt,
        state: finding.state ?? "open",
        createdAt: finding.createdAt ?? "2026-09-03T00:00:00.000Z",
        updatedAt: finding.updatedAt ?? "2026-09-03T00:00:00.000Z",
      };
      this.byId.set(record.id, record);
      return record;
    });
    return persisted;
  }

  async listFindings(tenantId: string): Promise<readonly ShadowAiFinding[]> {
    return [...this.byId.values()].filter((finding) => finding.tenantId === tenantId);
  }

  async updateFindingState(
    tenantId: string,
    findingId: string,
    state: ShadowAiFindingState,
  ): Promise<ShadowAiFinding | undefined> {
    const existing = this.byId.get(findingId);
    if (!existing || existing.tenantId !== tenantId) return undefined;
    const updated: ShadowAiFinding = { ...existing, state, updatedAt: "2026-09-04T00:00:00.000Z" };
    this.byId.set(findingId, updated);
    return updated;
  }
}

function makeService(
  defender: ShadowAiDetectionSource,
  signInLogs: ShadowAiDetectionSource,
  store: ShadowAiFindingStore = new MemoryStore(),
): ShadowAiService {
  return new ShadowAiService({ defender, signInLogs, store });
}

describe("discover", () => {
  it("uses Defender for Cloud Apps first and does not query sign-in logs", async () => {
    const defender = new FakeSource(SHADOW_AI_DEFENDER_SOURCE, DETECTIONS);
    const signInLogs = new FakeSource(SHADOW_AI_SIGNIN_SOURCE, DETECTIONS);
    const store = new MemoryStore();
    const service = makeService(defender, signInLogs, store);

    const result = await service.discover(TENANT);

    expect(result.source).toBe(SHADOW_AI_DEFENDER_SOURCE);
    expect(result.usedFallback).toBe(false);
    expect(defender.calls).toEqual([TENANT]);
    expect(signInLogs.calls).toEqual([]);
    expect(result.findings).toHaveLength(DETECTIONS.length);
  });

  it("falls back to sign-in logs when Defender is unavailable", async () => {
    const defender = new FakeSource(SHADOW_AI_DEFENDER_SOURCE, null);
    const signInLogs = new FakeSource(SHADOW_AI_SIGNIN_SOURCE, DETECTIONS);
    const store = new MemoryStore();
    const service = makeService(defender, signInLogs, store);

    const result = await service.discover(TENANT);

    expect(result.source).toBe(SHADOW_AI_SIGNIN_SOURCE);
    expect(result.usedFallback).toBe(true);
    expect(defender.calls).toEqual([TENANT]);
    expect(signInLogs.calls).toEqual([TENANT]);
    expect(result.findings).toHaveLength(DETECTIONS.length);
  });

  it("fails closed when both sources are unavailable", async () => {
    const defender = new FakeSource(SHADOW_AI_DEFENDER_SOURCE, null);
    const signInLogs = new FakeSource(SHADOW_AI_SIGNIN_SOURCE, null);
    const service = makeService(defender, signInLogs);

    await expect(service.discover(TENANT)).rejects.toMatchObject({
      code: SHADOW_AI_SOURCES_UNAVAILABLE,
    });
  });

  it("does not fall back on an available source that detected nothing", async () => {
    const defender = new FakeSource(SHADOW_AI_DEFENDER_SOURCE, []);
    const signInLogs = new FakeSource(SHADOW_AI_SIGNIN_SOURCE, DETECTIONS);
    const service = makeService(defender, signInLogs);

    const result = await service.discover(TENANT);

    expect(result.source).toBe(SHADOW_AI_DEFENDER_SOURCE);
    expect(result.usedFallback).toBe(false);
    expect(signInLogs.calls).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("persists tenant-scoped findings with tool, user, time, and open state", async () => {
    const store = new MemoryStore();
    const service = makeService(
      new FakeSource(SHADOW_AI_DEFENDER_SOURCE, DETECTIONS),
      new FakeSource(SHADOW_AI_SIGNIN_SOURCE, null),
      store,
    );

    await service.discover(TENANT);

    expect(store.saved).toHaveLength(1);
    const persisted = store.saved[0]!;
    expect(persisted).toHaveLength(DETECTIONS.length);
    expect(persisted[0]).toMatchObject({
      tenantId: TENANT,
      tool: "SomeUnsanctionedLlm",
      user: "user-a",
      detectedAt: "2026-09-01T10:00:00.000Z",
      state: "open",
    });
    expect(persisted.every((finding) => finding.tenantId === TENANT)).toBe(true);
  });

  it("derives stable ids so re-discovery upserts rather than duplicates", async () => {
    const store = new MemoryStore();
    const service = makeService(
      new FakeSource(SHADOW_AI_DEFENDER_SOURCE, DETECTIONS),
      new FakeSource(SHADOW_AI_SIGNIN_SOURCE, null),
      store,
    );

    const first = await service.discover(TENANT);
    const second = await service.discover(TENANT);

    expect(second.findings.map((finding) => finding.id)).toEqual(
      first.findings.map((finding) => finding.id),
    );
    expect(await service.list(TENANT)).toHaveLength(DETECTIONS.length);
  });

  it("is report-only: discovery reports blocked=false and never writes to the tenant", async () => {
    const store = new MemoryStore();
    const defender = new FakeSource(SHADOW_AI_DEFENDER_SOURCE, DETECTIONS);
    const service = makeService(defender, new FakeSource(SHADOW_AI_SIGNIN_SOURCE, null), store);

    const result = await service.discover(TENANT);

    expect(result.blocked).toBe(false);
    // The only write is the portal-side finding store; the detection source is
    // read-only and the service exposes no block/CA write path.
    expect(defender.calls).toEqual([TENANT]);
    expect(store.saved).toHaveLength(1);
  });

  it("requires a tenant id", async () => {
    const service = makeService(
      new FakeSource(SHADOW_AI_DEFENDER_SOURCE, DETECTIONS),
      new FakeSource(SHADOW_AI_SIGNIN_SOURCE, null),
    );

    await expect(service.discover("   ")).rejects.toMatchObject({
      code: SHADOW_AI_TENANT_REQUIRED,
    });
  });
});

describe("list", () => {
  it("returns only the tenant's findings", async () => {
    const store = new MemoryStore();
    const service = makeService(
      new FakeSource(SHADOW_AI_DEFENDER_SOURCE, DETECTIONS),
      new FakeSource(SHADOW_AI_SIGNIN_SOURCE, null),
      store,
    );
    await service.discover(TENANT);

    expect(await service.list(TENANT)).toHaveLength(DETECTIONS.length);
    expect(await service.list(OTHER_TENANT)).toEqual([]);
  });
});

describe("setState", () => {
  it("triages a finding and rejects an unknown state", async () => {
    const store = new MemoryStore();
    const service = makeService(
      new FakeSource(SHADOW_AI_DEFENDER_SOURCE, DETECTIONS),
      new FakeSource(SHADOW_AI_SIGNIN_SOURCE, null),
      store,
    );
    const findings = await service.discover(TENANT);
    const findingId = findings.findings[0]!.id;

    const updated = await service.setState(TENANT, findingId, "acknowledged");
    expect(updated?.state).toBe("acknowledged");

    await expect(
      service.setState(TENANT, findingId, "not-a-state" as ShadowAiFindingState),
    ).rejects.toBeInstanceOf(ShadowAiError);
    await expect(
      service.setState(TENANT, findingId, "not-a-state" as ShadowAiFindingState),
    ).rejects.toMatchObject({ code: SHADOW_AI_INVALID_STATE });
  });

  it("cannot triage another tenant's finding", async () => {
    const store = new MemoryStore();
    const service = makeService(
      new FakeSource(SHADOW_AI_DEFENDER_SOURCE, DETECTIONS),
      new FakeSource(SHADOW_AI_SIGNIN_SOURCE, null),
      store,
    );
    const findings = await service.discover(TENANT);

    await expect(
      service.setState(OTHER_TENANT, findings.findings[0]!.id, "dismissed"),
    ).resolves.toBeUndefined();
  });
});
