import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ContactTemplate, ContactTemplateInput } from "@m365-assess/db";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST } from "../config.js";
import { ErrorCodes, normalizeError, toErrorBody } from "../errors.js";
import { buildServer, type Route, type RouteResponse } from "../server.js";
import {
  CONTACT_TEMPLATE_NOT_FOUND,
  CONTACT_TEMPLATE_PERMISSIONS,
  CONTACT_TEMPLATES_OPENAPI,
  createContactTemplateRoutes,
  type ContactTemplateRequestContext,
  type ContactTemplateStore,
} from "./contact-templates.js";

const PROPERTIES = { displayName: "Vendor", externalAddress: "vendor@example.invalid" };
const VARIABLES = { region: "eu", tier: "gold" };

class InMemoryContactTemplateStore implements ContactTemplateStore {
  private readonly rows = new Map<string, ContactTemplate>();
  upserts = 0;
  deletes = 0;

  async listContactTemplates(options: { includeDeleted?: boolean } = {}): Promise<ContactTemplate[]> {
    return [...this.rows.values()]
      .filter((row) => options.includeDeleted === true || row.deletedAt === null)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async getContactTemplate(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<ContactTemplate | undefined> {
    const row = this.rows.get(id);
    if (!row) return undefined;
    if (options.includeDeleted !== true && row.deletedAt !== null) return undefined;
    return row;
  }

  async upsertContactTemplate(input: ContactTemplateInput): Promise<ContactTemplate> {
    this.upserts += 1;
    const existing = this.rows.get(input.id);
    const row: ContactTemplate = {
      id: input.id,
      name: input.name,
      properties: input.properties ?? {},
      variables: input.variables ?? {},
      createdAt: input.createdAt ?? existing?.createdAt ?? "2026-01-01T00:00:00.000Z",
      updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
      deletedAt: input.deletedAt ?? null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async softDeleteContactTemplate(id: string, options: { now?: string } = {}): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.deletedAt !== null) return false;
    this.deletes += 1;
    row.deletedAt = options.now ?? "2026-06-01T00:00:00.000Z";
    return true;
  }
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(routes: readonly Route[]): Promise<string> {
  const server = buildServer({ routes });
  await new Promise<void>((resolve) => server.listen(0, DEFAULT_HOST, resolve));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://${DEFAULT_HOST}:${port}`;
}

function context(
  overrides: Partial<ContactTemplateRequestContext> = {},
): ContactTemplateRequestContext {
  return {
    correlationId: "corr-test",
    method: "POST",
    path: "/v1/contact-templates",
    query: new URLSearchParams(),
    headers: {},
    params: {},
    ...overrides,
  };
}

function handlerFor(routes: readonly Route[], method: string, path: string): Route {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`no ${method} ${path} route`);
  return route;
}

/**
 * Runs a handler the way the server does: mapping a thrown AppError to the
 * structured error response `handleRequest` would have produced.
 */
async function invoke(route: Route, ctx: ContactTemplateRequestContext): Promise<RouteResponse> {
  try {
    return await route.handler(ctx);
  } catch (error) {
    const appError = normalizeError(error);
    return { status: appError.status, body: toErrorBody(appError, ctx.correlationId) };
  }
}

describe("contact-template routes", () => {
  it("declares GET/POST /v1/contact-templates and GET/PATCH/DELETE /v1/contact-templates/:id", () => {
    const routes = createContactTemplateRoutes({ store: new InMemoryContactTemplateStore() });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /v1/contact-templates",
      "POST /v1/contact-templates",
      "GET /v1/contact-templates/:id",
      "PATCH /v1/contact-templates/:id",
      "DELETE /v1/contact-templates/:id",
    ]);
  });

  it("creates, reads, updates, and soft-deletes a template through the routes", async () => {
    const store = new InMemoryContactTemplateStore();
    const routes = createContactTemplateRoutes({ store });
    const baseUrl = await startServer(routes);

    const created = await invoke(
      handlerFor(routes, "POST", "/v1/contact-templates"),
      context({ body: { id: "tpl-1", name: "Vendor", properties: PROPERTIES, variables: VARIABLES } }),
    );
    expect(created.status).toBe(201);
    const createdBody = created.body as Record<string, unknown>;
    expect(createdBody["id"]).toBe("tpl-1");
    expect(createdBody["properties"]).toEqual(PROPERTIES);
    expect(createdBody["variables"]).toEqual(VARIABLES);

    const listResponse = await fetch(`${baseUrl}/v1/contact-templates`);
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as { items: Array<Record<string, unknown>> };
    expect(listBody.items).toHaveLength(1);

    const detail = (await (await fetch(`${baseUrl}/v1/contact-templates/tpl-1`)).json()) as Record<
      string,
      unknown
    >;
    expect(detail["name"]).toBe("Vendor");
    expect(detail["properties"]).toEqual(PROPERTIES);

    const edited = await invoke(
      handlerFor(routes, "PATCH", "/v1/contact-templates/:id"),
      context({
        method: "PATCH",
        path: "/v1/contact-templates/tpl-1",
        params: { id: "tpl-1" },
        body: { name: "Vendor v2", variables: { region: "us" } },
      }),
    );
    expect(edited.status).toBe(200);
    const editedBody = edited.body as Record<string, unknown>;
    expect(editedBody["name"]).toBe("Vendor v2");
    expect(editedBody["variables"]).toEqual({ region: "us" });
    // An update that omits `properties` keeps the stored map.
    expect(editedBody["properties"]).toEqual(PROPERTIES);

    const deleted = await fetch(`${baseUrl}/v1/contact-templates/tpl-1`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await fetch(`${baseUrl}/v1/contact-templates/tpl-1`)).status).toBe(404);
    const afterDelete = (await (await fetch(`${baseUrl}/v1/contact-templates`)).json()) as {
      items: unknown[];
    };
    expect(afterDelete.items).toHaveLength(0);
    expect(store.deletes).toBe(1);
  });

