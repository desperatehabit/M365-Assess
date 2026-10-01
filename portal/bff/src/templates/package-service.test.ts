// Tests for the template package manager: bundle schema validation, import
// (registration + audit), version-conflict rejection, export round-trip, and
// the route gates (EPIC-039 §3.5, §4.3, §8; T-0766).
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { openSqliteTemplateRepository } from "@m365-assess/db";
import {
  TEMPLATE_PACKAGES_PATH,
  TEMPLATE_PACKAGE_EXPORT_PATH,
  TEMPLATES_READ_PERMISSION,
  TEMPLATES_WRITE_PERMISSION,
  createTemplatePackageRoutes,
  type TemplatePackagesCaller,
} from "./package-routes.js";
import {
  TEMPLATE_PACKAGE_FORMAT_VERSION,
  TEMPLATE_PACKAGE_UNSUPPORTED_FORMAT,
  TEMPLATE_PACKAGE_VERSION_CONFLICT,
  compareTemplateVersions,
  createTemplatePackageService,
  parseTemplatePackageBundle,
  type TemplatePackageBundle,
} from "./package-service.js";

const VALID_BUNDLE: TemplatePackageBundle = {
  formatVersion: 1,
  name: "contoso-baselines",
  version: "1.0.0",
  contents: [
    { type: "standards", name: "Baseline v1", body: '{"standard":"CIS"}' },
    { type: "conditional-access", name: "CA require MFA", body: '{"displayName":"MFA"}' },
  ],
  dependencies: [{ name: "contoso-core", version: "1.0.0" }],
};

function caller(permissions: string[] = []): TemplatePackagesCaller {
  return { userId: "operator-1", permissions };
}

function captureError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected the function to throw");
}

function request(
  method: string,
  path: string,
  extra: Partial<{ params: Record<string, string>; query: URLSearchParams; body: unknown }> = {},
): { method: string; path: string; params: Record<string, string>; query: URLSearchParams; headers: Record<string, string>; body?: unknown } {
  return {
    method,
    path,
    params: extra.params ?? {},
    query: extra.query ?? new URLSearchParams(),
    headers: extra.headers ?? {},
    ...(extra.body !== undefined ? { body: extra.body } : {}),
  };
}

describe("parseTemplatePackageBundle (T-0766)", () => {
  it("accepts a well-formed bundle", () => {
    expect(parseTemplatePackageBundle(VALID_BUNDLE)).toEqual(VALID_BUNDLE);
  });

  it("rejects an unsupported formatVersion with a structured 400", () => {
    const error = captureError(() => parseTemplatePackageBundle({ ...VALID_BUNDLE, formatVersion: 2 }));
    expect(error).toMatchObject({
      status: 400,
      code: TEMPLATE_PACKAGE_UNSUPPORTED_FORMAT,
    });
    expect(error.details?.[0]?.field).toBe("formatVersion");
  });

  it("rejects a non-object body with a structured 400", () => {
    expect(captureError(() => parseTemplatePackageBundle("nope"))).toMatchObject({ status: 400 });
    expect(captureError(() => parseTemplatePackageBundle(null))).toMatchObject({ status: 400 });
  });

  it("rejects an invalid version with a structured 400", () => {
    for (const version of ["1.0", "v1.0.0", "", "1.0.0-beta"]) {
      expect(captureError(() => parseTemplatePackageBundle({ ...VALID_BUNDLE, version }))).toMatchObject({
        status: 400,
      });
    }
  });

  it("rejects an unregistered content type with a structured 400", () => {
    const bundle = {
      ...VALID_BUNDLE,
      contents: [{ type: "not-a-type", name: "x", body: "{}" }],
    };
    const error = captureError(() => parseTemplatePackageBundle(bundle));
    expect(error).toMatchObject({ status: 400 });
    expect(error.details?.[0]?.field).toBe("contents[0].type");
  });

  it("rejects a malformed dependency with a structured 400", () => {
    const bundle = { ...VALID_BUNDLE, dependencies: [{ name: "core", version: "latest" }] };
    expect(captureError(() => parseTemplatePackageBundle(bundle))).toMatchObject({ status: 400 });
  });
});

