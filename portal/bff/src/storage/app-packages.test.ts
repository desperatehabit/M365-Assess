// Tests for app package storage and signed URLs (T-0322).
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_PACKAGE_DIR,
  AppPackageErrorCodes,
  AppPackageStore,
  MAX_APP_PACKAGE_URL_TTL_SECONDS,
  sanitizePackageFileName,
  type AppPackageStoreOptions,
} from "./app-packages.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const SECRET = "x".repeat(32);
const T0 = new Date("2026-09-28T12:00:00.000Z");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(extra: Partial<AppPackageStoreOptions> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "app-packages-"));
  roots.push(root);
  let now = T0;
  let n = 0;
  const store = new AppPackageStore({
    artifactRoot: root,
    signingSecret: SECRET,
    now: () => now,
    newId: () => `pkg-${++n}`,
    ...extra,
  });
  return {
    root,
    store,
    advance: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
}

function chunks(...parts: string[]): Readable {
  return Readable.from(parts.map((p) => Buffer.from(p)));
}

function queryOf(url: string): { id: string; query: URLSearchParams } {
  const parsed = new URL(url, "http://bff.local");
  return { id: decodeURIComponent(parsed.pathname.split("/").pop()!), query: parsed.searchParams };
}

describe("AppPackageStore.storePackage (T-0322)", () => {
  it("streams the package onto the artifact tier and records size and sha256", async () => {
    const { root, store } = harness();
    const stored = await store.storePackage(TENANT, "7zip.intunewin", chunks("hello ", "world"));
    expect(stored).toEqual({
      packageId: "pkg-1",
      tenantId: TENANT,
      fileName: "7zip.intunewin",
      size: 11,
      sha256: createHash("sha256").update("hello world").digest("hex"),
      storedAt: T0.toISOString(),
    });
    const dir = path.join(root, APP_PACKAGE_DIR, TENANT, "pkg-1");
    expect(readdirSync(dir).sort()).toEqual(["meta.json", "package.bin"]);
    const opened = await store.openPackage(TENANT, "pkg-1");
    expect(await text(opened.stream)).toBe("hello world");
  });

  it("returns no filesystem path to the caller", async () => {
    const { root, store } = harness();
    const stored = await store.storePackage(TENANT, "../../etc/passwd", chunks("x"));
    expect(JSON.stringify(stored)).not.toContain(root);
    expect(stored.fileName).toBe("passwd");
  });

  it("cuts off an upload that grows past the size cap and removes the partial file", async () => {
    const { root, store } = harness({ maxBytes: 8 });
    await expect(store.storePackage(TENANT, "big.bin", chunks("12345", "67890"))).rejects.toMatchObject({
      code: AppPackageErrorCodes.tooLarge,
      status: 413,
    });
    expect(readdirSync(path.join(root, APP_PACKAGE_DIR, TENANT))).toEqual([]);
  });

  it("refuses a declared size over the cap before writing anything", async () => {
    const { root, store } = harness({ maxBytes: 8 });
    await expect(store.storePackage(TENANT, "big.bin", chunks("x"), 9)).rejects.toMatchObject({ status: 413 });
    expect(existsSync(path.join(root, APP_PACKAGE_DIR))).toBe(false);
  });

  it("accepts a package exactly at the cap", async () => {
    const { store } = harness({ maxBytes: 4 });
    await expect(store.storePackage(TENANT, "ok.bin", chunks("12", "34"))).resolves.toMatchObject({ size: 4 });
  });

  it("keeps tenants apart and rejects path-like identifiers", async () => {
    const { store } = harness();
    await store.storePackage(TENANT, "a.bin", chunks("a"));
    expect(await store.getPackage(OTHER_TENANT, "pkg-1")).toBeUndefined();
    await expect(store.openPackage(OTHER_TENANT, "pkg-1")).rejects.toMatchObject({ status: 404 });
    await expect(store.getPackage(TENANT, "../pkg-1")).rejects.toMatchObject({ status: 400 });
    await expect(store.getPackage("..", "pkg-1")).rejects.toMatchObject({ status: 400 });
  });

  it("deletes a package", async () => {
    const { store } = harness();
    await store.storePackage(TENANT, "a.bin", chunks("a"));
    expect(await store.deletePackage(TENANT, "pkg-1")).toBe(true);
    expect(await store.getPackage(TENANT, "pkg-1")).toBeUndefined();
    expect(await store.deletePackage(TENANT, "pkg-1")).toBe(false);
  });
});

