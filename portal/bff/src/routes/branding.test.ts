// Tests for the branding API, end to end through the server (T-0724).
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_TENANTS } from "../rbac/scope.js";
import { buildServer } from "../server.js";
import {
  BRANDING_ASSET_UPLOAD_PATH,
  BRANDING_PATH,
  BRANDING_PREVIEW_PATH,
  createBrandingRoutes,
  type BrandingCaller,
  type BrandingStore,
} from "./branding.js";
import { defaultBrandingConfig, type BrandingConfig } from "../branding/schema.js";

const ADMIN: BrandingCaller = {
  userId: "admin-1",
  roles: ["admin"],
  tenantScope: ALL_TENANTS,
  permissions: ["CIPP.AppSettings.Read", "CIPP.AppSettings.ReadWrite"],
};

const READONLY: BrandingCaller = {
  userId: "reader-1",
  roles: ["admin"],
  tenantScope: ALL_TENANTS,
  permissions: ["CIPP.AppSettings.Read"],
};

function storedConfig(): BrandingConfig {
  return {
    ...defaultBrandingConfig(),
    colors: { primary: "#1B4F72", secondary: "#2E86C1" },
    logoRef: "branding/logo-1.png",
    coverRef: null,
    watermark: { enabled: true, text: "Confidential" },
    footer: { show: true, text: "Contoso Consulting", coverText: "Cover footer" },
    pageNumbers: { show: true },
    presets: [{ id: "default", name: "Default", colors: { primary: "#111111", secondary: "#222222" } }],
    perReportDefaults: { executive: { primary: "#000000", showPageNumbers: false } },
  };
}

class FakeBrandingStore implements BrandingStore {
  private snapshot: ReturnType<typeof storedConfig> & { updatedAt: string; updatedBy: string | null } | undefined;
  readonly upserts: Array<BrandingConfig & { updatedBy: string | null }> = [];

  constructor(initial?: BrandingConfig) {
    this.snapshot = initial ? { ...initial, updatedAt: "2026-09-28T12:00:00.000Z", updatedBy: "seed" } : undefined;
  }

  async getBranding() {
    return this.snapshot;
  }

  async upsertBranding(input: BrandingConfig & { updatedBy: string | null }) {
    this.upserts.push(input);
    this.snapshot = { ...input, updatedAt: "2026-09-29T00:00:00.000Z", updatedBy: input.updatedBy };
    return this.snapshot;
  }
}

function makePng(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  const iend = Buffer.alloc(12);
  iend.write("IEND", 4, "ascii");
  return Buffer.concat([header, ihdr, iend]);
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function harness(initial?: BrandingConfig) {
  const artifactRoot = mkdtempSync(join(tmpdir(), "branding-routes-"));
  const store = new FakeBrandingStore(initial);
  const audits: Array<Record<string, unknown>> = [];
  let caller: BrandingCaller | undefined = ADMIN;
  const routes = createBrandingRoutes({
    store,
    artifactRoot,
    resolveCaller: () => caller,
    audit: {
      record: (event) => {
        audits.push(event);
      },
    },
  });
  const server: Server = buildServer({ routes, openapiDocument: "openapi: 3.0.0" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
    () => rmSync(artifactRoot, { recursive: true, force: true }),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    artifactRoot,
    store,
    audits,
    setCaller: (c: BrandingCaller | undefined) => {
      caller = c;
    },
    upload: (kind: string, body: BodyInit, query = "") =>
      fetch(`${base}${BRANDING_ASSET_UPLOAD_PATH.replace(":kind", kind)}${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
      }),
  };
}

describe("GET /v1/branding", () => {
  it("returns the stored config with resolved asset URLs", async () => {
    const h = await harness(storedConfig());
    const res = await fetch(`${h.base}${BRANDING_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branding: Record<string, unknown> };
    expect(body.branding).toMatchObject({
      schemaVersion: "v1",
      logoRef: "branding/logo-1.png",
      logoUrl: "/v1/branding/assets/logo-1.png",
      coverRef: null,
      coverUrl: null,
      watermark: { enabled: true, text: "Confidential" },
      footer: { show: true, text: "Contoso Consulting", coverText: "Cover footer" },
      pageNumbers: { show: true },
    });
    expect(body.branding["presets"]).toHaveLength(1);
    expect(body.branding["perReportDefaults"]).toEqual({ executive: { primary: "#000000", showPageNumbers: false } });
  });

  it("falls back to the default config when nothing is stored", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}${BRANDING_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branding: Record<string, unknown> };
    expect(body.branding).toMatchObject({
      colors: { primary: "#1B4F72", secondary: "#2E86C1" },
      logoRef: null,
      logoUrl: null,
    });
  });

  it("requires authentication", async () => {
    const h = await harness();
    h.setCaller(undefined);
    const res = await fetch(`${h.base}${BRANDING_PATH}`);
    expect(res.status).toBe(401);
  });

  it("forbids a caller without the read permission", async () => {
    const h = await harness();
    h.setCaller({ userId: "operator-1", roles: ["operator"], tenantScope: ALL_TENANTS, permissions: [] });
    const res = await fetch(`${h.base}${BRANDING_PATH}`);
    expect(res.status).toBe(403);
  });
});

