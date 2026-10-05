import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  VACATION_SCHEDULES_PATH,
  VACATION_SCHEDULE_PATH,
  VACATION_SCHEDULE_COMMAND,
  VACATION_WRITE_PERMISSION,
  buildVacationSchedulerJob,
  createVacationScheduleRoutes,
  cronFromInstant,
  getVacationDisplayStatus,
  parseVacationInput,
  registerVacationSchedulerJobs,
  type VacationApplyProvider,
  type VacationApplyResult,
  type VacationCaller,
  type VacationJobScheduler,
  type VacationPhase,
  type VacationSchedule,
  type VacationScheduledJob,
} from "./vacation-schedules.js";

const TENANT = "tenant-test";

const SCHEDULED: VacationSchedule = {
  id: "vac-1",
  tenantId: TENANT,
  mailboxId: "mbx-1",
  startsAt: "2026-10-01T00:00:00.000Z",
  endsAt: "2026-10-08T00:00:00.000Z",
  oooMessage: "Out of office until October 8.",
  forwardTo: "cover@example.invalid",
  state: "scheduled",
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
};

const ACTIVE: VacationSchedule = { ...SCHEDULED, state: "active" };

const ENABLE_RESULT: VacationApplyResult = {
  success: true,
  scheduleState: "active",
  auditEvent: {
    id: "audit-1",
    tenantId: TENANT,
    action: "vacation.enable",
    targetId: "vac-1",
    targetName: "mbx-1",
    timestamp: "2026-10-01T00:00:00.000Z",
  },
  mailboxOperation: {
    id: "op-1",
    tenantId: TENANT,
    mailboxId: "mbx-1",
    operation: "enable",
    state: "applied",
    at: "2026-10-01T00:00:00.000Z",
  },
};

const REVERT_RESULT: VacationApplyResult = {
  success: true,
  scheduleState: "ended",
  auditEvent: {
    id: "audit-2",
    tenantId: TENANT,
    action: "vacation.revert",
    targetId: "vac-1",
    targetName: "mbx-1",
    timestamp: "2026-10-08T00:00:00.000Z",
  },
  mailboxOperation: {
    id: "op-2",
    tenantId: TENANT,
    mailboxId: "mbx-1",
    operation: "revert",
    state: "applied",
    at: "2026-10-08T00:00:00.000Z",
  },
};

class FakeVacationStore {
  readonly rows = new Map<string, VacationSchedule>([[SCHEDULED.id, SCHEDULED]]);

  async listVacationSchedules(tenantId: string): Promise<VacationSchedule[]> {
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
  }

  async getVacationSchedule(
    tenantId: string,
    scheduleId: string,
  ): Promise<VacationSchedule | undefined> {
    const row = this.rows.get(scheduleId);
    return row?.tenantId === tenantId ? row : undefined;
  }

  async createVacationSchedule(input: VacationSchedule): Promise<VacationSchedule> {
    this.rows.set(input.id, input);
    return input;
  }

  async updateVacationSchedule(
    tenantId: string,
    scheduleId: string,
    update: { state: VacationSchedule["state"] },
  ): Promise<VacationSchedule | undefined> {
    const row = await this.getVacationSchedule(tenantId, scheduleId);
    if (!row) return undefined;
    const updated: VacationSchedule = { ...row, ...update };
    this.rows.set(scheduleId, updated);
    return updated;
  }
}

class FakeApplyProvider implements VacationApplyProvider {
  readonly calls: Array<{ tenantId: string; schedule: VacationSchedule; phase: VacationPhase }> = [];
  outcome: VacationApplyResult = REVERT_RESULT;

  async applyVacationPhase(
    tenantId: string,
    schedule: VacationSchedule,
    phase: VacationPhase,
  ): Promise<VacationApplyResult> {
    this.calls.push({ tenantId, schedule, phase });
    return this.outcome;
  }
}

