import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// EPIC-033 Licensing route groups are mounted in createApp (T-0863).
// Each probe goes through the real app (router, auth, RBAC) and passes only when
// the route exists: an unmounted path answers with the router's
// `request.not_found`. Worker-backed reads stop at the adapter's 409 because the
// tenant has no credential; pricing is repository-backed and answers 200.

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
  readonly headers?: Record<string, string>;
}

const T = "/v1/tenants/tenant-probe";
const PROBES: readonly Probe[] = [
  { group: "licenses", method: "GET", path: `${T}/licenses` },
  {
    group: "license-assign",
    method: "POST",
    path: `${T}/licenses/assign`,
    body: { skuId: "sku-1", userIds: ["u-1"], dryRun: true },
  },
  {
    group: "license-assign",
    method: "POST",
    path: `${T}/licenses/remove`,
    body: { skuId: "sku-1", userIds: ["u-1"], dryRun: true },
  },
  { group: "license-optimization", method: "GET", path: `${T}/licenses/optimization` },
  { group: "license-gates", method: "GET", path: `${T}/licenses/gates` },
  { group: "license-pricing", method: "GET", path: "/v1/license-pricing" },
  {
    group: "license-pricing",
    method: "PUT",
    path: "/v1/license-pricing",
    body: { skuId: "sku-1", unitPrice: 20, currency: "USD" },
  },
];

describe("EPIC-033 Licensing routes are mounted (T-0863)", () => {
  it("covers every mounted Licensing route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "license-assign",
      "license-gates",
      "license-optimization",
      "license-pricing",
      "licenses",
    ]);
  });

  it.each(PROBES.map((p) => [`${p.group}: ${p.method} ${p.path}`, p] as const))(
    "%s is not a router 404",
    async (_label, probe) => {
      const base = await serve();
      const response = await fetch(`${base}${probe.path}`, {
        method: probe.method,
        ...(probe.body === undefined && probe.headers === undefined
          ? {}
          : {
              headers: { "content-type": "application/json", ...(probe.headers ?? {}) },
              ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
            }),
      });
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      expect(response.status, JSON.stringify(body)).not.toBe(404);
      expect(body.code).not.toBe("request.not_found");
    },
  );

  it("persists license pricing through the repository", async () => {
    const base = await serve();
    const put = await fetch(`${base}/v1/license-pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skuId: "sku-1", unitPrice: 20, currency: "USD" }),
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${base}/v1/license-pricing?tenantId=tenant-probe`);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { pricing: Array<{ skuId: string; unitPrice: number }> };
    expect(body.pricing).toEqual([expect.objectContaining({ skuId: "sku-1", unitPrice: 20 })]);
  });
});