  it("round-trips properties and variables unchanged", async () => {
    const store = new InMemoryContactTemplateStore();
    const routes = createContactTemplateRoutes({ store });
    const baseUrl = await startServer(routes);
    const properties = { displayName: "Vendor", hiddenFromGal: true, nested: { a: [1, 2] } };
    const variables = { region: "eu", address: "vendor@example.invalid" };

    await invoke(
      handlerFor(routes, "POST", "/v1/contact-templates"),
      context({ body: { id: "rt-1", name: "Round trip", properties, variables } }),
    );

    const detail = (await (await fetch(`${baseUrl}/v1/contact-templates/rt-1`)).json()) as Record<
      string,
      unknown
    >;
    expect(detail["properties"]).toEqual(properties);
    expect(detail["variables"]).toEqual(variables);
  });

  it("rejects invalid template shapes with a structured error and never persists them", async () => {
    const store = new InMemoryContactTemplateStore();
    const routes = createContactTemplateRoutes({ store });
    const post = handlerFor(routes, "POST", "/v1/contact-templates");

    const noName = await invoke(
      post,
      context({ body: { name: "", properties: PROPERTIES } }),
    );
    expect(noName.status).toBe(400);
    expect((noName.body as Record<string, unknown>)["code"]).toBe("contact_template.invalid");
    expect(
      ((noName.body as { details: Array<{ field: string }> }).details ?? []).some(
        (detail) => detail.field === "name",
      ),
    ).toBe(true);

    const badProperties = await invoke(
      post,
      context({ body: { name: "Bad", properties: [] } }),
    );
    expect(badProperties.status).toBe(400);

    const missingProperties = await invoke(post, context({ body: { name: "Bad" } }));
    expect(missingProperties.status).toBe(400);

    const badVariables = await invoke(
      post,
      context({ body: { name: "Bad", properties: PROPERTIES, variables: "nope" } }),
    );
    expect(badVariables.status).toBe(400);
    expect(
      ((badVariables.body as { details: Array<{ field: string }> }).details ?? []).some(
        (detail) => detail.field === "variables",
      ),
    ).toBe(true);

    const badBody = await invoke(post, context({ body: "not-an-object" }));
    expect(badBody.status).toBe(400);
    expect((badBody.body as Record<string, unknown>)["code"]).toBe(ErrorCodes.validationFailed);

    expect(store.upserts).toBe(0);
    expect(await store.listContactTemplates()).toHaveLength(0);
  });