describe("compareTemplateVersions (T-0766)", () => {
  it("orders major.minor.patch numerically", () => {
    expect(compareTemplateVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareTemplateVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareTemplateVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareTemplateVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareTemplateVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });
});

describe("template package import and export (T-0766)", () => {
  it("registers contents in the local library, records the package, and audits the import", async () => {
    const store = await openSqliteTemplateRepository({ filename: ":memory:" });
    const audits: Record<string, unknown>[] = [];
    const service = createTemplatePackageService({
      store,
      recordAudit: async (event) => void audits.push(event),
    });
    try {
      const result = await service.importBundle(VALID_BUNDLE, "operator-1");
      expect(result.package.name).toBe("contoso-baselines");
      expect(result.package.version).toBe("1.0.0");
      expect(result.package.source).toBe("local");
      expect(result.items).toHaveLength(2);
      expect(result.dependencies).toEqual([{ name: "contoso-core", version: "1.0.0" }]);

      const items = await store.listTemplateLibraryItems({ source: "local" });
      expect(items.map((item) => item.name).sort()).toEqual(["Baseline v1", "CA require MFA"]);
      expect(items.every((item) => item.type === "standards" || item.type === "conditional-access")).toBe(true);

      const packages = await store.listTemplatePackages();
      expect(packages).toHaveLength(1);
      expect(packages[0]?.contents).toHaveLength(2);

      expect(audits).toEqual([
        expect.objectContaining({
          action: "template.package.import",
          targetType: "template-package",
          targetId: result.package.id,
          actor: "operator-1",
          result: "success",
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it("rejects a downgrade with a structured 409 and keeps the installed version", async () => {
    const store = await openSqliteTemplateRepository({ filename: ":memory:" });
    const service = createTemplatePackageService({ store });
    try {
      await service.importBundle(VALID_BUNDLE, "operator-1");
      try {
        await service.importBundle({ ...VALID_BUNDLE, version: "0.9.0" }, "operator-1");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toMatchObject({
          status: 409,
          code: TEMPLATE_PACKAGE_VERSION_CONFLICT,
        });
        expect((error as { details?: { field: string; existing: string }[] }).details?.[0]).toMatchObject({
          field: "version",
          existing: "1.0.0",
        });
      }
      const packages = await store.listTemplatePackages();
      expect(packages).toHaveLength(1);
      expect(packages[0]?.version).toBe("1.0.0");
    } finally {
      store.close();
    }
  });

  it("re-imports the same version idempotently and accepts an upgrade", async () => {
    const store = await openSqliteTemplateRepository({ filename: ":memory:" });
    const service = createTemplatePackageService({ store });
    try {
      await service.importBundle(VALID_BUNDLE, "operator-1");
      const again = await service.importBundle(VALID_BUNDLE, "operator-1");
      expect(again.package.id).toBe((await store.listTemplatePackages())[0]?.id);
      const upgraded = await service.importBundle(
        { ...VALID_BUNDLE, version: "1.1.0", contents: [{ type: "baseline", name: "B", body: "{}" }] },
        "operator-1",
      );
      expect(upgraded.package.version).toBe("1.1.0");
      const packages = await store.listTemplatePackages();
      expect(packages).toHaveLength(1);
      expect(packages[0]?.version).toBe("1.1.0");
    } finally {
      store.close();
    }
  });

  it("produces an export bundle that round-trips through import", async () => {
    const store = await openSqliteTemplateRepository({ filename: ":memory:" });
    const service = createTemplatePackageService({ store });
    try {
      await service.importBundle(VALID_BUNDLE, "operator-1");
      const exported = await service.exportBundle({ name: "shared-set", version: "2.0.0" });
      expect(exported.formatVersion).toBe(TEMPLATE_PACKAGE_FORMAT_VERSION);
      expect(exported.name).toBe("shared-set");
      expect(exported.version).toBe("2.0.0");
      expect(exported.contents).toEqual([
        { type: "standards", name: "Baseline v1", body: '{"standard":"CIS"}' },
        { type: "conditional-access", name: "CA require MFA", body: '{"displayName":"MFA"}' },
      ]);
      expect(exported.dependencies).toEqual([]);

      const roundTrip = await service.importBundle(exported, "operator-2");
      expect(roundTrip.items).toHaveLength(2);
      const items = await store.listTemplateLibraryItems({ source: "local" });
      expect(items).toHaveLength(4);
      expect(items.map((item) => item.name).sort()).toEqual([
        "Baseline v1",
        "Baseline v1",
        "CA require MFA",
        "CA require MFA",
      ]);
    } finally {
      store.close();
    }
  });

  it("exports only the selected item ids", async () => {
    const store = await openSqliteTemplateRepository({ filename: ":memory:" });
    const service = createTemplatePackageService({ store });
    try {
      const result = await service.importBundle(VALID_BUNDLE, "operator-1");
      const selected = result.items[0]!;
      const exported = await service.exportBundle({ itemIds: [selected.id] });
      expect(exported.contents).toEqual([{ type: "standards", name: "Baseline v1", body: '{"standard":"CIS"}' }]);
    } finally {
      store.close();
    }
  });

  it("lists recorded packages with their versions", async () => {
    const store = await openSqliteTemplateRepository({ filename: ":memory:" });
    const service = createTemplatePackageService({ store });
    try {
      await service.importBundle(VALID_BUNDLE, "operator-1");
      const packages = await service.listPackages();
      expect(packages).toEqual([
        expect.objectContaining({
          name: "contoso-baselines",
          version: "1.0.0",
          source: "local",
          itemCount: 2,
        }),
      ]);
    } finally {
      store.close();
    }
  });
});

describe("template package routes (T-0766)", () => {
  async function harness(caller: TemplatePackagesCaller | undefined) {
    const store = await openSqliteTemplateRepository({ filename: ":memory:" });
    const service = createTemplatePackageService({ store });
    const routes = createTemplatePackageRoutes({
      service,
      resolveCaller: () => caller,
    });
    return { store, routes, service };
  }

  it("rejects unauthenticated requests with 401", async () => {
    const { routes } = await harness(undefined);
    for (const route of routes) {
      await expect(
        route.handler(request(route.method, route.path)),
      ).rejects.toMatchObject({ status: 401, code: "request.unauthenticated" });
    }
  });

  it("gates the package list and export on templates.read", async () => {
    const { routes } = await harness(caller([]));
    const list = routes.find((r) => r.method === "GET" && r.path === TEMPLATE_PACKAGES_PATH)!;
    await expect(list.handler(request("GET", TEMPLATE_PACKAGES_PATH))).rejects.toMatchObject({
      status: 403,
    });
    const exportRoute = routes.find((r) => r.path === TEMPLATE_PACKAGE_EXPORT_PATH)!;
    await expect(
      exportRoute.handler(request("GET", TEMPLATE_PACKAGE_EXPORT_PATH)),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("gates import on templates.write", async () => {
    const { routes } = await harness(caller([TEMPLATES_READ_PERMISSION]));
    const importRoute = routes.find((r) => r.method === "POST")!;
    await expect(
      importRoute.handler(request("POST", TEMPLATE_PACKAGES_PATH, { body: VALID_BUNDLE })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("imports a bundle end to end and lists the recorded package", async () => {
    const { routes, store } = await harness(caller([TEMPLATES_READ_PERMISSION, TEMPLATES_WRITE_PERMISSION]));
    try {
      const importRoute = routes.find((r) => r.method === "POST")!;
      const importRes = await importRoute.handler(
        request("POST", TEMPLATE_PACKAGES_PATH, { body: VALID_BUNDLE }),
      );
      expect(importRes.status).toBe(201);
      expect((importRes.body as { items: unknown[] }).items).toHaveLength(2);

      const list = routes.find((r) => r.method === "GET" && r.path === TEMPLATE_PACKAGES_PATH)!;
      const listRes = await list.handler(request("GET", TEMPLATE_PACKAGES_PATH));
      expect(listRes.status).toBe(200);
      expect((listRes.body as { items: { name: string; version: string }[] }).items).toEqual([
        expect.objectContaining({ name: "contoso-baselines", version: "1.0.0" }),
      ]);
    } finally {
      store.close();
    }
  });

  it("refuses an unsupported formatVersion with a structured 400", async () => {
    const { routes } = await harness(caller([TEMPLATES_WRITE_PERMISSION]));
    const importRoute = routes.find((r) => r.method === "POST")!;
    await expect(
      importRoute.handler(
        request("POST", TEMPLATE_PACKAGES_PATH, { body: { ...VALID_BUNDLE, formatVersion: 9 } }),
      ),
    ).rejects.toMatchObject({ status: 400, code: TEMPLATE_PACKAGE_UNSUPPORTED_FORMAT });
  });

  it("exports the local library as a bundle through the export route", async () => {
    const { routes, store, service } = await harness(caller([TEMPLATES_READ_PERMISSION]));
    try {
      await service.importBundle(VALID_BUNDLE, "operator-1");
      const exportRoute = routes.find((r) => r.path === TEMPLATE_PACKAGE_EXPORT_PATH)!;
      const res = await exportRoute.handler(request("GET", TEMPLATE_PACKAGE_EXPORT_PATH));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        formatVersion: TEMPLATE_PACKAGE_FORMAT_VERSION,
        name: "local-library",
        version: "1.0.0",
      });
      expect((res.body as { contents: unknown[] }).contents).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});
