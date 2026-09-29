import { describe, expect, it } from "vitest";
import {
  AUDIT_SEARCH_SCHEDULE_COMMAND,
  AUDIT_SEARCH_SCHEDULE_TYPE,
  buildAuditSearchScheduleInput,
  parseAuditSearchFilters,
} from "./audit-search-schedule.js";

describe("parseAuditSearchFilters (EPIC-032 §3.1)", () => {
  it("accepts a full §3.1 filter shape and trims string values", () => {
    const filters = parseAuditSearchFilters({
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-28T00:00:00.000Z",
      user: "  alice  ",
      activity: "Update user",
      workload: "Exchange",
      ip: "203.0.113.10",
    });
    expect(filters).toEqual({
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-28T00:00:00.000Z",
      user: "alice",
      activity: "Update user",
      workload: "Exchange",
      ip: "203.0.113.10",
    });
  });

  it("accepts an empty filter object", () => {
    expect(parseAuditSearchFilters({})).toEqual({});
  });

  it("rejects non-object filters", () => {
    expect(() => parseAuditSearchFilters("x")).toThrow();
    expect(() => parseAuditSearchFilters(null)).toThrow();
    expect(() => parseAuditSearchFilters([])).toThrow();
  });

  it("rejects unknown filter fields", () => {
    expect(() => parseAuditSearchFilters({ severity: "high" })).toThrow(/unknown filter field/);
  });

  it("rejects non-string and empty string values", () => {
    expect(() => parseAuditSearchFilters({ user: 42 })).toThrow();
    expect(() => parseAuditSearchFilters({ user: "   " })).toThrow();
  });

  it("rejects unparseable dates", () => {
    expect(() => parseAuditSearchFilters({ startDate: "not-a-date" })).toThrow(/parseable/);
  });

  it("rejects a date range where startDate is after endDate", () => {
    expect(() =>
      parseAuditSearchFilters({
        startDate: "2026-09-28T00:00:00.000Z",
        endDate: "2026-09-01T00:00:00.000Z",
      }),
    ).toThrow(/must not be after/);
  });
});

describe("buildAuditSearchScheduleInput (EPIC-032 §4.1, §5)", () => {
  it("builds a tenant-targeted schedule that re-runs the saved search", () => {
    const input = buildAuditSearchScheduleInput({
      search: {
        id: "search-1",
        name: "Failed sign-ins",
        filters: { workload: "Graph", activity: "SignIn" },
      },
      tenantId: "tenant-a",
      cron: "0 6 * * *",
      timezone: "UTC",
    });
    expect(input).toEqual({
      name: "Audit search: Failed sign-ins",
      type: AUDIT_SEARCH_SCHEDULE_TYPE,
      cron: "0 6 * * *",
      timezone: "UTC",
      targetScope: { type: "tenant", id: "tenant-a" },
      command: AUDIT_SEARCH_SCHEDULE_COMMAND,
      parameters: { searchId: "search-1", filters: { workload: "Graph", activity: "SignIn" } },
      enabled: true,
    });
  });

  it("uses the Search-AuditLog worker command and report schedule type", () => {
    expect(AUDIT_SEARCH_SCHEDULE_COMMAND).toBe("Search-AuditLog");
    expect(AUDIT_SEARCH_SCHEDULE_TYPE).toBe("report");
  });
});
