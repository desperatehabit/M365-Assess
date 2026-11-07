import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// EPIC-021 transport and connector route groups are mounted in createApp (T-0851).
// Each probe goes through the real app (router, auth, RBAC, the SQLite-backed
// template stores) and passes only when the route exists. The tenant has no
// credential, so worker-backed routes stop at the adapter's 409 before any worker
// would start; the template stores answer 200/201 directly.

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
  { group: "transport-rules", method: "GET", path: `${T}/transport-rules` },
  {
    group: "transport-rules",
    method: "POST",
    path: `${T}/transport-rules`,
    body: { name: "Block wire transfer", preview: true },
  },
  {
    group: "transport-rules",
    method: "PATCH",
    path: `${T}/transport-rules/rule-1`,
    body: { enabled: false, preview: true },
  },
  { group: "transport-rules", method: "DELETE", path: `${T}/transport-rules/rule-1?preview=true` },
  { group: "connectors", method: "GET", path: `${T}/connectors` },
  {
    group: "connectors",
    method: "POST",
    path: `${T}/connectors`,
    body: { name: "Partner", type: "inbound", preview: true },
  },
  {
    group: "connectors",
    method: "PATCH",
    path: `${T}/connectors/conn-1`,
    body: { action: "disable", preview: true },
  },
  { group: "connectors", method: "DELETE", path: `${T}/connectors/conn-1?preview=true` },
  { group: "transport-rule-templates", method: "GET", path: "/v1/transport-rule-templates" },
  {
    group: "transport-rule-templates",
    method: "POST",
    path: "/v1/transport-rule-templates",
    body: { name: "Block", ruleJson: { name: "Block" } },
  },
  { group: "connector-templates", method: "GET", path: "/v1/connector-templates" },
  {
    group: "connector-templates",
    method: "POST",
    path: "/v1/connector-templates",
    body: { name: "Partner", connectorJson: { name: "Partner" } },
  },
];

describe("EPIC-021 transport and connector routes are mounted (T-0851)", () => {
  it("covers every mounted transport route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "connector-templates",
      "connectors",
      "transport-rule-templates",
      "transport-rules",
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
