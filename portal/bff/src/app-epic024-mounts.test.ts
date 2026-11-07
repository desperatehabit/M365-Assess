import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { MAIL_RESTORE_NOT_FOUND } from "./routes/mail-restores.js";
import { buildServer } from "./server.js";

// EPIC-024 Email Tools route groups are mounted in createApp (T-0854). Each probe
// goes through the real app (router, auth, RBAC) and passes only when the route
// exists: an unmounted path answers with the router's `request.not_found`. The
// tenant has no credential, so worker-backed routes stop at the adapter's 409
// before any worker would start; the restore-progress read hits the repository
// and answers the route's own 404.

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
  /** The route's own error code, when the probe reaches a portal-local store. */
  readonly code?: string;
}

const T = "/v1/tenants/tenant-probe";
const PROBES: readonly Probe[] = [
  { group: "message-trace", method: "POST", path: `${T}/mail/message-trace`, body: {} },
  {
    group: "historical-search",
    method: "POST",
    path: `${T}/mail/historical-search`,
    body: { query: "subject:invoice" },
  },
  { group: "historical-search", method: "GET", path: `${T}/mail/historical-search/job-1` },
  { group: "historical-search", method: "POST", path: `${T}/mail/historical-search/job-1/cancel` },
  { group: "messages", method: "GET", path: `${T}/mail/messages/msg-1` },
  {
    group: "mail-restores",
    method: "POST",
    path: `${T}/mail/restores`,
    body: { mailboxId: "mbx@example.invalid", preview: true },
  },
  {
    group: "mail-restores",
    method: "GET",
    path: `${T}/mail/restores/job-1`,
    code: MAIL_RESTORE_NOT_FOUND,
  },
  { group: "encryption", method: "GET", path: `${T}/mail/encryption` },
  {
    group: "encryption",
    method: "PUT",
    path: `${T}/mail/encryption`,
    body: { settings: { portalText: "Confidential" }, preview: true },
  },
];

describe("EPIC-024 Email Tools routes are mounted (T-0854)", () => {
  it("covers every mounted Email Tools route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "encryption",
      "historical-search",
      "mail-restores",
      "message-trace",
      "messages",
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
      expect(body.code, JSON.stringify(body)).not.toBe("request.not_found");
      if (probe.code !== undefined) {
        expect(body.code).toBe(probe.code);
      } else {
        expect(response.status, JSON.stringify(body)).not.toBe(404);
      }
    },
  );
});
