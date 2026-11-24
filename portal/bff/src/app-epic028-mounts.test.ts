import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { ErrorCodes } from "./errors.js";
import { buildServer } from "./server.js";

// EPIC-028 Incidents & Alerts route groups are mounted in createApp (T-0858). Each
// probe goes through the real app (router, auth, RBAC, the worker-backed adapter) and
// passes only when the route exists: an unmounted path answers with the router's
// `request.not_found`. The probe tenant has no credential, so worker-backed routes
// stop at the adapter's 409 before any worker would start.

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

const T = "/v1/tenants/tenant-probe";
const M = `${T}/incidents/inc-1`;
const A = `${T}/alerts/alert-1`;

interface Probe {
  readonly group: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const PROBES: readonly Probe[] = [
  { group: "incidents", method: "GET", path: `${T}/incidents` },
  { group: "incidents", method: "GET", path: "/v1/incidents" },
  { group: "incident-detail", method: "GET", path: M },
  { group: "incident-actions", method: "POST", path: `${M}/assign`, body: { value: "analyst@example.invalid", reason: "triage" } },
  { group: "incident-actions", method: "POST", path: `${M}/status`, body: { value: "active", reason: "triage" } },
  { group: "incident-actions", method: "POST", path: `${M}/classify`, body: { value: "truePositive", reason: "triage" } },
  { group: "incident-actions", method: "POST", path: `${M}/comment`, body: { comment: "note" } },
  { group: "alerts", method: "GET", path: `${T}/alerts` },
  { group: "alert-actions", method: "POST", path: `${A}/status`, body: { value: "new", reason: "triage" } },
  { group: "alert-actions", method: "POST", path: `${A}/assign`, body: { value: "analyst@example.invalid", reason: "triage" } },
  { group: "check-alerts", method: "GET", path: "/v1/check-alerts" },
];

describe("EPIC-028 incident and alert routes are mounted (T-0858)", () => {
  it("covers every mounted incident and alert route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "alert-actions",
      "alerts",
      "check-alerts",
      "incident-actions",
      "incident-detail",
      "incidents",
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

  it("serves worker-backed reads through the adapter: a tenant with no credential is a 409", async () => {
    const base = await serve();
    const response = await fetch(`${base}${T}/incidents`);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("tenant.credential_missing");
  });

  it("serves the module-wide check-alert read from findings without a credential", async () => {
    const base = await serve();
    const response = await fetch(`${base}/v1/check-alerts`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalCount: 0, items: [] });
  });
});
