// T-0562 — alert rule CRUD and enable/disable routes.
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { RbacErrorCodes, type Caller } from "../rbac/authorize.js";
import { ALL_TENANTS } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  seedBuiltinRules,
  type AlertRule,
} from "../domain/alerts/builtin-catalog.js";
import {
  ALERT_RULES_OPENAPI,
  ALERT_RULES_PATH,
  ALERT_RULES_READ_PERMISSION,
  ALERT_RULES_WRITE_PERMISSION,
  ALERT_RULE_PATH,
  ALERT_RULE_TOGGLE_PATH,
  createAlertRulesRoutes,
  type AlertRuleCreate,
  type AlertRulePatch,
  type AlertRulesStore,
} from "./alert-rules.js";

class FakeStore implements AlertRulesStore {
  rules: AlertRule[];

  constructor(rules: AlertRule[] = seedBuiltinRules()) {
    this.rules = rules.map((rule) => ({ ...rule, channels: [...rule.channels] }));
  }

  async listRules(): Promise<readonly AlertRule[]> {
    return this.rules;
  }

  async getRule(ruleId: string): Promise<AlertRule | undefined> {
    return this.rules.find((rule) => rule.id === ruleId);
  }

  async createRule(input: AlertRuleCreate): Promise<AlertRule> {
    const rule: AlertRule = {
      id: input.id,
      name: input.name,
      source: input.source,
      severity: input.severity,
      scope: input.scope,
      channels: [...input.channels],
      enabled: input.enabled ?? false,
      scriptMode: input.scriptMode ?? false,
      scheduleId: input.scheduleId ?? null,
      lastFiredAt: null,
      builtIn: false,
    };
    this.rules.push(rule);
    return rule;
  }

  async updateRule(ruleId: string, patch: AlertRulePatch): Promise<AlertRule | undefined> {
    const index = this.rules.findIndex((rule) => rule.id === ruleId);
    if (index < 0) return undefined;
    const current = this.rules[index]!;
    const updated: AlertRule = {
      ...current,
      ...patch,
      channels: patch.channels ? [...patch.channels] : current.channels,
    };
    this.rules[index] = updated;
    return updated;
  }

  async deleteRule(ruleId: string): Promise<boolean> {
    const index = this.rules.findIndex((rule) => rule.id === ruleId);
    if (index < 0) return false;
    this.rules.splice(index, 1);
    return true;
  }

  async setRuleEnabled(ruleId: string, enabled: boolean): Promise<AlertRule | undefined> {
    const index = this.rules.findIndex((rule) => rule.id === ruleId);
    if (index < 0) return undefined;
    const updated: AlertRule = { ...this.rules[index]!, enabled };
    this.rules[index] = updated;
    return updated;
  }
}

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function ctx(
  method: string,
  path: string,
  options: { params?: Record<string, string>; body?: unknown } = {},
): RequestContext {
  return {
    correlationId: "corr-1",
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    params: options.params ?? {},
    body: options.body,
  };
}

