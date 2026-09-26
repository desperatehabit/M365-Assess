import { describe, expect, it } from "vitest";
import {
  ProgressEventHub,
  type RunProgressStore,
  type RunSectionInput,
} from "./hub.js";
import type { RunStatus } from "../domain/runs/run-lifecycle.js";
import { EnvelopeValidationError } from "@m365-assess/contracts";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "run-uuid-1";
const JOB_ID = "job-uuid-1";

class FakeRunProgressStore implements RunProgressStore {
  readonly runUpdates: Array<{
    tenantId: string;
    runId: string;
    update: {
      status?: RunStatus;
      startedAt?: string | null;
      finishedAt?: string | null;
      updatedAt?: string;
    };
  }> = [];

  readonly sections: RunSectionInput[] = [];

  async updateRun(
    tenantId: string,
    runId: string,
    update: {
      status?: RunStatus;
      startedAt?: string | null;
      finishedAt?: string | null;
      updatedAt?: string;
    },
  ): Promise<unknown> {
    this.runUpdates.push({ tenantId, runId, update });
    return update;
  }

  async recordRunSection(input: RunSectionInput): Promise<unknown> {
    this.sections.push(input);
    return input;
  }
}

describe("ProgressEventHub", () => {
  it("assigns strictly monotonic sequences per runId", async () => {
    const hub = new ProgressEventHub();
    const event0 = await hub.publish({
      runId: "run-A",
      tenantId: TENANT_ID,
      jobId: "job-A",
      state: "queued",
    });
    const event1 = await hub.publish({
      runId: "run-A",
      tenantId: TENANT_ID,
      jobId: "job-A",
      state: "running",
    });
    const event2 = await hub.publish({
      runId: "run-A",
      tenantId: TENANT_ID,
      jobId: "job-A",
      state: "succeeded",
    });

    // Independent run
    const eventB0 = await hub.publish({
      runId: "run-B",
      tenantId: TENANT_ID,
      jobId: "job-B",
      state: "running",
    });

    expect(event0.sequence).toBe(0);
    expect(event1.sequence).toBe(1);
    expect(event2.sequence).toBe(2);

    expect(eventB0.sequence).toBe(0);
  });

  it("validates event contracts using parseProgressEvent", async () => {
    const hub = new ProgressEventHub();
    await expect(
      hub.publish({
        runId: RUN_ID,
        tenantId: TENANT_ID,
        jobId: JOB_ID,
        state: "unknown-state" as any,
      }),
    ).rejects.toThrow(EnvelopeValidationError);
  });

  it("fans out progress events to multiple active subscribers", async () => {
    const hub = new ProgressEventHub();
    const sub1Events: number[] = [];
    const sub2Events: number[] = [];

    const unsub1 = hub.subscribe(RUN_ID, (e) => sub1Events.push(e.sequence));
    const unsub2 = hub.subscribe(RUN_ID, (e) => sub2Events.push(e.sequence));

    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      state: "running",
    });
    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      state: "running",
      section: "Identity",
      sectionState: "running",
    });

    unsub1();

    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      state: "succeeded",
    });

    unsub2();

    expect(sub1Events).toEqual([0, 1]);
    expect(sub2Events).toEqual([0, 1, 2]);
  });

  it("replays event history to late subscribers and closes on terminal run", async () => {
    const hub = new ProgressEventHub();

    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      state: "running",
    });
    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      state: "succeeded",
    });

    const received: number[] = [];
    let completed = false;

    hub.subscribe(RUN_ID, {
      onEvent: (e) => received.push(e.sequence),
      onComplete: () => {
        completed = true;
      },
    });

    expect(received).toEqual([0, 1]);
    expect(completed).toBe(true);
  });

  it("calls onComplete and removes subscribers when terminal state is reached", async () => {
    const hub = new ProgressEventHub();
    let completed = false;

    hub.subscribe(RUN_ID, {
      onEvent: () => {},
      onComplete: () => {
        completed = true;
      },
    });

    expect(hub.isTerminal(RUN_ID)).toBe(false);

    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      state: "running",
    });
    expect(completed).toBe(false);

    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      state: "failed",
    });

    expect(completed).toBe(true);
    expect(hub.isTerminal(RUN_ID)).toBe(true);
  });

  it("updates Run and RunSection in store", async () => {
    const store = new FakeRunProgressStore();
    const hub = new ProgressEventHub({ store });

    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      state: "running",
      at: "2026-06-01T10:00:00.000Z",
    });

    expect(store.runUpdates).toHaveLength(1);
    expect(store.runUpdates[0]).toMatchObject({
      tenantId: TENANT_ID,
      runId: RUN_ID,
      update: {
        status: "running",
        startedAt: "2026-06-01T10:00:00.000Z",
      },
    });

    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      state: "running",
      section: "ExchangeOnline",
      sectionState: "running",
      at: "2026-06-01T10:01:00.000Z",
    });

    expect(store.sections).toHaveLength(1);
    expect(store.sections[0]).toMatchObject({
      runId: RUN_ID,
      tenantId: TENANT_ID,
      section: "ExchangeOnline",
      status: "running",
      startedAt: "2026-06-01T10:01:00.000Z",
    });

    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      state: "succeeded",
      at: "2026-06-01T10:05:00.000Z",
    });

    expect(store.runUpdates).toHaveLength(2);
    expect(store.runUpdates[1]).toMatchObject({
      tenantId: TENANT_ID,
      runId: RUN_ID,
      update: {
        status: "succeeded",
        finishedAt: "2026-06-01T10:05:00.000Z",
      },
    });
  });

  it("sanitizes secrets and tenant PII from events", async () => {
    const hub = new ProgressEventHub();
    const event = await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      state: "running",
      message: "Operator user user.admin@customer.onmicrosoft.com authenticated with Bearer secret-token-xyz123 client_secret=very_secret_key",
      // Unknown extra field
      extraSecretData: "forbidden-token",
    } as any);

    expect(event.message).not.toContain("user.admin@customer.onmicrosoft.com");
    expect(event.message).toContain("[redacted-email]");
    expect(event.message).not.toContain("secret-token-xyz123");
    expect(event.message).not.toContain("very_secret_key");
    expect((event as any).extraSecretData).toBeUndefined();
  });

  it("supports async iteration via stream(runId)", async () => {
    const hub = new ProgressEventHub();

    setTimeout(async () => {
      await hub.publish({ runId: RUN_ID, tenantId: TENANT_ID, jobId: JOB_ID, state: "running" });
      await hub.publish({ runId: RUN_ID, tenantId: TENANT_ID, jobId: JOB_ID, state: "succeeded" });
    }, 10);

    const received: string[] = [];
    for await (const event of hub.stream(RUN_ID)) {
      received.push(event.state);
    }

    expect(received).toEqual(["running", "succeeded"]);
  });
});
