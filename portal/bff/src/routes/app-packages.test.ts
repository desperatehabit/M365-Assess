// Tests for app package ingest and signed download, end to end through the server (T-0842).
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_APP_PACKAGE_MAX_BYTES,
  loadConfig,
  parseAppPackageMaxBytes,
  parseAppPackageSecret,
  parseWorkerBaseUrl,
} from "../config.js";
import { tenantScope } from "../rbac/scope.js";
import { buildServer } from "../server.js";
import { AppPackageStore } from "../storage/app-packages.js";
import { createAppPackageRoutes, type AppPackageCaller } from "./app-packages.js";

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const SECRET = "p".repeat(32);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function harness(maxBytes = 1024) {
  const root = mkdtempSync(path.join(tmpdir(), "app-package-routes-"));
  let now = new Date("2026-09-28T12:00:00.000Z");
  const store = new AppPackageStore({ artifactRoot: root, signingSecret: SECRET, maxBytes, now: () => now });
  const audits: Array<Record<string, unknown>> = [];
  let caller: AppPackageCaller | undefined = { userId: "operator-1", permissions: ["Endpoint.Application.ReadWrite"], tenantScope: tenantScope([T1]) };
  const routes = createAppPackageRoutes({ packages: store, resolveCaller: () => caller, recordAudit: async (e) => void audits.push(e), now: () => now });
  const server: Server = buildServer({ routes, openapiDocument: "openapi: 3.0.0" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
    () => rmSync(root, { recursive: true, force: true }),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const upload = (body: BodyInit, query = "fileName=7zip.intunewin", headers: Record<string, string> = { "Content-Type": "application/octet-stream" }, tenant = T1) =>
    fetch(`${base}/v1/tenants/${tenant}/apps/packages?${query}`, { method: "POST", headers, body });
  return {
    root,
    store,
    base,
    audits,
    upload,
    advance: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
    setCaller: (c: AppPackageCaller | undefined) => {
      caller = c;
    },
  };
}

describe("POST /v1/tenants/:tenantId/apps/packages (T-0842)", () => {
  it("streams the package onto the artifact tier and returns id, size, and hash — never a path", async () => {
    const h = await harness();
    const res = await h.upload("hello world");
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      packageId: expect.any(String),
      fileName: "7zip.intunewin",
      size: 11,
      sha256: createHash("sha256").update("hello world").digest("hex"),
    });
    expect(JSON.stringify(body)).not.toContain(h.root);
    expect(await h.store.getPackage(T1, body["packageId"] as string)).toMatchObject({ size: 11 });
    expect(h.audits).toEqual([expect.objectContaining({ action: "intune.app.package.upload", tenantId: T1, actor: "operator-1" })]);
  });

  it("accepts a body larger than the JSON body cap", async () => {
    const h = await harness(4 * 1024 * 1024);
    const big = Buffer.alloc(2 * 1024 * 1024, 7);
    const res = await h.upload(big);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { size: number }).size).toBe(big.length);
  });

  it("refuses a declared size over the cap with 413 and stores nothing", async () => {
    const h = await harness(8);
    const res = await h.upload("0123456789");
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("app-package.too_large");
    expect(readdirSync(h.root)).toEqual([]);
  });

  it("cuts off a chunked upload that grows past the cap", async () => {
    const h = await harness(8);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("01234"));
        controller.enqueue(new TextEncoder().encode("56789"));
        controller.close();
      },
    });
    const res = await fetch(`${h.base}/v1/tenants/${T1}/apps/packages?fileName=a.intunewin`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(res.status).toBe(413);
    expect(readdirSync(path.join(h.root, "app-packages", T1))).toEqual([]);
  });

  it.each([
    ["a non-.intunewin name", "fileName=setup.exe", 400],
    ["no file name", "", 400],
  ])("rejects %s", async (_label, query, status) => {
    const h = await harness();
    expect((await h.upload("x", query)).status).toBe(status);
  });

  it("requires application/octet-stream", async () => {
    const h = await harness();
    expect((await h.upload("x", "fileName=a.intunewin", { "Content-Type": "application/json" })).status).toBe(415);
  });

  it("requires the write permission and the tenant in scope", async () => {
    const h = await harness();
    h.setCaller({ userId: "u", permissions: ["Endpoint.Application.Read"], tenantScope: tenantScope([T1]) });
    expect((await h.upload("x")).status).toBe(403);
    h.setCaller({ userId: "u", permissions: ["Remediation.Apply"], tenantScope: tenantScope([T1]) });
    expect((await h.upload("x")).status).toBe(201);
    expect((await h.upload("x", undefined, undefined, T2)).status).toBe(403);
    h.setCaller(undefined);
    expect((await h.upload("x")).status).toBe(401);
  });
});