function routeFor(
  options: Parameters<typeof createAlertRulesRoutes>[0],
  method: string,
  path: string,
) {
  const route = createAlertRulesRoutes(options).find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

function makeOptions(store: AlertRulesStore, overrides: Record<string, unknown> = {}) {
  return {
    store,
    resolveCaller: () => adminCaller(),
    authorize: () => {},
    generateId: () => "custom-1",
    ...overrides,
  };
}

describe("GET /v1/alert-rules (T-0562)", () => {
  it("returns built-in and custom rules with the §3.1 columns", async () => {
    const store = new FakeStore();
    await store.createRule({
      id: "custom-1",
      name: "My rule",
      source: "runs",
      severity: "Low",
      scope: "group",
      channels: ["webhook"],
    });
    const route = routeFor(makeOptions(store), "GET", ALERT_RULES_PATH);

    const response = await route.handler(ctx("GET", ALERT_RULES_PATH));
    expect(response.status).toBe(200);
    const { rules } = response.body as { rules: Record<string, unknown>[] };
    expect(rules).toHaveLength(13);

    const builtin = rules.find((rule) => rule["id"] === "run-failed")!;
    expect(builtin["name"]).toBe("Assessment run failed");
    expect(builtin["source"]).toBe("runs");
    expect(builtin["severity"]).toBe("High");
    expect(builtin["scope"]).toBe("tenant");
    expect(builtin["channels"]).toEqual(["email", "webhook"]);
    expect(builtin["state"]).toBe("Disabled");
    expect(builtin["lastFiredAt"]).toBeNull();
    expect(builtin["builtIn"]).toBe(true);

    const custom = rules.find((rule) => rule["id"] === "custom-1")!;
    expect(custom["builtIn"]).toBe(false);
    expect(custom["scope"]).toBe("group");
    expect(custom["channels"]).toEqual(["webhook"]);
    expect(custom["state"]).toBe("Disabled");
  });

  it("requires alerts.read", async () => {
    const seen: string[] = [];
    const route = routeFor(
      makeOptions(new FakeStore(), {
        authorize: (_caller: Caller, permission: string) => {
          seen.push(permission);
        },
      }),
      "GET",
      ALERT_RULES_PATH,
    );
    await route.handler(ctx("GET", ALERT_RULES_PATH));
    expect(seen).toEqual([ALERT_RULES_READ_PERMISSION]);
  });

  it("returns 401 without a caller", async () => {
    const route = routeFor(makeOptions(new FakeStore(), { resolveCaller: () => undefined }), "GET", ALERT_RULES_PATH);
    await expect(route.handler(ctx("GET", ALERT_RULES_PATH))).rejects.toMatchObject({ status: 401 });
  });
});

describe("POST /v1/alert-rules (T-0562)", () => {
  it("creates a custom rule with scope and channels", async () => {
    const store = new FakeStore([]);
    const route = routeFor(makeOptions(store), "POST", ALERT_RULES_PATH);

    const response = await route.handler(
      ctx("POST", ALERT_RULES_PATH, {
        body: {
          name: "Group drift",
          source: "drift",
          severity: "Medium",
          scope: "group",
          channels: ["email", "webhook"],
        },
      }),
    );

    expect(response.status).toBe(201);
    const { rule } = response.body as { rule: AlertRule };
    expect(rule.id).toBe("custom-1");
    expect(rule.builtIn).toBe(false);
    expect(rule.scope).toBe("group");
    expect(rule.channels).toEqual(["email", "webhook"]);
    expect(rule.enabled).toBe(false);
    expect(store.rules).toHaveLength(1);
  });

  it("requires alerts.write and audits the create", async () => {
    const seen: string[] = [];
    const audits: Record<string, unknown>[] = [];
    const route = routeFor(
      makeOptions(new FakeStore([]), {
        authorize: (_caller: Caller, permission: string) => {
          seen.push(permission);
        },
        audit: { record: (event: Record<string, unknown>) => { audits.push(event); } },
      }),
      "POST",
      ALERT_RULES_PATH,
    );
    await route.handler(
      ctx("POST", ALERT_RULES_PATH, {
        body: { name: "n", source: "s", severity: "Info", scope: "tenant", channels: ["email"] },
      }),
    );
    expect(seen).toEqual([ALERT_RULES_WRITE_PERMISSION]);
    expect(audits[0]!["action"]).toBe("alert-rule.create");
    expect(audits[0]!["ruleId"]).toBe("custom-1");
    expect(audits[0]!["correlationId"]).toBe("corr-1");
  });

  it("rejects an unknown scope, channel, or missing name", async () => {
    const route = routeFor(makeOptions(new FakeStore([])), "POST", ALERT_RULES_PATH);
    const base = { name: "n", source: "s", severity: "Info", channels: ["email"] };
    await expect(
      route.handler(ctx("POST", ALERT_RULES_PATH, { body: { ...base, scope: "fleet" } })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.handler(ctx("POST", ALERT_RULES_PATH, { body: { ...base, scope: "tenant", channels: ["sms"] } })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.handler(ctx("POST", ALERT_RULES_PATH, { body: { ...base, name: "", scope: "tenant" } })),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("PATCH and DELETE /v1/alert-rules/{ruleId} (T-0562)", () => {
  it("edits a rule's scope, channels, and severity", async () => {
    const store = new FakeStore();
    const route = routeFor(makeOptions(store), "PATCH", ALERT_RULE_PATH);
    const response = await route.handler(
      ctx("PATCH", ALERT_RULE_PATH, {
        params: { ruleId: "run-failed" },
        body: { severity: "Critical", scope: "group", channels: ["psa"] },
      }),
    );
    expect(response.status).toBe(200);
    const { rule } = response.body as { rule: AlertRule };
    expect(rule.severity).toBe("Critical");
    expect(rule.scope).toBe("group");
    expect(rule.channels).toEqual(["psa"]);
    expect(rule.builtIn).toBe(true);
  });

  it("returns 404 for an unknown rule", async () => {
    const route = routeFor(makeOptions(new FakeStore()), "PATCH", ALERT_RULE_PATH);
    await expect(
      route.handler(ctx("PATCH", ALERT_RULE_PATH, { params: { ruleId: "missing" }, body: { name: "x" } })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("deletes a rule and audits it", async () => {
    const store = new FakeStore();
    const audits: Record<string, unknown>[] = [];
    const route = routeFor(
      makeOptions(store, { audit: { record: (e: Record<string, unknown>) => { audits.push(e); } } }),
      "DELETE",
      ALERT_RULE_PATH,
    );
    const response = await route.handler(
      ctx("DELETE", ALERT_RULE_PATH, { params: { ruleId: "run-partial" } }),
    );
    expect(response.status).toBe(200);
    expect(store.rules.some((rule) => rule.id === "run-partial")).toBe(false);
    expect(audits[0]!["action"]).toBe("alert-rule.delete");
    expect(audits[0]!["ruleId"]).toBe("run-partial");
  });

  it("returns 404 deleting an unknown rule", async () => {
    const route = routeFor(makeOptions(new FakeStore()), "DELETE", ALERT_RULE_PATH);
    await expect(
      route.handler(ctx("DELETE", ALERT_RULE_PATH, { params: { ruleId: "missing" } })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("propagates a structured 403 from the authorizer and does not mutate", async () => {
    const store = new FakeStore();
    const deny = () => {
      throw new AppError(RbacErrorCodes.forbidden, "forbidden", 403);
    };
    const route = routeFor(makeOptions(store, { authorize: deny }), "DELETE", ALERT_RULE_PATH);
    await expect(
      route.handler(ctx("DELETE", ALERT_RULE_PATH, { params: { ruleId: "run-failed" } })),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.rules.some((rule) => rule.id === "run-failed")).toBe(true);
  });
});

describe("POST /v1/alert-rules/{ruleId}/toggle (T-0562)", () => {
  it("flips a built-in and writes an audit event", async () => {
    const store = new FakeStore();
    const audits: Record<string, unknown>[] = [];
    const route = routeFor(
      makeOptions(store, { audit: { record: (e: Record<string, unknown>) => { audits.push(e); } } }),
      "POST",
      ALERT_RULE_TOGGLE_PATH,
    );

    const response = await route.handler(
      ctx("POST", ALERT_RULE_TOGGLE_PATH, { params: { ruleId: "run-failed" } }),
    );
    expect(response.status).toBe(200);
    const { rule } = response.body as { rule: AlertRule };
    expect(rule.enabled).toBe(true);
    expect(rule.state).toBe("Enabled");
    expect(store.rules.find((r) => r.id === "run-failed")!.enabled).toBe(true);

    expect(audits).toHaveLength(1);
    expect(audits[0]!["action"]).toBe("alert-rule.toggle");
    expect(audits[0]!["ruleId"]).toBe("run-failed");
    expect(audits[0]!["enabled"]).toBe(true);
  });

  it("honors an explicit enabled value and requires alerts.write", async () => {
    const seen: string[] = [];
    const store = new FakeStore();
    const route = routeFor(
      makeOptions(store, {
        authorize: (_caller: Caller, permission: string) => {
          seen.push(permission);
        },
      }),
      "POST",
      ALERT_RULE_TOGGLE_PATH,
    );
    await route.handler(
      ctx("POST", ALERT_RULE_TOGGLE_PATH, { params: { ruleId: "run-failed" }, body: { enabled: false } }),
    );
    expect(seen).toEqual([ALERT_RULES_WRITE_PERMISSION]);
    expect(store.rules.find((r) => r.id === "run-failed")!.enabled).toBe(false);
  });

  it("returns 404 for an unknown rule", async () => {
    const route = routeFor(makeOptions(new FakeStore()), "POST", ALERT_RULE_TOGGLE_PATH);
    await expect(
      route.handler(ctx("POST", ALERT_RULE_TOGGLE_PATH, { params: { ruleId: "missing" } })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("alert-rules OpenAPI fragment (T-0562)", () => {
  it("publishes CRUD and toggle operations with the alerts permissions", () => {
    const paths = ALERT_RULES_OPENAPI.paths;
    expect(Object.keys(paths)).toEqual([
      "/alert-rules",
      "/alert-rules/{ruleId}",
      "/alert-rules/{ruleId}/toggle",
    ]);
    expect(paths["/alert-rules"].get.permission).toBe(ALERT_RULES_READ_PERMISSION);
    expect(paths["/alert-rules"].post.permission).toBe(ALERT_RULES_WRITE_PERMISSION);
    expect(paths["/alert-rules/{ruleId}"].patch.permission).toBe(ALERT_RULES_WRITE_PERMISSION);
    expect(paths["/alert-rules/{ruleId}"].delete.permission).toBe(ALERT_RULES_WRITE_PERMISSION);
    expect(paths["/alert-rules/{ruleId}/toggle"].post.permission).toBe(ALERT_RULES_WRITE_PERMISSION);
  });
});
