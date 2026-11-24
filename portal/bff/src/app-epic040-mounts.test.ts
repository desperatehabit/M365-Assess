import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// EPIC-040 Graph Explorer & Admin Tools route groups are mounted in createApp
// (T-0870). Each probe goes through the real app (router, auth, RBAC) and passes
// only when the route exists: an unmounted path answers with the router's
// `request.not_found`. The 404s below are the modules' own domain errors, not
// router misses.

const opened: { server: Server; app: App }[] = [];

afterEach(async () => {
  for (const { server, app } of opened.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});

const DNS_RESULT = {
  records: {
    mx: ["contoso-com.mail.protection.outlook.com"],
    spf: { record: "v=spf1 include:spf.protection.outlook.com -all", lookupCount: 1 },
    dkim: { selectors: ["selector1"], selector1: true, selector2: false, enabled: true },
    dmarc: { record: "v=DMARC1; p=reject;", policy: "reject" },
    mtaSts: { present: false, record: "" },
    tlsRpt: { present: false, record: "" },
  },
  health: {
    overall: "degraded",
    families: { mx: "pass", spf: "pass", dkim: "pass", dmarc: "pass", mtaSts: "warn", tlsRpt: "warn" },
  },
  recommendations: [],
};

function fakeWorker(entrypoint: string): unknown {
  switch (entrypoint) {
    case "check-domain-dns.ps1":
      return DNS_RESULT;
    case "invoke-graph-request.ps1":
      return { status: 200, headers: {}, durationMs: 1, body: { value: [] } };
    default:
      return {};
  }
}

async function serve() {
  const app = createApp(
    { ...loadConfig({}), devIdentityRole: "admin" },
    {
      db: new Database(":memory:"),
      workerRunner: async <T>(entrypoint: string): Promise<T> => fakeWorker(entrypoint) as T,
    },
  );
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
const LOOKUP_ID = "11111111-1111-1111-1111-111111111111";
const PROBES: readonly Probe[] = [
  {
    group: "graph-explorer",
    method: "POST",
    path: `${T}/graph-explorer`,
    body: { method: "GET", url: "https://graph.microsoft.com/v1.0/users" },
  },
  { group: "graph-presets", method: "GET", path: "/v1/graph-presets" },
  {
    group: "graph-presets",
    method: "POST",
    path: "/v1/graph-presets",
    body: { name: "Users", method: "GET", url: "https://graph.microsoft.com/v1.0/users" },
  },
  { group: "graph-presets", method: "DELETE", path: "/v1/graph-presets/not-a-preset" },
  { group: "tenant-lookup", method: "GET", path: `/v1/tenant-lookup?query=${LOOKUP_ID}` },
  { group: "app-approval", method: "GET", path: `${T}/consent-requests` },
  {
    group: "app-approval",
    method: "POST",
    path: `${T}/consent-requests`,
    body: { requestId: "missing", decision: "approve" },
  },
  {
    group: "breach-lookup",
    method: "POST",
    path: "/v1/breach-lookup",
    body: { account: "user@example.invalid" },
  },
  { group: "geoip", method: "GET", path: "/v1/geoip/8.8.8.8" },
  { group: "domain-check", method: "GET", path: "/v1/domain-check?domain=contoso.com" },
];

describe("EPIC-040 Graph Explorer & Admin Tools routes are mounted (T-0870)", () => {
  it("covers every mounted Tools route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "app-approval",
      "breach-lookup",
      "domain-check",
      "geoip",
      "graph-explorer",
      "graph-presets",
      "tenant-lookup",
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
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(probe.body),
            }),
      });
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      expect(body.code, JSON.stringify(body)).not.toBe("request.not_found");
    },
  );

  it("saves, lists, and deletes a Graph preset", async () => {
    const base = await serve();

    const created = await fetch(`${base}/v1/graph-presets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Users",
        method: "GET",
        url: "https://graph.microsoft.com/v1.0/users",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { preset: { id: string; createdBy: string } };
    expect(createdBody.preset.createdBy).toBeTruthy();

    const listed = await fetch(`${base}/v1/graph-presets`);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { presets: Array<{ id: string }> };
    expect(listedBody.presets.map((preset) => preset.id)).toContain(createdBody.preset.id);

    const deleted = await fetch(`${base}/v1/graph-presets/${createdBody.preset.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    const after = await fetch(`${base}/v1/graph-presets`);
    const afterBody = (await after.json()) as { presets: Array<{ id: string }> };
    expect(afterBody.presets.map((preset) => preset.id)).not.toContain(createdBody.preset.id);
  });

  it("looks up a portal tenant without a network call", async () => {
    const base = await serve();
    const response = await fetch(`${base}/v1/tenant-lookup?query=${LOOKUP_ID}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tenantId: string; inPortal: boolean };
    expect(body.tenantId).toBe(LOOKUP_ID);
    expect(body.inPortal).toBe(false);
  });

  it("fails closed for breach lookup and reports the missing provider", async () => {
    const base = await serve();
    const response = await fetch(`${base}/v1/breach-lookup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: "user@example.invalid" }),
    });
    expect(response.status).toBe(501);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("breach.integration_not_configured");
  });

  it("serves a GeoIP record and an individual domain check", async () => {
    const base = await serve();

    const geoip = await fetch(`${base}/v1/geoip/8.8.8.8`);
    expect(geoip.status).toBe(200);
    expect(await geoip.json()).toEqual(expect.objectContaining({ ip: "8.8.8.8", country: "US" }));

    const check = await fetch(`${base}/v1/domain-check?domain=contoso.com`);
    expect(check.status).toBe(200);
    expect(await check.json()).toEqual(
      expect.objectContaining({ health: expect.objectContaining({ overall: "degraded" }) }),
    );
  });
});