describe("PUT /v1/branding", () => {
  it("validates, persists, and audits a valid config", async () => {
    const h = await harness();
    const draft = storedConfig();
    const res = await fetch(`${h.base}${BRANDING_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branding: Record<string, unknown> };
    expect(body.branding).toMatchObject({ logoRef: "branding/logo-1.png", logoUrl: "/v1/branding/assets/logo-1.png" });
    expect(h.store.upserts).toHaveLength(1);
    expect(h.store.upserts[0]).toMatchObject({ logoRef: "branding/logo-1.png", updatedBy: "admin-1" });
    expect(h.audits).toEqual([
      expect.objectContaining({ action: "branding.update", actor: "admin-1", targetType: "branding", targetId: "default" }),
    ]);

    const fetched = await fetch(`${h.base}${BRANDING_PATH}`);
    const fetchedBody = (await fetched.json()) as { branding: Record<string, unknown> };
    expect(fetchedBody.branding).toMatchObject({ logoRef: "branding/logo-1.png" });
  });

  it("rejects a config that fails the T-0723 schema and persists nothing", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}${BRANDING_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...storedConfig(), colors: { primary: "blue", secondary: "#2E86C1" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details: Array<{ field: string }> };
    expect(body.code).toBe("request.validation_failed");
    expect(body.details[0]?.field).toBe("branding.colors.primary");
    expect(h.store.upserts).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("rejects an inline data URL as an asset reference", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}${BRANDING_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...storedConfig(), logoRef: "data:image/png;base64,AAAA" }),
    });
    expect(res.status).toBe(400);
    expect(h.store.upserts).toHaveLength(0);
  });

  it("requires the write permission", async () => {
    const h = await harness();
    h.setCaller(READONLY);
    const res = await fetch(`${h.base}${BRANDING_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(storedConfig()),
    });
    expect(res.status).toBe(403);
    expect(h.store.upserts).toHaveLength(0);
  });
});

describe("POST /v1/branding/preview", () => {
  it("returns CSS and fragments for an unsaved draft without persisting it", async () => {
    const h = await harness();
    const draft = storedConfig();
    const res = await fetch(`${h.base}${BRANDING_PREVIEW_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body["cssOverrides"]).toContain('<style id="m365-branding-css">');
    expect(body["cssOverrides"]).toContain("--accent: #1B4F72;");
    expect(body["coverFragment"]).toContain('<div class="m365-branding-cover" aria-hidden="true">');
    expect(body["coverFragment"]).toContain("Confidential");
    expect(body["footerFragment"]).toContain('content: "Contoso Consulting";');
    expect(h.store.upserts).toHaveLength(0);
  });

  it("applies per-report defaults for the requested report kind", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}${BRANDING_PREVIEW_PATH}?reportKind=executive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(storedConfig()),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body["cssOverrides"]).toContain("--accent: #000000;");
    expect(body["footerFragment"]).not.toContain("counter(page)");
  });

  it("rejects a draft that fails the T-0723 schema", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}${BRANDING_PREVIEW_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...storedConfig(), watermark: { enabled: true, text: "" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details: Array<{ field: string }> };
    expect(body.code).toBe("request.validation_failed");
    expect(body.details[0]?.field).toBe("branding.watermark.text");
    expect(h.store.upserts).toHaveLength(0);
  });
});

describe("POST /v1/branding/assets/:kind", () => {
  it("stores a validated PNG and returns the reference and resolved URL", async () => {
    const h = await harness();
    const bytes = makePng(64, 32);
    const res = await h.upload("logo", bytes);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ref"]).toMatch(/^branding\/logo-.*\.png$/);
    expect(body["url"]).toBe(`/v1/branding/assets/${(body["ref"] as string).slice("branding/".length)}`);
    expect(body).toMatchObject({ kind: "logo", type: "png", width: 64, height: 32, size: bytes.length });
    expect(h.audits).toEqual([
      expect.objectContaining({ action: "branding.asset.upload", actor: "admin-1", targetType: "branding_asset" }),
    ]);

    const download = await fetch(`${h.base}${body["url"] as string}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  });

  it("rejects an SVG through the T-0723 validation and stores nothing", async () => {
    const h = await harness();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', "utf8");
    const res = await h.upload("logo", svg);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("branding.unsupported_type");
    expect(readdirSync(h.artifactRoot)).toEqual([]);
    expect(h.audits).toHaveLength(0);
  });

  it("rejects an upload over the byte limit", async () => {
    const h = await harness();
    const oversized = Buffer.concat([makePng(8, 8), Buffer.alloc(2 * 1024 * 1024, 0)]);
    const res = await h.upload("cover", oversized);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("branding.too_large");
  });

  it("rejects an unknown asset kind", async () => {
    const h = await harness();
    const res = await h.upload("banner", makePng(8, 8));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("request.validation_failed");
  });

  it("requires the write permission", async () => {
    const h = await harness();
    h.setCaller(READONLY);
    const res = await h.upload("logo", makePng(8, 8));
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/branding/assets/:name", () => {
  it("404s for an asset that was never stored", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}/v1/branding/assets/missing.png`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("branding.asset_not_found");
  });

  it("refuses a traversal name", async () => {
    const h = await harness();
    const res = await fetch(`${h.base}/v1/branding/assets/..%2F..%2Fsecret.png`);
    expect(res.status).toBe(400);
  });
});