class FakeScheduler implements VacationJobScheduler {
  readonly created: VacationScheduledJob[] = [];
  readonly disabled: string[] = [];

  async createScheduledJob(job: VacationScheduledJob): Promise<unknown> {
    this.created.push(job);
    return job;
  }

  async disableScheduledJob(jobId: string): Promise<unknown> {
    this.disabled.push(jobId);
    return true;
  }
}

function readCaller(): VacationCaller {
  return { tenantScope: tenantScope([TENANT]), permissions: ["Mailboxes.Mailbox.Read"] };
}

function writeCaller(): VacationCaller {
  return { tenantScope: tenantScope([TENANT]), permissions: [VACATION_WRITE_PERMISSION] };
}

describe("Vacation schedule input (T-0386)", () => {
  it("parses start/end, OoO message, and forwarding target", () => {
    expect(
      parseVacationInput({
        mailboxId: "mbx-1",
        startsAt: "2026-10-01T00:00:00.000Z",
        endsAt: "2026-10-08T00:00:00.000Z",
        oooMessage: "Out of office.",
        forwardTo: "cover@example.invalid",
      }),
    ).toMatchObject({ mailboxId: "mbx-1", forwardTo: "cover@example.invalid" });
  });

  it("rejects endsAt at or before startsAt", () => {
    expect(() =>
      parseVacationInput({
        mailboxId: "mbx-1",
        startsAt: "2026-10-08T00:00:00.000Z",
        endsAt: "2026-10-01T00:00:00.000Z",
        oooMessage: "Out of office.",
      }),
    ).toThrow(/endsAt must be after startsAt/);
  });

  it("rejects a missing OoO message and a malformed forwarding target", () => {
    expect(() =>
      parseVacationInput({
        mailboxId: "mbx-1",
        startsAt: "2026-10-01T00:00:00.000Z",
        endsAt: "2026-10-08T00:00:00.000Z",
        oooMessage: "  ",
      }),
    ).toThrow(/oooMessage is required/);
    expect(() =>
      parseVacationInput({
        mailboxId: "mbx-1",
        startsAt: "2026-10-01T00:00:00.000Z",
        endsAt: "2026-10-08T00:00:00.000Z",
        oooMessage: "Out of office.",
        forwardTo: "not-an-address",
      }),
    ).toThrow(/forwardTo must be a valid SMTP address/);
  });

  it("maps scheduled rows to upcoming and active rows to active", () => {
    expect(getVacationDisplayStatus(SCHEDULED)).toBe("upcoming");
    expect(getVacationDisplayStatus(ACTIVE)).toBe("active");
    expect(getVacationDisplayStatus({ ...SCHEDULED, state: "ended" })).toBe("ended");
    expect(getVacationDisplayStatus({ ...SCHEDULED, state: "failed" })).toBe("failed");
  });
});

describe("Vacation scheduler jobs (T-0386)", () => {
  it("encodes the window instant as a 6-field cron", () => {
    expect(cronFromInstant("2026-10-01T00:00:00.000Z")).toBe("0 0 0 1 10 *");
    expect(cronFromInstant("2026-10-08T09:30:15.000Z")).toBe("15 30 9 8 10 *");
  });

  it("registers the revert as a scheduler job via the EPIC-007 tick", async () => {
    const scheduler = new FakeScheduler();
    const jobs = await registerVacationSchedulerJobs(scheduler, SCHEDULED, ["enable", "revert"]);

    expect(jobs).toHaveLength(2);
    expect(scheduler.created).toHaveLength(2);
    const revert = jobs.find((job) => job.id === "vacation-vac-1-revert")!;
    expect(revert.command).toBe(VACATION_SCHEDULE_COMMAND);
    expect(revert.type).toBe("custom-script");
    expect(revert.nextRunAt).toBe(SCHEDULED.endsAt);
    expect(revert.parameters).toMatchObject({
      vacationScheduleId: "vac-1",
      tenantId: TENANT,
      mailboxId: "mbx-1",
      phase: "revert",
    });
    expect(typeof revert.parameters["notAfter"]).toBe("string");
    const enable = buildVacationSchedulerJob(SCHEDULED, "enable");
    expect(enable.nextRunAt).toBe(SCHEDULED.startsAt);
    expect(enable.parameters).toMatchObject({ phase: "enable" });
  });
});