describe("GET /v1/app-packages/:packageId (T-0842)", () => {
  async function uploaded() {
    const h = await harness();
    const { packageId } = (await (await h.upload("package-bytes")).json()) as { packageId: string };
    const signed = await h.store.createSignedUrl(T1, packageId, 60);
    return { h, packageId, url: `${h.base}${signed.url}` };
  }

  it("streams the package for a valid signature, with no caller", async () => {
    const { h, url } = await uploaded();
    h.setCaller(undefined);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("13");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-sha256")).toBe(createHash("sha256").update("package-bytes").digest("hex"));
    expect(await res.text()).toBe("package-bytes");
  });

  it("returns 403 for a tampered URL and 410 once it expires", async () => {
    const { h, url } = await uploaded();
    expect((await fetch(url.replace(/sig=[^&]+/, "sig=AAAA"))).status).toBe(403);
    expect((await fetch(url.replace(`tenant=${T1}`, `tenant=${T2}`))).status).toBe(403);
    h.advance(61);
    const expired = await fetch(url);
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as { code: string }).code).toBe("app-package.url_expired");
  });

  it("returns 404 for a signed URL whose package was deleted", async () => {
    const { h, packageId, url } = await uploaded();
    await h.store.deletePackage(T1, packageId);
    expect((await fetch(url)).status).toBe(404);
  });
});

describe("app package config (T-0842)", () => {
  it("defaults the cap, has no secret, and derives the worker base URL from host and port", () => {
    const config = loadConfig({ M365_BFF_PORT: "9000" });
    expect(config.appPackageSecret).toBeNull();
    expect(config.appPackageMaxBytes).toBe(DEFAULT_APP_PACKAGE_MAX_BYTES);
    expect(config.workerBaseUrl).toBe("http://127.0.0.1:9000");
  });

  it("reads the secret, cap, and worker URL", () => {
    const config = loadConfig({ M365_BFF_APP_PACKAGE_SECRET: SECRET, M365_BFF_APP_PACKAGE_MAX_BYTES: "1048576", M365_BFF_WORKER_BASE_URL: "https://bff.internal:8443/ignored/path" });
    expect(config.appPackageSecret).toBe(SECRET);
    expect(config.appPackageMaxBytes).toBe(1048576);
    expect(config.workerBaseUrl).toBe("https://bff.internal:8443");
  });

  it("refuses a short secret without echoing it", () => {
    let error: unknown;
    try {
      parseAppPackageSecret({ M365_BFF_APP_PACKAGE_SECRET: "tooshort" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toMatch(/at least 32 bytes/);
    expect(String(error)).not.toContain("tooshort");
  });

  it("refuses a bad cap and a non-http worker URL", () => {
    expect(() => parseAppPackageMaxBytes({ M365_BFF_APP_PACKAGE_MAX_BYTES: "lots" })).toThrow(ConfigError);
    expect(() => parseAppPackageMaxBytes({ M365_BFF_APP_PACKAGE_MAX_BYTES: "0" })).toThrow(ConfigError);
    expect(() => parseWorkerBaseUrl({ M365_BFF_WORKER_BASE_URL: "file:///etc" }, "127.0.0.1", 8080)).toThrow(ConfigError);
    expect(() => parseWorkerBaseUrl({ M365_BFF_WORKER_BASE_URL: "not a url" }, "127.0.0.1", 8080)).toThrow(ConfigError);
  });
});
