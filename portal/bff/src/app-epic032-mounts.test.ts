import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// EPIC-032 Audit Logs & Webhooks route groups are mounted in createApp (T-0862).
// Each probe goes through the real app (router, auth, RBAC) and passes only when
// the route exists: an unmounted path answers with the router's
// `request.not_found`. Worker-backed probes stop at the adapter's 409 because the
// tenant has no credential; portal-local stores (saved searches and exclusion
// windows) answer 200/201.

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
  const base = `http://127.0.0.1:${port}`;
  const created = await fetch(`${base}/v1/tenants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "tenant-probe", displayName: "Probe" }),
  });
  expect(created.status).toBe(201);
  return base;
}

interface Probe {
  readonly group: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const T = "/v1/tenants/tenant-probe";
const PROBES: readonly Probe[] = [
  {
    group: "audit-search",
    method: "POST",
    path: `${T}/audit/search`,
    body: { workloads: ["Exchange"], startDate: "2026-09-01T00:00:00Z" },
  },
  { group: "audit-directory", method: "GET", path: `${T}/audit/directory` },
  { group: "audit-searches", method: "GET", path: `${T}/audit/searches` },
  { group: "audit-searches", method: "POST", path: `${T}/audit/searches`, body: { name: "Probe search" } },
  { group: "audit-coverage", method: "GET", path: `${T}/audit/coverage` },
  { group: "audit-exclusion-windows", method: "GET", path: `${T}/audit/exclusion-windows` },
  {
    group: "audit-exclusion-windows",
    method: "POST",
    path: `${T}/audit/exclusion-windows`,
    body: { startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-12-02T00:00:00Z", reason: "probe" },
  },
  { group: "webhooks", method: "GET", path: `${T}/webhooks` },
  {
    group: "webhooks",
    method: "POST",
    path: `${T}/webhooks`,
    body: { resource: "users" },
  },
  { group: "webhooks", method: "DELETE", path: `${T}/webhooks/sub-1` },
  { group: "webhooks", method: "POST", path: `${T}/webhooks/sub-1/renew` },
  { group: "webhooks", method: "POST", path: `${T}/webhooks/sub-1/recreate` },
  { group: "webhooks", method: "POST", path: `${T}/webhooks/sub-1/test` },
];

describe("EPIC-032 Audit Logs & Webhooks routes are mounted (T-0862)", () => {
  it("covers every mounted Audit route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "audit-coverage",
      "audit-directory",
      "audit-exclusion-windows",
      "audit-search",
      "audit-searches",
      "webhooks",
    ]);
  });

  it.each(PROBES.map((p) => [`${p.group}: ${p.method} ${p.path}`, p] as const))(
    "%s is not a router 404",
    async (_label, probe) => {
      const base = await serve();
      const response = await fetch(`${base}${probe.path}`, {
        method: probe.method,
        ...(probe.body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(probe.body) }),
      });
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      expect(response.status, JSON.stringify(body)).not.toBe(404);
      expect(body.code).not.toBe("request.not_found");
    },
  );

  it("mounts the saved-search mutation and row-action routes", async () => {
    const base = await serve();
    const created = await fetch(`${base}${T}/audit/searches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Saved probe", filters: { user: "alex" } }),
    });
    expect(created.status).toBe(201);
    const search = (await created.json()) as { id: string };

    const probes: readonly { method: string; path: string; body?: unknown }[] = [
      { method: "GET", path: `${T}/audit/searches/${search.id}` },
      {
        method: "PATCH",
        path: `${T}/audit/searches/${search.id}`,
        body: { name: "Renamed probe" },
      },
      { method: "POST", path: `${T}/audit/searches/${search.id}/run` },
      {
        method: "POST",
        path: `${T}/audit/searches/${search.id}/schedule`,
        body: { cron: "0 0 3 * * *", timezone: "UTC" },
      },
      { method: "DELETE", path: `${T}/audit/searches/${search.id}` },
    ];

    for (const probe of probes) {
      const response = await fetch(`${base}${probe.path}`, {
        method: probe.method,
        ...(probe.body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(probe.body) }),
      });
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      expect(response.status, `${probe.method} ${probe.path}: ${JSON.stringify(body)}`).not.toBe(404);
      expect(body.code).not.toBe("request.not_found");
    }
  });
});
