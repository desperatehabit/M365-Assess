import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// EPIC-019 Defender route groups are mounted in createApp (T-0849). Each probe goes
// through the real app (router, auth, RBAC, the SQLite-backed stores) and passes only
// when the route exists: an unmounted path answers with the router's
// `request.not_found`. The tenant has no credential, so worker-backed routes stop at
// the adapter's 409 before any worker would start; portal-local stores answer 200/201.

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
  { group: "defender-status", method: "GET", path: `${T}/defender/status` },
  { group: "defender-deploy", method: "POST", path: `${T}/defender/deploy`, body: { policyAreas: ["av"] } },
  { group: "defender-vulnerabilities", method: "GET", path: `${T}/defender/vulnerabilities` },
  { group: "defender-mde-onboarding", method: "GET", path: `${T}/defender/mde-onboarding` },
  { group: "defender-cve-exceptions", method: "GET", path: `${T}/defender/cve-exceptions` },
  {
    group: "defender-cve-exceptions",
    method: "POST",
    path: `${T}/defender/cve-exceptions`,
    body: { cve: "CVE-2026-0001", scope: "all", reason: "accepted", expiresOn: "2999-01-01T00:00:00Z" },
  },
  { group: "defender-templates", method: "GET", path: `${T}/defender/templates` },
  {
    group: "defender-templates",
    method: "POST",
    path: `${T}/defender/templates`,
    body: { name: "Baseline", policyAreas: ["av"], policyJson: {} },
  },
];

describe("EPIC-019 Defender routes are mounted (T-0849)", () => {
  it("covers every mounted Defender route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "defender-cve-exceptions",
      "defender-deploy",
      "defender-mde-onboarding",
      "defender-status",
      "defender-templates",
      "defender-vulnerabilities",
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
});