  it("rejects an invalid update before it reaches the repository", async () => {
    const store = new InMemoryContactTemplateStore();
    await store.upsertContactTemplate({
      id: "tpl-2",
      name: "Existing",
      properties: PROPERTIES,
    });
    const routes = createContactTemplateRoutes({ store });
    const patch = handlerFor(routes, "PATCH", "/v1/contact-templates/:id");

    const response = await invoke(
      patch,
      context({
        method: "PATCH",
        path: "/v1/contact-templates/tpl-2",
        params: { id: "tpl-2" },
        body: { variables: [] },
      }),
    );
    expect(response.status).toBe(400);
    expect(store.upserts).toBe(1);
    expect((await store.getContactTemplate("tpl-2"))?.name).toBe("Existing");
  });

  it("returns 404 for a missing template and after a soft delete", async () => {
    const store = new InMemoryContactTemplateStore();
    const routes = createContactTemplateRoutes({ store });
    const baseUrl = await startServer(routes);

    const missing = await fetch(`${baseUrl}/v1/contact-templates/nope`);
    expect(missing.status).toBe(404);
    expect((await missing.json()) as Record<string, unknown>).toMatchObject({
      code: CONTACT_TEMPLATE_NOT_FOUND,
    });

    const missingPatch = await invoke(
      handlerFor(routes, "PATCH", "/v1/contact-templates/:id"),
      context({
        method: "PATCH",
        path: "/v1/contact-templates/nope",
        params: { id: "nope" },
        body: { name: "Nope" },
      }),
    );
    expect(missingPatch.status).toBe(404);

    const missingDelete = await fetch(`${baseUrl}/v1/contact-templates/nope`, { method: "DELETE" });
    expect(missingDelete.status).toBe(404);
  });

  it("gates writes behind contacts.write and reads behind contacts.read", async () => {
    const store = new InMemoryContactTemplateStore();
    const routes = createContactTemplateRoutes({
      store,
      authorize: (_ctx, permission) => permission === CONTACT_TEMPLATE_PERMISSIONS.read,
    });

    const denied = await invoke(
      handlerFor(routes, "POST", "/v1/contact-templates"),
      context({ body: { name: "Denied", properties: PROPERTIES } }),
    );
    expect(denied.status).toBe(403);
    expect((denied.body as Record<string, unknown>)["code"]).toBe(ErrorCodes.forbidden);
    expect(store.upserts).toBe(0);

    const list = await fetch(`${await startServer(routes)}/v1/contact-templates`);
    expect(list.status).toBe(200);
  });

  it("default authorizer accepts contacts.write or an admin wildcard", async () => {
    const store = new InMemoryContactTemplateStore();
    const routes = createContactTemplateRoutes({ store });
    const post = handlerFor(routes, "POST", "/v1/contact-templates");

    const withWrite = await invoke(
      post,
      context({
        body: { id: "tpl-3", name: "Write", properties: PROPERTIES },
        permissions: [CONTACT_TEMPLATE_PERMISSIONS.write],
      }),
    );
    expect(withWrite.status).toBe(201);

    const withWildcard = await invoke(
      post,
      context({
        body: { id: "tpl-4", name: "Wildcard", properties: PROPERTIES },
        permissions: ["*"],
      }),
    );
    expect(withWildcard.status).toBe(201);

    const readOnly = await invoke(
      post,
      context({
        body: { id: "tpl-5", name: "Read only", properties: PROPERTIES },
        permissions: [CONTACT_TEMPLATE_PERMISSIONS.read],
      }),
    );
    expect(readOnly.status).toBe(403);
  });

  it("publishes the OpenAPI fragment for all four endpoints", () => {
    expect(Object.keys(CONTACT_TEMPLATES_OPENAPI.paths).sort()).toEqual([
      "/contact-templates",
      "/contact-templates/{id}",
    ]);
    expect(CONTACT_TEMPLATES_OPENAPI.paths["/contact-templates"].post.permission).toBe(
      CONTACT_TEMPLATE_PERMISSIONS.write,
    );
    expect(CONTACT_TEMPLATES_OPENAPI.paths["/contact-templates/{id}"].delete.operationId).toBe(
      "deleteContactTemplate",
    );
  });
});
