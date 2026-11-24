import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// EPIC-031 Secure Score route groups are mounted in createApp (T-0861).
// Each probe goes through the real app (router, auth, RBAC) and passes only when
// the route exists: an unmounted path answers with the router's
// `request.not_found`. The tenant has no credential, so worker-backed reads stop
// at the adapter's 409 before any worker starts; the on-demand snapshot also
// reaches the worker and stops at 409. The fleet view is repository-backed and
// answers 200.

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
  { group: "secure-score", method: "GET", path: `${T}/secure-score` },
  { group: "secure-score-peers", method: "GET", path: `${T}/secure-score/peers` },
  { group: "secure-score-trend", method: "GET", path: `${T}/secure-score/trend` },
  { group: "secure-score-trend", method: "POST", path: `${T}/secure-score/snapshot` },
  { group: "secure-score-fleet", method: "GET", path: "/v1/secure-score/fleet" },
];

describe("EPIC-031 Secure Score routes are mounted (T-0861)", () => {
  it("covers every mounted Secure Score route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "secure-score",
      "secure-score-fleet",
      "secure-score-peers",
      "secure-score-trend",
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
