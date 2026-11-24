// T-0876: custom-script schedules run through the scheduler instead of being refused with 501.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobEnvelope, ResultEnvelope } from "@m365-assess/contracts";
import type { Schedule } from "@m365-assess/db";
import { afterEach, describe, expect, it } from "vitest";
import { createJobDispatcher } from "../jobs/dispatch.js";
import type { CustomScriptRecord, CustomScriptVersionRecord, ScriptSandboxRunInput } from "../routes/scripts.js";
import { CUSTOM_SCRIPT_COMMAND, type ScheduleRecord, type ScheduleStore } from "../routes/schedules.js";
import { tickSchedules, type TickSchedule } from "../scheduler/tick.js";
import {
  SCHEDULE_CUSTOM_SCRIPT_INVALID,
  createCustomScriptCommand,
  createCustomScriptRunner,
  createRunnerValidatingScheduleStore,
  createScheduleRunQueue,
  scheduleIdFromOutputRef,
} from "./automation.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "m365-cs-"));
  dirs.push(root);
  return root;
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sch-1",
    name: "Nightly script",
    type: "custom-script",
    cron: "0 0 0 * * *",
    timezone: "UTC",
    targetScope: { type: "tenant", id: "t-a" },
    command: CUSTOM_SCRIPT_COMMAND,
    parameters: { scriptId: "scr-1" },
    enabled: true,
    isSystem: false,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  } as Schedule;
}

function envelope(overrides: Partial<JobEnvelope> = {}): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId: "job-1",
    jobType: "custom-script",
    tenantId: "t-a",
    runId: "run-1",
    requestId: "req-1",
    correlationId: "corr-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      contextRef: "schedules/sch-1/context.json",
      outputRef: "schedules/sch-1/run-1",
      credentialRef: "tenants/t-a/credential",
      sectionRefs: [],
      artifactRefs: [],
    },
    ...overrides,
  };
}

function fakeScripts(script: Partial<CustomScriptRecord> | undefined = {}) {
  const record: CustomScriptRecord | undefined =
    script === undefined
      ? undefined
      : {
          id: "scr-1",
          name: "Script",
          author: "op",
          enabled: true,
          alertsEnabled: false,
          currentVersionId: "ver-1",
          createdAt: "",
          updatedAt: "",
          ...script,
        };
  const version: CustomScriptVersionRecord = {
    id: "ver-1",
    scriptId: "scr-1",
    content: "Write-Output 'hi'",
    markdownTemplate: null,
    parameters: { mode: "report" },
    createdAt: "",
    createdBy: "op",
  } as CustomScriptVersionRecord;
  return {
    getScript: async (id: string) => (record !== undefined && id === record.id ? record : undefined),
    listVersions: async () => [version],
    getVersion: async (id: string) => (id === version.id ? version : undefined),
  };
}

function harness(options: { schedule?: Schedule | undefined; script?: Partial<CustomScriptRecord> | undefined; exitCodes?: Record<string, number> } = {}) {
  const root = tempRoot();
  const sandboxCalls: ScriptSandboxRunInput[] = [];
  const audits: { action: string; tenantId?: string | null; resourceId: string }[] = [];
  const current = "schedule" in options ? options.schedule : schedule();
  const runner = createCustomScriptRunner({
    schedules: { getSchedule: async (id) => (current !== undefined && id === current.id ? current : undefined) },
    storageRoot: root,
    handlers: {
      [CUSTOM_SCRIPT_COMMAND]: createCustomScriptCommand({
        scripts: fakeScripts("script" in options ? options.script : {}),
        sandbox: {
          run: async (input) => {
            sandboxCalls.push(input);
            return { output: `ran on ${input.tenantId}`, exitCode: options.exitCodes?.[input.tenantId] ?? 0 };
          },
        },
        tenants: { listTenants: async () => [{ id: "t-a" }, { id: "t-b" }] as never },
        storageRoot: root,
        audit: { record: (event) => void audits.push(event) },
      }),
    },
  });
  return { root, runner, sandboxCalls, audits };
}

const signal = new AbortController().signal;

describe("custom-script runner (T-0876)", () => {
  it("derives the schedule id from a scheduled outputRef", () => {
    expect(scheduleIdFromOutputRef("schedules/sch-1/run-1")).toBe("sch-1");
    expect(scheduleIdFromOutputRef("runs/t-a/run-1")).toBeUndefined();
  });

  it("runs the schedule's script for real on its tenant, audits it, and stores the output", async () => {
    const value = harness();
    const result = await value.runner(envelope(), signal);

    expect(result).toMatchObject({ status: "succeeded", jobType: "custom-script", exitCode: 0 });
    expect(value.sandboxCalls).toEqual([
      { content: "Write-Output 'hi'", tenantId: "t-a", dryRun: false, parameters: { mode: "report" } },
    ]);
    expect(value.audits).toEqual([
      expect.objectContaining({ action: "scripts.run", tenantId: "t-a", resourceId: "scr-1" }),
    ]);
    const stored = JSON.parse(
      readFileSync(path.join(value.root, "schedules/sch-1/run-1/custom-script-results.json"), "utf8"),
    );
    expect(stored).toMatchObject({ scriptId: "scr-1", scheduleId: "sch-1", runs: [{ tenantId: "t-a", output: "ran on t-a" }] });
  });

  it("runs once per tenant for an all-tenants target", async () => {
    const value = harness({ schedule: schedule({ targetScope: { type: "all" } }) });
    const result = await value.runner(envelope({ tenantId: "all" }), signal);
    expect(result.status).toBe("succeeded");
    expect(value.sandboxCalls.map((call) => call.tenantId)).toEqual(["t-a", "t-b"]);
  });

  it("fails the job when the script exits non-zero on any tenant", async () => {
    const value = harness({ schedule: schedule({ targetScope: { type: "all" } }), exitCodes: { "t-b": 3 } });
    const result = await value.runner(envelope({ tenantId: "all" }), signal);
    expect(result).toMatchObject({ status: "failed", exitCode: 3 });
    expect(result.error?.message).toContain("t-b");
  });

  it("fails without running anything when the script is disabled", async () => {
    const value = harness({ script: { enabled: false } });
    const result = await value.runner(envelope(), signal);
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("disabled");
    expect(value.sandboxCalls).toEqual([]);
  });

  it("fails a job whose schedule no longer exists", async () => {
    const value = harness({ schedule: undefined });
    const result = await value.runner(envelope(), signal);
    expect(result.status).toBe("failed");
    expect(value.sandboxCalls).toEqual([]);
  });

  it("fails a custom-script job whose command has no handler instead of reporting success", async () => {
    const value = harness({ schedule: schedule({ command: "Invoke-VacationSchedule" }) });
    const result = await value.runner(envelope(), signal);
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("Invoke-VacationSchedule");
    expect(value.sandboxCalls).toEqual([]);
  });

  it("refuses group targets", async () => {
    const value = harness({ schedule: schedule({ targetScope: { type: "group", id: "g-1" } }) });
    const result = await value.runner(envelope({ tenantId: "g-1" }), signal);
    expect(result.status).toBe("failed");
    expect(value.sandboxCalls).toEqual([]);
  });
});

