import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { ErrorCodes } from "./errors.js";
import { buildServer } from "./server.js";

// EPIC-020 mailbox route groups are mounted in createApp (T-0850). Each probe goes through
// the real app (router, auth, RBAC, the worker-backed adapter) and passes only when the
// route exists: an unmounted path answers with the router's `request.not_found`. Probes use a
// tenant with no credential, so worker-backed routes stop at the adapter's 409 before any
// worker would start; routes backed by no worker answer 501 from the adapter itself.

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
const M = `${T}/mailboxes/mbx-1`;

interface Probe {
  readonly group: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const PROBES: readonly Probe[] = [
  { group: "mailboxes", method: "GET", path: `${T}/mailboxes` },
  { group: "mailboxes", method: "GET", path: M },
  { group: "mailbox-write", method: "POST", path: `${T}/mailboxes`, body: { displayName: "Shared", preview: true } },
  { group: "mailbox-write", method: "POST", path: `${M}/convert`, body: { preview: true } },
  { group: "mailbox-settings", method: "PATCH", path: M, body: { litigationHold: true, preview: true } },
  { group: "mailbox-permissions", method: "GET", path: `${M}/permissions` },
  { group: "mailbox-permissions", method: "POST", path: `${M}/permissions`, body: { action: "add", scope: "mailbox", permissionType: "FullAccess", principal: "a@example.invalid", preview: true } },
  { group: "mailbox-permissions", method: "DELETE", path: `${M}/permissions`, body: { scope: "mailbox", permissionType: "FullAccess", principal: "a@example.invalid", preview: true } },
  { group: "mailbox-permissions-report", method: "GET", path: `${T}/mailbox-permissions` },
  { group: "mailbox-reports", method: "GET", path: `${T}/mailbox-reports?report=statistics` },
  { group: "mailbox-rules", method: "GET", path: `${M}/rules` },
  { group: "mailbox-rules", method: "POST", path: `${M}/rules`, body: { name: "Rule", preview: true } },
  { group: "mailbox-rules", method: "PATCH", path: `${M}/rules/rule-1`, body: { enabled: false, preview: true } },
  { group: "mailbox-rules", method: "DELETE", path: `${M}/rules/rule-1?preview=true` },
  { group: "retention", method: "GET", path: `${T}/retention/policies` },
  { group: "retention", method: "GET", path: `${T}/retention/tags` },
  { group: "retention", method: "POST", path: `${T}/retention/tags`, body: { name: "Tag", preview: true } },
  { group: "retention", method: "PATCH", path: `${T}/retention/tags/tag-1`, body: { name: "Tag", preview: true } },
  { group: "retention", method: "POST", path: `${T}/retention/assign`, body: { tagId: "tag-1", mailboxId: "mbx-1", preview: true } },
  { group: "retention", method: "POST", path: `${T}/retention/assign/bulk`, body: { tagId: "tag-1", mailboxIds: ["mbx-1"], preview: true } },
  { group: "vacation-schedules", method: "GET", path: `${T}/vacation-schedules` },
  {
    group: "vacation-schedules",
    method: "POST",
    path: `${T}/vacation-schedules`,
    body: { mailboxId: "mbx-1", startsAt: "2999-01-01T00:00:00Z", endsAt: "2999-01-08T00:00:00Z", oooMessage: "Out." },
  },
  { group: "vacation-schedules", method: "DELETE", path: `${T}/vacation-schedules/vac-unknown` },
  { group: "deleted-mailboxes", method: "GET", path: `${T}/deleted-mailboxes` },
  { group: "deleted-mailboxes", method: "POST", path: `${T}/deleted-mailboxes/mbx-1/restore`, body: { preview: true } },
];

describe("EPIC-020 mailbox routes are mounted (T-0850)", () => {
  it("covers every mounted mailbox route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "deleted-mailboxes",
      "mailbox-permissions",
      "mailbox-permissions-report",
      "mailbox-reports",
      "mailbox-rules",
      "mailbox-settings",
      "mailbox-write",
      "mailboxes",
      "retention",
      "vacation-schedules",
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

  it("serves worker-backed routes through the adapter: a tenant with no credential is a 409", async () => {
    const base = await serve();
    const response = await fetch(`${base}${T}/mailboxes`);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("tenant.credential_missing");
  });

  it("answers the unbacked mail-flow report and retention tag read with an explicit 501", async () => {
    const base = await serve();

    const mailflow = await fetch(`${base}${T}/mailbox-reports?report=mailflow`);
    expect(mailflow.status).toBe(501);
    expect(((await mailflow.json()) as { code: string }).code).toBe("mailboxes.mailflow_report_unavailable");

    const tags = await fetch(`${base}${T}/retention/tags`);
    expect(tags.status).toBe(501);
    expect(((await tags.json()) as { code: string }).code).toBe("mailboxes.retention_tag_read_unavailable");
  });
});
