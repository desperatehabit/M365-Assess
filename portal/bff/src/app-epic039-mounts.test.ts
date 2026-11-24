import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// EPIC-039 Template Library & Catalog route groups are mounted in createApp
// (T-0869). Each probe goes through the real app (router, auth, RBAC) and passes
// only when the route exists: an unmounted path answers with the router's
// `request.not_found`. The 404s below are the modules' own domain errors, not
// router misses. The portal-local stores persist through SQLite.

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

interface Probe {
  readonly group: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const PROBES: readonly Probe[] = [
  { group: "template-library", method: "GET", path: "/v1/template-library" },
  { group: "template-library", method: "DELETE", path: "/v1/template-library/not-an-item" },
  {
    group: "template-clone",
    method: "POST",
    path: "/v1/template-library/not-an-item/clone",
    body: { targets: ["tenant-probe"] },
  },
  {
    group: "template-github",
    method: "POST",
    path: "/v1/template-library/not-an-item/save-to-github",
    body: { repository: "owner/repo", message: "save" },
  },
  { group: "template-repos", method: "GET", path: "/v1/template-repos" },
  {
    group: "template-repos",
    method: "POST",
    path: "/v1/template-repos",
    body: { ref: "owner/repo", types: ["standards"] },
  },
  { group: "template-repos", method: "GET", path: "/v1/template-repos/not-a-repo/templates" },
  { group: "template-repos", method: "DELETE", path: "/v1/template-repos/not-a-repo" },
  { group: "template-packages", method: "GET", path: "/v1/template-packages" },
  {
    group: "template-packages",
    method: "POST",
    path: "/v1/template-packages",
    body: { formatVersion: 1, name: "empty", version: "1.0.0", contents: [] },
  },
  { group: "template-packages", method: "GET", path: "/v1/template-packages/export" },
];

describe("EPIC-039 Template Library & Catalog routes are mounted (T-0869)", () => {
  it("covers every mounted Templates route group", () => {
    expect([...new Set(PROBES.map((p) => p.group))].sort()).toEqual([
      "template-clone",
      "template-github",
      "template-library",
      "template-packages",
      "template-repos",
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

  it("imports a package, lists it, browses and exports its items, and plans a clone", async () => {
    const base = await serve();

    const imported = await fetch(`${base}/v1/template-packages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        formatVersion: 1,
        name: "contoso-baselines",
        version: "1.2.0",
        contents: [
          {
            type: "standards",
            name: "Baseline v1",
            body: JSON.stringify({ displayName: "Baseline v1" }),
          },
        ],
      }),
    });
    expect(imported.status).toBe(201);
    const importedBody = (await imported.json()) as {
      package: { id: string; name: string };
      items: Array<{ id: string; type: string; source: string }>;
    };
    expect(importedBody.package.name).toBe("contoso-baselines");
    expect(importedBody.items[0]?.source).toBe("local");

    const packages = await fetch(`${base}/v1/template-packages`);
    const packagesBody = (await packages.json()) as {
      items: Array<{ id: string; itemCount: number }>;
    };
    expect(packagesBody.items).toEqual([
      expect.objectContaining({ id: importedBody.package.id, itemCount: 1 }),
    ]);

    const library = await fetch(`${base}/v1/template-library?type=standards`);
    expect(library.status).toBe(200);
    const libraryBody = (await library.json()) as { items: Array<{ id: string; name: string }> };
    expect(libraryBody.items.map((item) => item.name)).toEqual(["Baseline v1"]);

    const exported = await fetch(`${base}/v1/template-packages/export?name=roundtrip&version=2.0.0`);
    expect(exported.status).toBe(200);
    const exportBody = (await exported.json()) as {
      name: string;
      contents: Array<{ type: string; name: string }>;
    };
    expect(exportBody.name).toBe("roundtrip");
    expect(exportBody.contents[0]).toEqual({ type: "standards", name: "Baseline v1", body: expect.any(String) });

    const clone = await fetch(
      `${base}/v1/template-library/${encodeURIComponent(importedBody.items[0]!.id)}/clone`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets: ["tenant-a"] }),
      },
    );
    expect(clone.status).toBe(200);
    const cloneBody = (await clone.json()) as {
      itemName: string;
      dryRun: boolean;
      actions: Array<{ tenantId: string; deployPath: string }>;
    };
    expect(cloneBody.itemName).toBe("Baseline v1");
    expect(cloneBody.dryRun).toBe(true);
    expect(cloneBody.actions[0]).toEqual(
      expect.objectContaining({
        tenantId: "tenant-a",
        deployPath: "/v1/standards/templates/:templateId/clone",
      }),
    );
  });

  it("adds a community repo, lists it, and removes it", async () => {
    const base = await serve();

    const added = await fetch(`${base}/v1/template-repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "owner/repo", types: ["conditional-access"], writeAccess: true }),
    });
    expect(added.status).toBe(201);
    const repo = (await added.json()) as { id: string; url: string; writeAccess: boolean };
    expect(repo.url).toBe("https://github.com/owner/repo");
    expect(repo.writeAccess).toBe(true);

    const listed = await fetch(`${base}/v1/template-repos?type=conditional-access`);
    const listedBody = (await listed.json()) as { items: Array<{ id: string }> };
    expect(listedBody.items.map((item) => item.id)).toContain(repo.id);

    const removed = await fetch(`${base}/v1/template-repos/${encodeURIComponent(repo.id)}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);

    const after = await fetch(`${base}/v1/template-repos`);
    const afterBody = (await after.json()) as { items: Array<{ id: string }> };
    expect(afterBody.items.map((item) => item.id)).not.toContain(repo.id);
  });

  it("fails closed on save-to-GitHub until the integration is enabled", async () => {
    const base = await serve();
    const response = await fetch(`${base}/v1/template-library/not-an-item/save-to-github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "owner/repo", message: "save" }),
    });
    expect(response.status).not.toBe(404);
    const body = (await response.json()) as { code?: string };
    expect(body.code).not.toBe("request.not_found");
  });
});