describe("custom-script schedule validation (T-0876)", () => {
  function memoryStore(): ScheduleStore {
    const rows = new Map<string, ScheduleRecord>();
    return {
      listSchedules: async () => [...rows.values()],
      getSchedule: async (id) => rows.get(id),
      createSchedule: async (input) => {
        const row = { ...schedule(), ...input, id: `sch-${rows.size + 1}` } as ScheduleRecord;
        rows.set(row.id, row);
        return row;
      },
      updateSchedule: async (id, patch) => {
        const row = rows.get(id);
        if (row === undefined) return undefined;
        const next = { ...row, ...patch } as ScheduleRecord;
        rows.set(id, next);
        return next;
      },
      softDeleteSchedule: async () => true,
    };
  }

  const createInput = (parameters: Record<string, unknown>) =>
    ({
      name: "Nightly script",
      type: "custom-script",
      cron: "0 0 0 * * *",
      timezone: "UTC",
      targetScope: { type: "tenant", id: "t-a" },
      command: CUSTOM_SCRIPT_COMMAND,
      parameters,
      enabled: true,
      lastRunAt: null,
      nextRunAt: null,
    }) as never;

  it("stores a custom-script schedule that names a runnable script", async () => {
    const store = createRunnerValidatingScheduleStore(memoryStore(), new Set(["custom-script"]), fakeScripts());
    await expect(store.createSchedule(createInput({ scriptId: "scr-1" }))).resolves.toMatchObject({
      type: "custom-script",
      command: CUSTOM_SCRIPT_COMMAND,
    });
  });

  it("rejects a custom-script schedule whose script is missing or disabled with 422", async () => {
    const missing = createRunnerValidatingScheduleStore(memoryStore(), new Set(["custom-script"]), fakeScripts());
    await expect(missing.createSchedule(createInput({ scriptId: "scr-nope" }))).rejects.toMatchObject({
      status: 422,
      code: SCHEDULE_CUSTOM_SCRIPT_INVALID,
    });
    await expect(missing.createSchedule(createInput({}))).rejects.toMatchObject({ status: 422 });

    const disabled = createRunnerValidatingScheduleStore(
      memoryStore(),
      new Set(["custom-script"]),
      fakeScripts({ enabled: false }),
    );
    await expect(disabled.createSchedule(createInput({ scriptId: "scr-1" }))).rejects.toMatchObject({ status: 422 });
  });

  it("re-validates when an update points the schedule at a different script", async () => {
    const store = createRunnerValidatingScheduleStore(memoryStore(), new Set(["custom-script"]), fakeScripts());
    const created = await store.createSchedule(createInput({ scriptId: "scr-1" }));
    await expect(store.updateSchedule(created.id, { parameters: { scriptId: "scr-nope" } })).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe("scheduler runs a custom-script schedule end to end (T-0876)", () => {
  it("ticks a due custom-script schedule through the run queue to the runner", async () => {
    const value = harness();
    const results: ResultEnvelope[] = [];
    const dispatch = createJobDispatcher({ "custom-script": value.runner });
    const queue = createScheduleRunQueue({
      jobs: {
        enqueue: async (e: JobEnvelope) => {
          results.push(await dispatch(e, signal));
          return e.jobId;
        },
      } as never,
      repo: {} as never,
      storageRoot: value.root,
      tenants: { getTenant: async () => undefined } as never,
      credentials: { getCredential: async () => undefined },
      runnableTypes: new Set(["custom-script"]),
    });
    const due: TickSchedule = { ...schedule(), type: "custom-script" } as TickSchedule;
    const tick = await tickSchedules({
      queue,
      schedules: { listSchedules: async () => [due], getSchedule: async () => due, updateSchedule: async () => undefined },
      isRunning: () => false,
      now: new Date("2026-01-01T12:00:00.000Z"),
      systemTimers: [],
    });

    expect(tick).toMatchObject({ enqueued: ["sch-1"], failed: [] });
    expect(results).toEqual([expect.objectContaining({ status: "succeeded", jobType: "custom-script" })]);
    expect(value.sandboxCalls.map((call) => call.tenantId)).toEqual(["t-a"]);
  });
});
