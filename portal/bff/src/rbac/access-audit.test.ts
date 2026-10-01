import { describe, expect, it } from "vitest";
import {
  ACCESS_AUDIT_ACTION,
  accessAuditEvent,
  recordAccessDecision,
  type AccessAuditDecision,
  type AccessAuditSink,
} from "./access-audit.js";

function decision(overrides: Partial<AccessAuditDecision> = {}): AccessAuditDecision {
  return {
    actorType: "user",
    actorId: "user-1",
    roles: ["readonly"],
    permission: "Tenant.Read",
    tenantId: "tenant-a",
    allowed: true,
    ip: "203.0.113.10",
    correlationId: "corr-1",
    ...overrides,
  };
}

function capturingSink(): { sink: AccessAuditSink; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  return { sink: async (event) => { events.push(event); }, events };
}

describe("recordAccessDecision", () => {
  it("writes an allow decision with every §4.5 field", async () => {
    const { sink, events } = capturingSink();
    await recordAccessDecision(sink, decision({ allowed: true }));

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event["actor"]).toBe("user-1");
    expect(event["actorType"]).toBe("user");
    expect(event["tenantId"]).toBe("tenant-a");
    expect(event["action"]).toBe(ACCESS_AUDIT_ACTION);
    expect(event["targetType"]).toBe("permission");
    expect(event["targetId"]).toBe("Tenant.Read");
    expect(event["result"]).toBe("success");
    expect(event["correlationId"]).toBe("corr-1");
    expect(event["source"]).toBe("request");
  });

  it("writes a deny decision with result failure", async () => {
    const { sink, events } = capturingSink();
    await recordAccessDecision(sink, decision({ allowed: false, permission: "Remediation.Apply" }));

    expect(events).toHaveLength(1);
    expect(events[0]!["result"]).toBe("failure");
    expect(events[0]!["targetId"]).toBe("Remediation.Apply");
  });

  it("carries roles, IP, and the check discriminator in the after blob", async () => {
    const { sink, events } = capturingSink();
    await recordAccessDecision(sink, decision(), "scope");

    const after = events[0]!["after"] as Record<string, unknown>;
    expect(after["roles"]).toEqual(["readonly"]);
    expect(after["ip"]).toBe("203.0.113.10");
    expect(after["allowed"]).toBe(true);
    expect(after["check"]).toBe("scope");
  });

  it("passes actorType through for api clients and system", async () => {
    const { sink, events } = capturingSink();
    await recordAccessDecision(sink, decision({ actorType: "apiClient", actorId: "client-9" }));
    await recordAccessDecision(sink, decision({ actorType: "system", actorId: null }));

    expect(events[0]!["actorType"]).toBe("apiClient");
    expect(events[0]!["actor"]).toBe("client-9");
    expect(events[1]!["actorType"]).toBe("system");
    expect(events[1]!["actor"]).toBeNull();
  });

  it("defaults the check discriminator to rbac", async () => {
    const { sink, events } = capturingSink();
    await recordAccessDecision(sink, decision());

    const after = events[0]!["after"] as Record<string, unknown>;
    expect(after["check"]).toBe("rbac");
  });

  it("writes exactly one append-only insert per decision", async () => {
    const calls: string[] = [];
    const sink: AccessAuditSink = async (event) => {
      calls.push(Object.keys(event).sort().join(","));
    };
    await recordAccessDecision(sink, decision({ allowed: true }));
    await recordAccessDecision(sink, decision({ allowed: false }));

    expect(calls).toHaveLength(2);
    for (const keys of calls) {
      expect(keys).not.toContain("id");
      expect(keys).not.toContain("update");
      expect(keys).not.toContain("delete");
    }
  });
});

describe("accessAuditEvent", () => {
  it("maps a null tenant and null ip without placeholders", () => {
    const event = accessAuditEvent(decision({ tenantId: null, ip: null }), "rbac");
    expect(event["tenantId"]).toBeNull();
    const after = event["after"] as Record<string, unknown>;
    expect(after["ip"]).toBeNull();
  });
});
