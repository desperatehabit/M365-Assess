import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// EPIC-034 Domains & DNS route groups are mounted in createApp (T-0864).
// Each probe goes through the real app (router, auth, RBAC) and passes only when
// the route exists: an unmounted path answers with the router's
// `request.not_found`. Worker-backed writes stop at the adapter's 409 because
// the tenant has no credential; the DNS analyser resolves publicly and is served
// from the injected fake worker.

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
  recommendations: ["MTA-STS is not published."],
};

const RECOMMENDATION = {
  recordFamily: "MTA-STS",
  severity: "low",
  explanation: "MTA-STS is not published.",
  remediationUrl: "https://learn.microsoft.com/",
  remediation: "Publish the MTA-STS record.",
  checkId: null,
};

function fakeWorker(entrypoint: string): unknown {
  switch (entrypoint) {
    case "get-domains.ps1":
      return {
        tenantId: "tenant-probe",
        totalCount: 1,
        items: [
          {
            domain: "contoso.com",
            type: "verified",
            verification: "verified",
            dnsHealth: "degraded",
            services: "contoso-com.mail.protection.outlook.com",
            lastChecked: "2026-11-08T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      };
    case "check-domain-dns.ps1":
      return DNS_RESULT;
    case "get-dns-recommendations.ps1":
      return [RECOMMENDATION];
    case "domain-action.ps1":
      return { tenantId: "tenant-probe", domain: "contoso.com", action: "verify", status: "planned" };
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
  readonly headers?: Record<string, string>;
}

const T = "/v1/tenants/tenant-probe";
const WRITE_HEADERS = { "idempotency-key": "probe-key" };
const PROBES: readonly Probe[] = [
  { group: "domains", method: "GET", path: `${T}/domains` },
  {
    group: "domains-actions",
    method: "POST",
    path: `${T}/domains`,
    headers: WRITE_HEADERS,
    body: { domain: "contoso.com", confirm: true },
  },
  {
    group: "domains-actions",
    method: "POST",
    path: `${T}/domains/contoso.com/verify`,
    headers: WRITE_HEADERS,
    body: { confirm: true },
  },
  {
    group: "domains-actions",
    method: "DELETE",
    path: `${T}/domains/contoso.com`,
    headers: WRITE_HEADERS,
    body: { confirm: true },
  },
  {
    group: "domains-actions",
    method: "POST",
    path: `${T}/domains/contoso.com/default`,
    headers: WRITE_HEADERS,
    body: { confirm: true },
  },
  { group: "domains-dns", method: "POST", path: `${T}/domains/contoso.com/check-dns` },
  { group: "domains-dns", method: "GET", path: `${T}/domains/contoso.com/history` },
  {
    group: "domains-recommendations",
    method: "GET",
    path: `${T}/domains/contoso.com/recommendations`,
  },
  { group: "domains-schedule", method: "GET", path: `${T}/domains/analysis-schedule` },
  {
    group: "domains-schedule",
    method: "POST",
    path: `${T}/domains/analysis-schedule`,
    body: { cron: "0 0 6 * * *" },
  },
];

describe("EPIC-034 Domains & DNS routes are mounted (T-0864)", () => {
  it("covers every mounted Domains route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "domains",
      "domains-actions",
      "domains-dns",
      "domains-recommendations",
      "domains-schedule",
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

  it("persists a DNS check and serves it from history and recommendations", async () => {
    const base = await serve();

    const analysis = await fetch(`${base}${T}/domains/contoso.com/check-dns`, { method: "POST" });
    expect(analysis.status).toBe(200);
    const analysisBody = (await analysis.json()) as {
      check: { records: Record<string, unknown>; health: Record<string, unknown> };
      cached: boolean;
    };
    expect(analysisBody.cached).toBe(false);
    expect(analysisBody.check.records["mx"]).toEqual(["contoso-com.mail.protection.outlook.com"]);

    const history = await fetch(`${base}${T}/domains/contoso.com/history`);
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as { totalCount: number };
    expect(historyBody.totalCount).toBe(1);

    const recommendations = await fetch(`${base}${T}/domains/contoso.com/recommendations`);
    expect(recommendations.status).toBe(200);
    const recommendationsBody = (await recommendations.json()) as {
      totalCount: number;
      recommendations: Array<{ recordFamily: string; severity: string; checkId: string | null }>;
    };
    expect(recommendationsBody.totalCount).toBe(1);
    expect(recommendationsBody.recommendations[0]).toEqual(
      expect.objectContaining({ recordFamily: "MTA-STS", severity: "low", checkId: null }),
    );
  });

  it("creates and reads the domain analysis schedule", async () => {
    const base = await serve();

    const created = await fetch(`${base}${T}/domains/analysis-schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cron: "0 0 6 * * *" }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { schedule: { command: string } };
    expect(createdBody.schedule.command).toBe("Invoke-DomainAnalysisSchedule");

    const read = await fetch(`${base}${T}/domains/analysis-schedule`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { schedule: { command: string } | null };
    expect(readBody.schedule?.command).toBe("Invoke-DomainAnalysisSchedule");
  });
});
