// T-0643 — licence optimization classification (unused/overused/expiring).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INACTIVITY_DAYS,
  classifyLicenseOptimization,
  type LicenseAssignment,
  type LicenseOptimizationInput,
} from "./license-optimization.js";

const NOW = new Date("2026-01-31T00:00:00.000Z");
const daysBefore = (days: number): string =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
const daysAfter = (days: number): string =>
  new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

const assignment = (overrides: Partial<LicenseAssignment> = {}): LicenseAssignment => ({
  userId: "user-1",
  userPrincipalName: "user.one@example.invalid",
  displayName: "User One",
  skuId: "sku-e5",
  skuPartNumber: "SPE_E5",
  lastActivityDate: daysBefore(40),
  ...overrides,
});

describe("classifyLicenseOptimization unused", () => {
  it("defaults the inactivity window to 30 days", () => {
    const result = classifyLicenseOptimization({}, { now: NOW });
    expect(result.inactivityDays).toBe(DEFAULT_INACTIVITY_DAYS);
    expect(result.inactivityDays).toBe(30);
  });

  it("marks an assignment with no activity inside the window as unused", () => {
    const result = classifyLicenseOptimization(
      { assignments: [assignment({ lastActivityDate: daysBefore(40) })] },
      { now: NOW },
    );
    expect(result.unused).toHaveLength(1);
    expect(result.unused[0]?.skuPartNumber).toBe("SPE_E5");
    expect(result.unused[0]?.affectedUsers.map((u) => u.userPrincipalName)).toEqual([
      "user.one@example.invalid",
    ]);
  });

  it("keeps an assignment active inside the window", () => {
    const result = classifyLicenseOptimization(
      { assignments: [assignment({ lastActivityDate: daysBefore(29) })] },
      { now: NOW },
    );
    expect(result.unused).toEqual([]);
  });

  it("treats a missing or unparseable activity date as unused", () => {
    const result = classifyLicenseOptimization(
      {
        assignments: [
          assignment({ userId: "user-1", lastActivityDate: null }),
          assignment({ userId: "user-2", userPrincipalName: "user.two@example.invalid", lastActivityDate: "not-a-date" }),
        ],
      },
      { now: NOW },
    );
    expect(result.unused).toHaveLength(1);
    expect(result.unused[0]?.affectedUsers).toHaveLength(2);
  });

  it("honours a custom inactivity window", () => {
    const input: LicenseOptimizationInput = {
      assignments: [assignment({ lastActivityDate: daysBefore(10) })],
    };
    expect(classifyLicenseOptimization(input, { inactivityDays: 7, now: NOW }).unused).toHaveLength(1);
    expect(classifyLicenseOptimization(input, { inactivityDays: 30, now: NOW }).unused).toEqual([]);
  });

  it("groups unused users by SKU and sorts them", () => {
    const result = classifyLicenseOptimization(
      {
        assignments: [
          assignment({ userId: "user-2", userPrincipalName: "user.two@example.invalid" }),
          assignment({ userId: "user-1", userPrincipalName: "user.one@example.invalid" }),
          assignment({ skuId: "sku-visio", skuPartNumber: "VISIOCLIENT", userId: "user-3", userPrincipalName: "user.three@example.invalid" }),
        ],
      },
      { now: NOW },
    );
    expect(result.unused.map((row) => row.skuPartNumber)).toEqual(["SPE_E5", "VISIOCLIENT"]);
    expect(result.unused[0]?.affectedUsers.map((u) => u.userId)).toEqual(["user-1", "user-2"]);
  });
});

describe("classifyLicenseOptimization overused", () => {
  it("groups assignment errors by SKU and error, listing affected users", () => {
    const result = classifyLicenseOptimization(
      {
        assignmentErrors: [
          { userId: "user-1", userPrincipalName: "a@example.invalid", displayName: "A", skuId: "sku-e5", skuPartNumber: "SPE_E5", error: "over-allocated" },
          { userId: "user-2", userPrincipalName: "b@example.invalid", displayName: "B", skuId: "sku-e5", skuPartNumber: "SPE_E5", error: "over-allocated" },
          { userId: "user-3", userPrincipalName: "c@example.invalid", displayName: "C", skuId: "sku-e5", skuPartNumber: "SPE_E5", error: "suspended" },
        ],
      },
      { now: NOW },
    );
    expect(result.overused).toHaveLength(2);
    expect(result.overused[0]).toMatchObject({ skuPartNumber: "SPE_E5", error: "over-allocated" });
    expect(result.overused[0]?.affectedUsers.map((u) => u.userId)).toEqual(["user-1", "user-2"]);
    expect(result.overused[1]).toMatchObject({ error: "suspended" });
  });

  it("is empty when there are no assignment errors", () => {
    expect(classifyLicenseOptimization({}, { now: NOW }).overused).toEqual([]);
  });
});

describe("classifyLicenseOptimization expiring", () => {
  it("computes daysRemaining and lists the SKU's affected users", () => {
    const result = classifyLicenseOptimization(
      {
        assignments: [assignment({ lastActivityDate: daysBefore(1) })],
        expirations: [
          { skuId: "sku-e5", skuPartNumber: "SPE_E5", expirationDateTime: daysAfter(10) },
        ],
      },
      { now: NOW },
    );
    expect(result.expiring).toHaveLength(1);
    expect(result.expiring[0]?.daysRemaining).toBe(10);
    expect(result.expiring[0]?.affectedUsers.map((u) => u.userId)).toEqual(["user-1"]);
  });

  it("excludes expiries already in the past", () => {
    const result = classifyLicenseOptimization(
      {
        expirations: [
          { skuId: "sku-e5", skuPartNumber: "SPE_E5", expirationDateTime: daysBefore(1) },
        ],
      },
      { now: NOW },
    );
    expect(result.expiring).toEqual([]);
  });

  it("sorts expiring rows by soonest expiry", () => {
    const result = classifyLicenseOptimization(
      {
        expirations: [
          { skuId: "sku-later", skuPartNumber: "LATER", expirationDateTime: daysAfter(40) },
          { skuId: "sku-sooner", skuPartNumber: "SOONER", expirationDateTime: daysAfter(5) },
        ],
      },
      { now: NOW },
    );
    expect(result.expiring.map((row) => row.skuPartNumber)).toEqual(["SOONER", "LATER"]);
  });
});

describe("classifyLicenseOptimization result", () => {
  it("is always advisory and carries the tenant and window", () => {
    const result = classifyLicenseOptimization(
      { tenantId: "tenant-test", generatedAt: "2026-01-30T00:00:00.000Z" },
      { now: NOW },
    );
    expect(result.advisory).toBe(true);
    expect(result.tenantId).toBe("tenant-test");
    expect(result.generatedAt).toBe("2026-01-30T00:00:00.000Z");
    expect(result.unused).toEqual([]);
    expect(result.overused).toEqual([]);
    expect(result.expiring).toEqual([]);
  });
});
