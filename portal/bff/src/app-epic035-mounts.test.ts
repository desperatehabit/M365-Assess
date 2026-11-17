import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import {
  BACKUP_MAINTENANCE_COMMAND,
  BACKUP_MAINTENANCE_TIMER,
  createBackupMaintenanceCommand,
  createBackupsArtifactTier,
  createBackupsStore,
} from "./adapters/backups.js";
import { loadConfig } from "./config.js";
import { ALL_TENANTS } from "./rbac/scope.js";
import type { RequestCaller, RequestContext, Route, RouteResponse } from "./server.js";

const opened: App[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const app of opened.splice(0)) {
    app.close();
  }
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const ADMIN_CALLER: RequestCaller & { id: string } = {
  id: "user-admin",
  roles: ["admin"],
  tenantScope: ALL_TENANTS,
};

function matchPath(routePath: string, actualPath: string): Record<string, string> | null {
  const routeParts = routePath.split("/").filter((part) => part.length > 0);
  const actualParts = actualPath.split("/").filter((part) => part.length > 0);
  if (routeParts.length !== actualParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < routeParts.length; i += 1) {
    const rp = routeParts[i]!;
    const ap = actualParts[i]!;
    if (rp.startsWith(":")) params[rp.slice(1)] = decodeURIComponent(ap);
    else if (rp !== ap) return null;
  }
  return params;
}

async function invoke(
  app: App,
  method: string,
  rawUrl: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<RouteResponse> {
  const url = new URL(rawUrl, "http://portal.invalid");
  const upper = method.toUpperCase();
  let matched: Route | undefined;
  let params: Record<string, string> = {};
  for (const route of app.routes) {
    if (route.method.toUpperCase() !== upper) continue;
    const found = matchPath(route.path, url.pathname);
    if (found) {
      matched = route;
      params = found;
      break;
    }
  }
  if (!matched) {
    return { status: 404, body: { code: "route.not_found", method: upper, path: url.pathname } };
  }
  const ctx: RequestContext = {
    correlationId: "corr-epic035-mount",
    method: upper,
    path: url.pathname,
    query: url.searchParams,
    headers: { "content-type": "application/json", ...headers },
    params,
    body,
    caller: ADMIN_CALLER,
  };
  try {
    return await matched.handler(ctx);
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500;
    const code = (err as { code?: string })?.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    return { status, body: { code, message } };
  }
}

async function readStreamBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("EPIC-035 Backup routes & maintenance are mounted (T-0865)", () => {
  it("serves backup list, create, download, settings, restore, and delete through real SQLite and artifact storage", async () => {
    const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m365-backup-mount-"));
    tempDirs.push(artifactRoot);
    const db = new Database(":memory:");
    const app = createApp(
      { ...loadConfig({}), devIdentityRole: "admin", artifactPath: artifactRoot },
      { db, schedulerIntervalMs: 60_000 },
    );
    opened.push(app);

    const createdTenant = await invoke(app, "POST", "/v1/tenants", {
      id: "tenant-alpha",
      displayName: "Alpha Tenant",
    });
    expect(createdTenant.status).toBe(201);

    const settingsGet = await invoke(app, "GET", "/v1/backup-settings");
    expect(settingsGet.status).toBe(200);
    expect((settingsGet.body as { retentionDays: number }).retentionDays).toBe(30);

    const settingsPut = await invoke(app, "PUT", "/v1/backup-settings", {
      retentionDays: 14,
      replicationTarget: "replica",
    });
    expect(settingsPut.status).toBe(200);
    expect((settingsPut.body as { retentionDays: number }).retentionDays).toBe(14);

    const created = await invoke(app, "POST", "/v1/backups", {
      type: "tenant",
      tenantId: "tenant-alpha",
    });
    expect(created.status).toBe(201);
    const backup = created.body as { id: string; artifactRef: string };
    expect(backup.id).toBeTruthy();

    const list = await invoke(app, "GET", "/v1/backups");
    expect(list.status).toBe(200);
    expect((list.body as { items: Array<{ id: string }> }).items.map((b) => b.id)).toContain(backup.id);

    const download = await invoke(app, "GET", `/v1/backups/${backup.id}/download`);
    expect(download.status).toBe(200);
    expect(download.stream).toBeDefined();
    const zipBytes = await readStreamBuffer(download.stream!);
    expect(zipBytes.subarray(0, 2).toString("utf8")).toBe("PK");

    const restore = await invoke(
      app,
      "POST",
      `/v1/backups/${backup.id}/restore`,
      { confirm: true },
      { "idempotency-key": "restore-key-1" },
    );
    expect(restore.status).toBe(200);

    const del = await invoke(app, "DELETE", `/v1/backups/${backup.id}`);
    expect(del.status).toBe(204);
  });

  it("registers the backup-maintenance timer and executes retention + replication", async () => {
    expect(BACKUP_MAINTENANCE_TIMER.command).toBe(BACKUP_MAINTENANCE_COMMAND);
    const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m365-backup-maint-"));
    tempDirs.push(artifactRoot);
    const db = new Database(":memory:");
    const app = createApp(
      { ...loadConfig({}), devIdentityRole: "admin", artifactPath: artifactRoot },
      { db, schedulerIntervalMs: 60_000 },
    );
    opened.push(app);

    // Schedule tick should find backup-maintenance in system_timer_state after configuration,
    // and direct maintenance command invocation prunes expired backups and replicates the latest.
    await invoke(app, "PUT", "/v1/backup-settings", {
      retentionDays: 7,
      replicationTarget: "secondary-copy",
    });
    await invoke(app, "POST", "/v1/backups", { type: "instance" });

    // Create a store backed by the same DB + artifact root to trigger maintenance deterministically.
    const { SqliteRepository, loadMigrations, runMigrations } = await import("@m365-assess/db");
    const version = runMigrations(db, loadMigrations());
    const repo = new SqliteRepository(db, version, "memory");
    const store = createBackupsStore(db, repo);
    const artifacts = createBackupsArtifactTier(artifactRoot);

    const outcome = await createBackupMaintenanceCommand({ store, artifacts })(
      undefined,
      new AbortController().signal,
    );
    expect(outcome.status).toBe("succeeded");
    expect(outcome.replication.replicated).toBe(true);
    expect(await artifacts.exists(outcome.replication.targetRef!)).toBe(true);
  });
});