describe("AppPackageStore signed URLs (T-0322)", () => {
  it("mints a URL with a bounded default lifetime that verifies", async () => {
    const { store } = harness();
    await store.storePackage(TENANT, "a.bin", chunks("a"));
    const signed = await store.createSignedUrl(TENANT, "pkg-1");
    expect(signed.url.startsWith("/v1/app-packages/pkg-1?")).toBe(true);
    expect(signed.expiresAt).toBe("2026-09-28T12:15:00.000Z");
    const { id, query } = queryOf(signed.url);
    expect(store.verifySignedUrl(id, query)).toEqual({ tenantId: TENANT, packageId: "pkg-1" });
  });

  it("rejects a URL once it expires", async () => {
    const { store, advance } = harness();
    await store.storePackage(TENANT, "a.bin", chunks("a"));
    const { id, query } = queryOf((await store.createSignedUrl(TENANT, "pkg-1", 60)).url);
    advance(59);
    expect(() => store.verifySignedUrl(id, query)).not.toThrow();
    advance(1);
    expect(() => store.verifySignedUrl(id, query)).toThrow(expect.objectContaining({ status: 410 }));
  });

  it("refuses a lifetime above the cap or below one second", async () => {
    const { store } = harness();
    await store.storePackage(TENANT, "a.bin", chunks("a"));
    for (const ttl of [0, MAX_APP_PACKAGE_URL_TTL_SECONDS + 1, 1.5]) {
      await expect(store.createSignedUrl(TENANT, "pkg-1", ttl)).rejects.toMatchObject({
        code: AppPackageErrorCodes.invalidTtl,
      });
    }
    expect(() => harness({ defaultTtlSeconds: 7200 })).toThrow();
  });

  it("will not sign a package that does not exist", async () => {
    const { store } = harness();
    await expect(store.createSignedUrl(TENANT, "pkg-404")).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ["another tenant", (q: URLSearchParams) => q.set("tenant", OTHER_TENANT)],
    ["a later expiry", (q: URLSearchParams) => q.set("expires", String(Number(q.get("expires")) + 3600))],
    ["a forged signature", (q: URLSearchParams) => q.set("sig", Buffer.alloc(32).toString("base64url"))],
    ["a truncated signature", (q: URLSearchParams) => q.set("sig", q.get("sig")!.slice(0, 10))],
    ["no signature", (q: URLSearchParams) => q.delete("sig")],
  ])("rejects a URL tampered with %s", async (_label, tamper) => {
    const { store } = harness();
    await store.storePackage(TENANT, "a.bin", chunks("a"));
    const { id, query } = queryOf((await store.createSignedUrl(TENANT, "pkg-1")).url);
    tamper(query);
    expect(() => store.verifySignedUrl(id, query)).toThrow(
      expect.objectContaining({ code: AppPackageErrorCodes.invalidSignature, status: 403 }),
    );
  });

  it("rejects a URL moved to another package id", async () => {
    const { store } = harness();
    await store.storePackage(TENANT, "a.bin", chunks("a"));
    await store.storePackage(TENANT, "b.bin", chunks("b"));
    const { query } = queryOf((await store.createSignedUrl(TENANT, "pkg-1")).url);
    expect(() => store.verifySignedUrl("pkg-2", query)).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("rejects a URL signed with a different secret", async () => {
    const a = harness();
    await a.store.storePackage(TENANT, "a.bin", chunks("a"));
    const { id, query } = queryOf((await a.store.createSignedUrl(TENANT, "pkg-1")).url);
    const b = harness({ signingSecret: "y".repeat(32) });
    expect(() => b.store.verifySignedUrl(id, query)).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("requires a signing secret of at least 32 bytes", () => {
    expect(() => harness({ signingSecret: "short" })).toThrow(/at least 32 bytes/);
  });
});

describe("sanitizePackageFileName (T-0322)", () => {
  it("strips directories, control characters, and leading dots", () => {
    expect(sanitizePackageFileName("C:\\temp\\setup.exe")).toBe("setup.exe");
    expect(sanitizePackageFileName("..\u0000hidden.msi")).toBe("hidden.msi");
    expect(sanitizePackageFileName("dir/")).toBe("package");
  });
});
