import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// EPIC-036 Compliance Test Packs and Custom Tests route groups are mounted in
// createApp (T-0866). Each probe goes through the real app (router, auth, RBAC)
// and passes only when the route exists: an unmounted path answers with the
// router's `request.not_found`. The 404s below are the modules' own domain
// errors, not router misses.

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

const PROBES: readonly Probe[] = [
  { group: "test-packs", method: "GET", path: "/v1/test-packs" },
  {
    group: "test-packs",
    method: "POST",
    path: "/v1/test-packs/not-a-pack/run",
    body: { tenantId: "tenant-probe" },
  },
  { group: "test-runs", method: "GET", path: "/v1/test-runs/not-a-run?tenantId=tenant-probe" },
  { group: "custom-tests", method: "GET", path: "/v1/custom-tests" },
  { group: "custom-tests", method: "POST", path: "/v1/custom-tests", body: { name: "Probe test" } },
  { group: "custom-tests", method: "GET", path: "/v1/custom-tests/not-a-test" },
  { group: "custom-tests", method: "PATCH", path: "/v1/custom-tests/not-a-test", body: { enabled: true } },
  { group: "custom-tests", method: "DELETE", path: "/v1/custom-tests/not-a-test" },
  { group: "custom-tests", method: "GET", path: "/v1/custom-tests/not-a-test/versions" },
  {
    group: "custom-tests",
    method: "POST",
    path: "/v1/custom-tests/not-a-test/versions",
    body: { content: "Get-MgUser" },
  },
];

describe("EPIC-036 Test Packs and Custom Tests routes are mounted (T-0866)", () => {
  it("covers every mounted Compliance Test Packs route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "custom-tests",
      "test-packs",
      "test-runs",
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
      // A domain 404 (pack/run/test not found) is allowed: the request reached
      // the route. Only the router's own miss means the group is unmounted.
      expect(body.code, JSON.stringify(body)).not.toBe("request.not_found");
      if (response.status === 404) {
        expect(body.code).toBeTruthy();
      }
    },
  );

  it("lists the shipped pack catalogue from the real catalogue", async () => {
    const base = await serve();
    const response = await fetch(`${base}/v1/test-packs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      packs: Array<{ id: string; name: string; checkCount: number }>;
    };
    expect(body.packs.map((pack) => pack.id).sort()).toEqual(["cis", "e8"]);
    expect(body.packs.every((pack) => pack.checkCount > 0)).toBe(true);
  });

  it("persists a custom test, its version, edits, and soft delete", async () => {
    const base = await serve();

    const created = await fetch(`${base}/v1/custom-tests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Inactive mailboxes", category: "Exchange" }),
    });
    expect(created.status).toBe(201);
    const test = (await created.json()) as { id: string; name: string; enabled: boolean };
    expect(test.name).toBe("Inactive mailboxes");
    expect(test.enabled).toBe(false);

    const version = await fetch(`${base}/v1/custom-tests/${test.id}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Get-Mailbox -InactiveMailboxOnly" }),
    });
    expect(version.status).toBe(201);

    const enabled = await fetch(`${base}/v1/custom-tests/${test.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as { enabled: boolean }).enabled).toBe(true);

    const list = await fetch(`${base}/v1/custom-tests`);
    const listBody = (await list.json()) as { items: Array<{ id: string }> };
    expect(listBody.items.map((row) => row.id)).toContain(test.id);

    const versions = await fetch(`${base}/v1/custom-tests/${test.id}/versions`);
    const versionsBody = (await versions.json()) as { items: Array<{ testId: string }> };
    expect(versionsBody.items).toHaveLength(1);
    expect(versionsBody.items[0]?.testId).toBe(test.id);

    const deleted = await fetch(`${base}/v1/custom-tests/${test.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);

    const afterDelete = await fetch(`${base}/v1/custom-tests`);
    const afterDeleteBody = (await afterDelete.json()) as { items: Array<{ id: string }> };
    expect(afterDeleteBody.items.map((row) => row.id)).not.toContain(test.id);
  });
});
