import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { ErrorCodes } from "./errors.js";
import { buildServer } from "./server.js";

// EPIC-029 alerting route groups are mounted in createApp (T-0859). Each probe goes
// through the real app (router, auth, RBAC, the SQLite-backed stores) and passes only
// when the route exists: an unmounted path answers with the router's
// `request.not_found`. A fresh app seeds the built-in catalog and channel configs on
// the first read.

const opened: { server: Server; app: App }[] = [];

afterEach(async () => {
  for (const { server, app } of opened.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});

async function serve() {
  const app = createApp({ ...loadConfig({}), devIdentityRole: "admin" }, { db: new Database(":memory:") });
  const server = buildServer({ routes: app.routes, authenticators: app.authenticators });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  opened.push({ server, app });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

interface Probe {
  readonly group: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const PROBES: readonly Probe[] = [
  { group: "alert-rules", method: "GET", path: "/v1/alert-rules" },
  {
    group: "alert-rules",
    method: "POST",
    path: "/v1/alert-rules",
    body: { name: "Portal rule", source: "runs", severity: "High", scope: "tenant", channels: ["email"] },
  },
  {
    group: "alert-rules",
    method: "PATCH",
    path: "/v1/alert-rules/run-failed",
    body: { severity: "Medium" },
  },
  { group: "alert-rules", method: "POST", path: "/v1/alert-rules/run-failed/toggle" },
  { group: "alert-rules", method: "DELETE", path: "/v1/alert-rules/run-partial" },
  { group: "alert-rules-test", method: "POST", path: "/v1/alert-rules/run-failed/test" },
  { group: "alert-events", method: "GET", path: "/v1/alert-events" },
  {
    group: "alert-events",
    method: "POST",
    path: "/v1/alert-rules/run-failed/snooze",
    body: { durationMinutes: 60 },
  },
  { group: "notifications", method: "GET", path: "/v1/notifications" },
  { group: "notifications", method: "PUT", path: "/v1/notifications", body: { id: "email", enabled: true } },
  { group: "notifications", method: "POST", path: "/v1/notifications/test", body: { channel: "email" } },
];

describe("EPIC-029 alerting routes are mounted (T-0859)", () => {
  it("covers every mounted alerting route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "alert-events",
      "alert-rules",
      "alert-rules-test",
      "notifications",
    ]);
  });

  it.each(PROBES.map((p) => [`${p.group}: ${p.method} ${p.path}`, p] as const))("%s is not a router 404", async (_label, probe) => {
    const base = await serve();
    const response = await fetch(`${base}${probe.path}`, {
      method: probe.method,
      ...(probe.body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(probe.body) }
        : {}),
    });
    const body = (await response.json()) as { code?: string };

    expect(body.code, `${probe.method} ${probe.path} -> ${response.status}`).not.toBe(ErrorCodes.routeNotFound);
    expect(response.status).not.toBe(405);
  });

  it("serves the seeded built-in catalog and the four notification channels from SQLite", async () => {
    const base = await serve();
    const rules = (await (await fetch(`${base}/v1/alert-rules`)).json()) as { rules?: Array<{ id: string; builtIn: boolean }> };
    expect(rules.rules?.length).toBeGreaterThan(0);
    expect(rules.rules).toContainEqual(expect.objectContaining({ id: "run-failed", builtIn: true }));

    const channels = (await (await fetch(`${base}/v1/notifications`)).json()) as { channels?: Array<{ id: string }> };
    expect(channels.channels?.map((channel) => channel.id).sort()).toEqual([
      "email",
      "psa",
      "slack",
      "webhook",
    ]);
  });

  it("persists a created rule and serves it from the event store's rule join", async () => {
    const base = await serve();
    const created = await fetch(`${base}/v1/alert-rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Portal rule",
        source: "runs",
        severity: "High",
        scope: "tenant",
        channels: ["email", "webhook"],
      }),
    });
    expect(created.status).toBe(201);
    const rule = (await created.json()) as { rule: { id: string } };

    const listed = (await (await fetch(`${base}/v1/alert-rules`)).json()) as {
      rules: Array<{ id: string; name: string }>;
    };
    expect(listed.rules).toContainEqual(expect.objectContaining({ id: rule.rule.id, name: "Portal rule" }));
  });
});
