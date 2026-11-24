import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../app.js";
import { loadConfig } from "../config.js";
import { ALL_TENANTS } from "../rbac/scope.js";
import type { Caller } from "../rbac/authorize.js";
import { buildServer } from "../server.js";
import type { RequestContext } from "../server.js";
import {
  BUILT_IN_RUN_TEMPLATES,
  RUN_TEMPLATE_COPY_PATH,
  RUN_TEMPLATE_DETAIL_PATH,
  RUN_TEMPLATE_PERMISSIONS,
  RUN_TEMPLATES_OPENAPI,
  RUN_TEMPLATES_PATH,
  createRunTemplateRoutes,
  type RunTemplatePatchInput,
  type RunTemplateRecord,
  type RunTemplateStore,
  type RunTemplateWriteInput,
} from "./run-templates.js";
import { TEMPLATE_BUILTIN_LOCKED } from "./template-builtin.js";

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

class MemoryRunTemplateStore implements RunTemplateStore {
  readonly rows = new Map<string, RunTemplateRecord>();

  async createRunTemplate(input: RunTemplateWriteInput): Promise<RunTemplateRecord> {
    const now = "2026-05-01T00:00:00.000Z";
    const record: RunTemplateRecord = {
      id: input.id ?? `generated-${this.rows.size + 1}`,
      name: input.name,
      description: input.description ?? null,
      sections: [...(input.sections ?? [])],
      options: {
        quickScan: false,
        skipPurview: false,
        redact: false,
        evidence: false,
        autoBaseline: false,
        ...(input.options ?? {}),
      },
      framework: input.framework ?? null,
      createdBy: input.createdBy ?? null,
      updatedBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async getRunTemplate(id: string): Promise<RunTemplateRecord | undefined> {
    const row = this.rows.get(id);
    return row && row.deletedAt === null ? row : undefined;
  }

  async listRunTemplates(): Promise<readonly RunTemplateRecord[]> {
    return [...this.rows.values()].filter((row) => row.deletedAt === null);
  }

  async updateRunTemplate(
    id: string,
    patch: RunTemplatePatchInput,
  ): Promise<RunTemplateRecord | undefined> {
    const existing = await this.getRunTemplate(id);
    if (!existing) return undefined;
    const updated: RunTemplateRecord = {
      ...existing,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.sections === undefined ? {} : { sections: [...patch.sections] }),
      ...(patch.options === undefined
        ? {}
        : { options: { ...existing.options, ...patch.options } }),
      ...(patch.framework === undefined ? {} : { framework: patch.framework }),
      updatedBy: patch.updatedBy ?? null,
      updatedAt: "2026-05-02T00:00:00.000Z",
    };
    this.rows.set(id, updated);
    return updated;
  }

  async softDeleteRunTemplate(id: string): Promise<boolean> {
    const existing = await this.getRunTemplate(id);
    if (!existing) return false;
    this.rows.set(id, { ...existing, deletedAt: "2026-05-03T00:00:00.000Z" });
    return true;
  }
}

function makeContext(
  params: Record<string, string> = {},
  body?: unknown,
): RequestContext {
  return {
    correlationId: "corr-run-templates",
    method: "GET",
    path: RUN_TEMPLATES_PATH,
    query: new URLSearchParams(),
    headers: {},
    params,
    ...(body === undefined ? {} : { body }),
  };
}

function setup() {
  const store = new MemoryRunTemplateStore();
  const routes = createRunTemplateRoutes({
    store,
    resolveCaller: () => adminCaller(),
    authorize: () => undefined,
    idGenerator: (() => {
      let seq = 0;
      return () => `tpl-${(seq += 1)}`;
    })(),
  });
  const byPath = (method: string, path: string) =>
    routes.find((route) => route.method === method && route.path === path)!;
  return { store, routes, byPath };
}

describe("GET /v1/run-templates (T-0922)", () => {
  it("lists the five built-in templates with builtIn: true", async () => {
    const { byPath } = setup();
    const response = await byPath("GET", RUN_TEMPLATES_PATH).handler(makeContext());
    const body = response.body as { items: RunTemplateRecord[] };

    expect(response.status).toBe(200);
    expect(body.items.map((item) => item.id)).toEqual([
      "builtin-full-assessment",
      "builtin-quick-identity",
      "builtin-email-security",
      "builtin-cis-m365",
      "builtin-baseline-drift",
    ]);
    for (const item of body.items) {
      expect(item.builtIn).toBe(true);
      expect(item.sections.length).toBeGreaterThan(0);
    }
  });

  it("defines the built-in scope and options from the ticket", () => {
    const byId = new Map(BUILT_IN_RUN_TEMPLATES.map((template) => [template.id, template]));

    expect(byId.get("builtin-full-assessment")?.sections).toHaveLength(13);
    expect(byId.get("builtin-quick-identity")?.sections).toEqual(["Identity"]);
    expect(byId.get("builtin-email-security")?.sections).toEqual(["Email", "Security"]);
    expect(byId.get("builtin-cis-m365")?.framework).toBe("cis-m365-v6");
    expect(byId.get("builtin-baseline-drift")?.options.autoBaseline).toBe(true);
  });

  it("merges saved templates after the built-ins", async () => {
    const { byPath, store } = setup();
    await store.createRunTemplate({ id: "saved-1", name: "My template", sections: ["Email"] });

    const response = await byPath("GET", RUN_TEMPLATES_PATH).handler(makeContext());
    const body = response.body as { items: RunTemplateRecord[] };

    expect(body.items).toHaveLength(BUILT_IN_RUN_TEMPLATES.length + 1);
    expect(body.items.at(-1)).toMatchObject({ id: "saved-1", builtIn: false });
  });
});

describe("built-in locking (T-0922/T-0924)", () => {
  it("refuses PATCH on a built-in with 403 template.builtin_locked", async () => {
    const { byPath, store } = setup();
    await expect(
      byPath("PATCH", RUN_TEMPLATE_DETAIL_PATH).handler(
        makeContext({ templateId: "builtin-full-assessment" }, { name: "Changed" }),
      ),
    ).rejects.toMatchObject({ status: 403, code: TEMPLATE_BUILTIN_LOCKED });
    expect(store.rows.size).toBe(0);
  });

  it("refuses DELETE on a built-in with 403 template.builtin_locked", async () => {
    const { byPath } = setup();
    await expect(
      byPath("DELETE", RUN_TEMPLATE_DETAIL_PATH).handler(
        makeContext({ templateId: "builtin-quick-identity" }),
      ),
    ).rejects.toMatchObject({ status: 403, code: TEMPLATE_BUILTIN_LOCKED });
  });

  it("makes an editable copy of a built-in", async () => {
    const { byPath, store } = setup();
    const response = await byPath("POST", RUN_TEMPLATE_COPY_PATH).handler(
      makeContext({ templateId: "builtin-email-security" }),
    );
    const body = response.body as { template: RunTemplateRecord };

    expect(response.status).toBe(201);
    expect(body.template).toMatchObject({
      id: "tpl-1",
      name: "Email security (copy)",
      builtIn: false,
      sections: ["Email", "Security"],
    });

    const saved = await store.getRunTemplate("tpl-1");
    expect(saved?.builtIn).toBeUndefined();

    // The copy is editable and renameable through PATCH.
    const patched = await byPath("PATCH", RUN_TEMPLATE_DETAIL_PATH).handler(
      makeContext({ templateId: "tpl-1" }, { name: "Email security (mine)" }),
    );
    expect((patched.body as { template: RunTemplateRecord }).template.name).toBe(
      "Email security (mine)",
    );

    // The original built-in is untouched.
    const original = await byPath("GET", RUN_TEMPLATE_DETAIL_PATH).handler(
      makeContext({ templateId: "builtin-email-security" }),
    );
    expect((original.body as { template: RunTemplateRecord }).template.name).toBe(
      "Email security",
    );
  });

  it("keeps copy names unique", async () => {
    const { byPath, store } = setup();
    await store.createRunTemplate({ id: "existing", name: "Email security (copy)", sections: [] });

    const response = await byPath("POST", RUN_TEMPLATE_COPY_PATH).handler(
      makeContext({ templateId: "builtin-email-security" }),
    );
    expect((response.body as { template: RunTemplateRecord }).template.name).toBe(
      "Email security (copy 2)",
    );
  });
});

describe("operator template CRUD (T-0922)", () => {
  it("creates, reads, updates and deletes a saved template", async () => {
    const { byPath } = setup();

    const created = await byPath("POST", RUN_TEMPLATES_PATH).handler(
      makeContext({}, { name: "My check", sections: ["Identity"], options: { quickScan: true } }),
    );
    expect(created.status).toBe(201);
    const createdTemplate = (created.body as { template: RunTemplateRecord }).template;
    expect(createdTemplate).toMatchObject({
      id: "tpl-1",
      name: "My check",
      builtIn: false,
      sections: ["Identity"],
    });
    expect(createdTemplate.options.quickScan).toBe(true);

    const read = await byPath("GET", RUN_TEMPLATE_DETAIL_PATH).handler(
      makeContext({ templateId: "tpl-1" }),
    );
    expect(read.status).toBe(200);

    const updated = await byPath("PATCH", RUN_TEMPLATE_DETAIL_PATH).handler(
      makeContext({ templateId: "tpl-1" }, { name: "Renamed", sections: ["Identity", "Email"] }),
    );
    expect(updated.status).toBe(200);
    expect((updated.body as { template: RunTemplateRecord }).template).toMatchObject({
      name: "Renamed",
      sections: ["Identity", "Email"],
    });

    const deleted = await byPath("DELETE", RUN_TEMPLATE_DETAIL_PATH).handler(
      makeContext({ templateId: "tpl-1" }),
    );
    expect(deleted.status).toBe(204);

    await expect(
      byPath("GET", RUN_TEMPLATE_DETAIL_PATH).handler(makeContext({ templateId: "tpl-1" })),
    ).rejects.toMatchObject({ status: 404, code: "run_template.not_found" });
  });

  it("rejects an unknown template option instead of silently dropping it", async () => {
    const { byPath } = setup();
    await expect(
      byPath("POST", RUN_TEMPLATES_PATH).handler(
        makeContext({}, { name: "Bad", options: { quantum: true } }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "run_template.invalid" });
  });

  it("requires a caller and the run write permission", async () => {
    const store = new MemoryRunTemplateStore();
    const routes = createRunTemplateRoutes({
      store,
      resolveCaller: () => undefined,
      authorize: () => undefined,
    });
    const list = routes.find((route) => route.method === "GET")!;
    await expect(list.handler(makeContext())).rejects.toMatchObject({ status: 401 });

    let denied: string | undefined;
    const guarded = createRunTemplateRoutes({
      store,
      resolveCaller: () => adminCaller(),
      authorize: (_caller, permission) => {
        denied = permission;
        throw new Error("denied");
      },
    });
    await expect(
      guarded.find((route) => route.method === "POST")!.handler(
        makeContext({}, { name: "Blocked" }),
      ),
    ).rejects.toThrow("denied");
    expect(denied).toBe(RUN_TEMPLATE_PERMISSIONS.write);
  });
});

describe("run template OpenAPI metadata (T-0922)", () => {
  it("declares every operation with a permission", () => {
    const paths = RUN_TEMPLATES_OPENAPI;
    expect(paths["/run-templates"].get.permission).toBe(RUN_TEMPLATE_PERMISSIONS.read);
    expect(paths["/run-templates"].post.permission).toBe(RUN_TEMPLATE_PERMISSIONS.write);
    expect(paths["/run-templates/{templateId}"].patch.permission).toBe(
      RUN_TEMPLATE_PERMISSIONS.write,
    );
    expect(paths["/run-templates/{templateId}"].delete.permission).toBe(
      RUN_TEMPLATE_PERMISSIONS.write,
    );
    expect(paths["/run-templates/{templateId}/copy"].post.permission).toBe(
      RUN_TEMPLATE_PERMISSIONS.write,
    );
    expect(RUN_TEMPLATE_DETAIL_PATH).toBe("/v1/run-templates/:templateId");
  });
});

describe("run templates are mounted through createApp (T-0922)", () => {
  const opened: { server: Server; app: App }[] = [];

  afterEach(async () => {
    for (const { server, app } of opened.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.close();
    }
  });

  it("serves GET /v1/run-templates instead of a router 404", async () => {
    const app = createApp(
      { ...loadConfig({}), devIdentityRole: "admin" },
      { db: new Database(":memory:") },
    );
    const server = buildServer({ routes: app.routes, authenticators: app.authenticators });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    opened.push({ server, app });
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/v1/run-templates`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items?: Array<{ builtIn?: boolean }> };
    expect(body.items).toHaveLength(BUILT_IN_RUN_TEMPLATES.length);
    expect(body.items?.every((item) => item.builtIn === true)).toBe(true);
  });
});