describe("Vacation schedule routes (T-0386)", () => {
  it("exposes GET/POST list and DELETE End now paths", () => {
    const routes = createVacationScheduleRoutes({
      store: new FakeVacationStore(),
      apply: new FakeApplyProvider(),
      resolveCaller: readCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${VACATION_SCHEDULES_PATH}`,
      `POST ${VACATION_SCHEDULES_PATH}`,
      `DELETE ${VACATION_SCHEDULE_PATH}`,
    ]);
  });

  it("lists schedules as active/upcoming", async () => {
    const routes = createVacationScheduleRoutes({
      store: new FakeVacationStore(),
      apply: new FakeApplyProvider(),
      resolveCaller: readCaller,
    });

    const response = await routes[0]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/vacation-schedules`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as { tenantId: string; items: Array<{ status: string }> };
    expect(body.tenantId).toBe(TENANT);
    expect(body.items.map((item) => item.status)).toEqual(["upcoming"]);
  });

  it("creates a future schedule and registers enable + revert jobs", async () => {
    const store = new FakeVacationStore();
    const scheduler = new FakeScheduler();
    const routes = createVacationScheduleRoutes({
      store,
      apply: new FakeApplyProvider(),
      scheduler,
      resolveCaller: writeCaller,
      now: () => "2026-09-28T00:00:00.000Z",
      newId: () => "vac-new",
    });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/vacation-schedules`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: {
        mailboxId: "mbx-9",
        startsAt: "2026-10-01T00:00:00.000Z",
        endsAt: "2026-10-08T00:00:00.000Z",
        oooMessage: "Out of office.",
        forwardTo: "cover@example.invalid",
      },
    });

    expect(response.status).toBe(201);
    const body = response.body as { schedule: { id: string; status: string } };
    expect(body.schedule.id).toBe("vac-new");
    expect(body.schedule.status).toBe("upcoming");
    expect(scheduler.created.map((job) => job.id)).toEqual([
      "vacation-vac-new-enable",
      "vacation-vac-new-revert",
    ]);
  });

  it("rejects a window that already ended with 400", async () => {
    const routes = createVacationScheduleRoutes({
      store: new FakeVacationStore(),
      apply: new FakeApplyProvider(),
      resolveCaller: writeCaller,
      now: () => "2026-11-01T00:00:00.000Z",
    });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/vacation-schedules`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: {
          mailboxId: "mbx-9",
          startsAt: "2026-10-01T00:00:00.000Z",
          endsAt: "2026-10-08T00:00:00.000Z",
          oooMessage: "Out of office.",
        },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("End now reverts immediately, is audited, and carries the mailbox operation", async () => {
    const store = new FakeVacationStore();
    store.rows.set(ACTIVE.id, ACTIVE);
    const apply = new FakeApplyProvider();
    apply.outcome = REVERT_RESULT;
    const scheduler = new FakeScheduler();
    const routes = createVacationScheduleRoutes({
      store,
      apply,
      scheduler,
      resolveCaller: writeCaller,
    });

    const response = await routes[2]!.handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/vacation-schedules/vac-1`,
      params: { tenantId: TENANT, scheduleId: "vac-1" },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      ended: boolean;
      schedule: { status: string };
      auditEvent?: { action: string };
      mailboxOperation?: { operation: string; state: string };
    };
    expect(body.ended).toBe(true);
    expect(body.schedule.status).toBe("ended");
    expect(body.auditEvent?.action).toBe("vacation.revert");
    expect(body.mailboxOperation).toMatchObject({ operation: "revert", state: "applied" });
    expect(apply.calls[0]).toMatchObject({ tenantId: TENANT, phase: "revert" });
    expect(scheduler.disabled).toEqual(["vacation-vac-1-enable", "vacation-vac-1-revert"]);
  });

  it("a failed revert is recorded as failed and raises an alert instead of silently ending", async () => {
    const store = new FakeVacationStore();
    store.rows.set(ACTIVE.id, ACTIVE);
    const apply = new FakeApplyProvider();
    apply.outcome = {
      success: false,
      scheduleState: "failed",
      auditEvent: {
        id: "audit-3",
        tenantId: TENANT,
        action: "vacation.revert",
        targetId: "vac-1",
        targetName: "mbx-1",
        timestamp: "2026-10-08T00:00:00.000Z",
      },
      mailboxOperation: {
        id: "op-3",
        tenantId: TENANT,
        mailboxId: "mbx-1",
        operation: "revert",
        state: "failed",
        at: "2026-10-08T00:00:00.000Z",
      },
      alert: {
        kind: "vacation.revert",
        severity: "High",
        tenantId: TENANT,
        scheduleId: "vac-1",
        mailboxId: "mbx-1",
        reason: "revert failed",
        timestamp: "2026-10-08T00:00:00.000Z",
      },
    };
    const routes = createVacationScheduleRoutes({
      store,
      apply,
      resolveCaller: writeCaller,
    });

    await expect(
      routes[2]!.handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/vacation-schedules/vac-1`,
        params: { tenantId: TENANT, scheduleId: "vac-1" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 502 });

    expect((await store.getVacationSchedule(TENANT, "vac-1"))?.state).toBe("failed");
    expect(apply.outcome.alert?.severity).toBe("High");
  });

  it("End now on a schedule that never started cancels it without running the revert worker", async () => {
    const store = new FakeVacationStore();
    const apply = new FakeApplyProvider();
    const scheduler = new FakeScheduler();
    const routes = createVacationScheduleRoutes({ store, apply, scheduler, resolveCaller: writeCaller });

    const response = await routes[2]!.handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/vacation-schedules/vac-1`,
      params: { tenantId: TENANT, scheduleId: "vac-1" },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ended: true, reason: "never_started", schedule: { status: "ended" } });
    expect(apply.calls).toHaveLength(0);
    expect((await store.getVacationSchedule(TENANT, "vac-1"))?.state).toBe("ended");
    expect(scheduler.disabled).toEqual(["vacation-vac-1-enable", "vacation-vac-1-revert"]);
  });

  it("marks an immediate-start schedule failed when the enable worker throws", async () => {
    const store = new FakeVacationStore();
    const apply = new FakeApplyProvider();
    apply.applyVacationPhase = async () => {
      throw new Error("worker unavailable");
    };
    const routes = createVacationScheduleRoutes({
      store,
      apply,
      resolveCaller: writeCaller,
      now: () => "2026-10-02T00:00:00.000Z",
      newId: () => "vac-now",
    });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/vacation-schedules`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: {
          mailboxId: "mbx-9",
          startsAt: "2026-10-01T00:00:00.000Z",
          endsAt: "2026-10-08T00:00:00.000Z",
          oooMessage: "Out of office.",
        },
      }),
    ).rejects.toThrow("worker unavailable");

    expect((await store.getVacationSchedule(TENANT, "vac-now"))?.state).toBe("failed");
  });

  it("rejects callers missing Mailboxes.Vacation.ReadWrite with 403", async () => {
    const routes = createVacationScheduleRoutes({
      store: new FakeVacationStore(),
      apply: new FakeApplyProvider(),
      resolveCaller: readCaller,
    });

    await expect(
      routes[2]!.handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/vacation-schedules/vac-1`,
        params: { tenantId: TENANT, scheduleId: "vac-1" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
