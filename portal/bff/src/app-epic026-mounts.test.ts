import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// EPIC-026 Teams & Voice route groups are mounted in createApp (T-0856). Each
// probe goes through the real app (router, auth, RBAC) and passes only when the
// route exists: an unmounted path answers with the router's `request.not_found`.
// The tenant has no credential, so worker-backed routes stop at the adapter's
// 409 before any worker would start; the portal-local previews answer 200.

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
  { group: "teams-list", method: "GET", path: `${T}/teams` },
  { group: "teams-create", method: "POST", path: `${T}/teams`, body: { name: "Probe team", preview: true } },
  {
    group: "teams-lifecycle",
    method: "PATCH",
    path: `${T}/teams/team-1`,
    body: { changes: { displayName: "Renamed" }, preview: true },
  },
  {
    group: "teams-lifecycle",
    method: "DELETE",
    path: `${T}/teams/team-1?preview=true`,
  },
  { group: "teams-lifecycle", method: "POST", path: `${T}/teams/team-1/archive`, body: { preview: true } },
  {
    group: "teams-lifecycle",
    method: "POST",
    path: `${T}/teams/team-1/clone`,
    body: { newName: "Probe copy", preview: true },
  },
  { group: "teams-activity", method: "GET", path: `${T}/teams/activity` },
  { group: "teams-lis", method: "GET", path: `${T}/teams/lis` },
  {
    group: "teams-lis",
    method: "POST",
    path: `${T}/teams/lis`,
    body: {
      displayName: "HQ",
      street: "1 Main St",
      city: "Seattle",
      state: "WA",
      country: "US",
      postalCode: "98101",
      preview: true,
    },
  },
  { group: "teams-lis", method: "PATCH", path: `${T}/teams/lis/loc-1`, body: { city: "Tacoma", preview: true } },
  { group: "teams-lis", method: "DELETE", path: `${T}/teams/lis/loc-1?preview=true` },
  { group: "teams-voice", method: "GET", path: `${T}/teams/voice/numbers` },
  {
    group: "teams-voice",
    method: "POST",
    path: `${T}/teams/voice/numbers`,
    body: { phoneNumber: "+15550100", targetId: "user-1", preview: true },
  },
  { group: "teams-voice", method: "DELETE", path: `${T}/teams/voice/numbers/n-1?confirm=true` },
  {
    group: "teams-voice",
    method: "POST",
    path: `${T}/teams/voice/policy`,
    body: { policyId: "policy-1", targetId: "user-1", preview: true },
  },
];

describe("EPIC-026 Teams & Voice routes are mounted (T-0856)", () => {
  it("covers every mounted Teams route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "teams-activity",
      "teams-create",
      "teams-lifecycle",
      "teams-lis",
      "teams-list",
      "teams-voice",
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
