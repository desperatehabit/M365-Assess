// T-0626 — audit exclusion-window guard: active-window suppression, auto-expiry
// by endsAt, tenant scoping, and soft-delete.
import { describe, expect, it } from "vitest";
import type { AuditExclusionWindow } from "@m365-assess/db";
import {
  findActiveAuditExclusionWindow,
  isAuditSearchSuppressed,
  type AuditExclusionWindowStore,
} from "./audit-exclusion.js";

const TENANT = "tenant-test";
const OTHER_TENANT = "tenant-other";

function windowFixture(overrides: Partial<AuditExclusionWindow> = {}): AuditExclusionWindow {
  return {
    id: "window-1",
    tenantId: TENANT,
    startsAt: "2026-09-29T00:00:00.000Z",
    endsAt: "2026-10-06T00:00:00.000Z",
    reason: "vacation",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

class FakeWindowStore implements AuditExclusionWindowStore {
  constructor(private readonly windows: readonly AuditExclusionWindow[] = []) {}

  async listAuditExclusionWindows(tenantId: string): Promise<AuditExclusionWindow[]> {
    return this.windows.filter((window) => window.tenantId === tenantId);
  }
}

describe("findActiveAuditExclusionWindow (T-0626)", () => {
  it("reports the window when the instant falls inside it", async () => {
    const store = new FakeWindowStore([windowFixture()]);
    const active = await findActiveAuditExclusionWindow(
      store,
      TENANT,
      "2026-10-01T12:00:00.000Z",
    );
    expect(active?.id).toBe("window-1");
  });

  it("treats startsAt as inclusive", async () => {
    const store = new FakeWindowStore([windowFixture()]);
    const active = await findActiveAuditExclusionWindow(
      store,
      TENANT,
      "2026-09-29T00:00:00.000Z",
    );
    expect(active?.id).toBe("window-1");
  });

  it("auto-expires the window at endsAt", async () => {
    const store = new FakeWindowStore([windowFixture()]);
    expect(
      await findActiveAuditExclusionWindow(store, TENANT, "2026-10-06T00:00:00.000Z"),
    ).toBeUndefined();
    expect(
      await findActiveAuditExclusionWindow(store, TENANT, "2026-10-07T00:00:00.000Z"),
    ).toBeUndefined();
  });

  it("does not suppress before the window starts", async () => {
    const store = new FakeWindowStore([windowFixture()]);
    expect(
      await findActiveAuditExclusionWindow(store, TENANT, "2026-09-28T23:59:59.999Z"),
    ).toBeUndefined();
  });

  it("ignores windows belonging to another tenant", async () => {
    const store = new FakeWindowStore([windowFixture({ tenantId: OTHER_TENANT })]);
    expect(
      await findActiveAuditExclusionWindow(store, TENANT, "2026-10-01T12:00:00.000Z"),
    ).toBeUndefined();
  });

  it("ignores soft-deleted windows", async () => {
    const store = new FakeWindowStore([windowFixture({ deletedAt: "2026-09-30T00:00:00.000Z" })]);
    expect(
      await findActiveAuditExclusionWindow(store, TENANT, "2026-10-01T12:00:00.000Z"),
    ).toBeUndefined();
  });

  it("returns undefined when the tenant has no windows", async () => {
    const store = new FakeWindowStore([]);
    expect(
      await findActiveAuditExclusionWindow(store, TENANT, "2026-10-01T12:00:00.000Z"),
    ).toBeUndefined();
  });

  it("accepts a Date instant", async () => {
    const store = new FakeWindowStore([windowFixture()]);
    const active = await findActiveAuditExclusionWindow(
      store,
      TENANT,
      new Date("2026-10-01T12:00:00.000Z"),
    );
    expect(active?.id).toBe("window-1");
  });

  it("rejects an unparseable instant", async () => {
    const store = new FakeWindowStore([windowFixture()]);
    await expect(
      findActiveAuditExclusionWindow(store, TENANT, "not-a-date"),
    ).rejects.toThrow("invalid instant");
  });
});

describe("isAuditSearchSuppressed (T-0626)", () => {
  it("is true inside an active window and false outside it", async () => {
    const store = new FakeWindowStore([windowFixture()]);
    expect(await isAuditSearchSuppressed(store, TENANT, "2026-10-01T12:00:00.000Z")).toBe(true);
    expect(await isAuditSearchSuppressed(store, TENANT, "2026-10-06T00:00:00.000Z")).toBe(false);
    expect(await isAuditSearchSuppressed(store, TENANT, "2026-09-01T00:00:00.000Z")).toBe(false);
  });

  it("is false when the only window is expired", async () => {
    const store = new FakeWindowStore([
      windowFixture({
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-09-02T00:00:00.000Z",
      }),
    ]);
    expect(await isAuditSearchSuppressed(store, TENANT, "2026-10-01T12:00:00.000Z")).toBe(false);
  });
});
