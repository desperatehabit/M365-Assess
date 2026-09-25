import { describe, expect, it } from "vitest";
import { AppError, ErrorCodes } from "../errors.js";
import { createInMemoryDefenderDeploymentTemplateRepository } from "../repository/defender-deployment-templates.js";
import type { RequestContext, RouteResponse } from "../server.js";
import {
  DEFENDER_TEMPLATE_PATH,
  DEFENDER_TEMPLATE_READ_PERMISSION,
  DEFENDER_TEMPLATE_WRITE_PERMISSION,
  DEFENDER_TEMPLATES_PATH,
  type DefenderTemplateRoute,
  createDefenderTemplateRoutes,
} from "./defender-templates.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const TEMPLATE_A = "aaaaaaaa-0000-0000-0000-000000000000";

interface InvokeOptions {
  query?: Record<string, string>;
  body?: unknown;
}

function context(params: Record<string, string>, options: InvokeOptions = {}): RequestContext {
  return {
    correlationId: "corr-test",
    method: "GET",
    path: "",
    query: new URLSearchParams(options.query),
    headers: {},
    params,
    ...(options.body === undefined ? {} : { body: options.body }),
  } as RequestContext;
}

async function invoke(
  routes: DefenderTemplateRoute[],
  method: string,
  path: string,
  params: Record<string, string>,
  options: InvokeOptions = {},
): Promise<RouteResponse> {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`no route for ${method} ${path}`);
  return await route.handler(context(params, options));
}

async function seeded() {
  const repository = createInMemoryDefenderDeploymentTemplateRepository();
  const routes = createDefenderTemplateRoutes(repository);
  await repository.create({
    id: TEMPLATE_A,
    tenantId: TENANT_A,
    name: "Recommended baseline",
    policyAreas: ["av", "edr"],
    policyJson: { av: { realTimeProtection: true } },
  });
  return { repository, routes };
}

describe("defender template routes", () => {
  it("declares defender.read and defender.write permissions", () => {
    const routes = createDefenderTemplateRoutes(
      createInMemoryDefenderDeploymentTemplateRepository(),
    );

    const byMethod: Record<string, string | undefined> = {};
    for (const route of routes) {
      byMethod[`${route.method} ${route.path}`] = route.permission;
    }

    expect(byMethod[`GET ${DEFENDER_TEMPLATES_PATH}`]).toBe(DEFENDER_TEMPLATE_READ_PERMISSION);
    expect(byMethod[`GET ${DEFENDER_TEMPLATE_PATH}`]).toBe(DEFENDER_TEMPLATE_READ_PERMISSION);
    expect(byMethod[`POST ${DEFENDER_TEMPLATES_PATH}`]).toBe(DEFENDER_TEMPLATE_WRITE_PERMISSION);
    expect(byMethod[`PATCH ${DEFENDER_TEMPLATE_PATH}`]).toBe(DEFENDER_TEMPLATE_WRITE_PERMISSION);
    expect(byMethod[`DELETE ${DEFENDER_TEMPLATE_PATH}`]).toBe(DEFENDER_TEMPLATE_WRITE_PERMISSION);
  });

  it("creates a template scoped to the path tenant", async () => {
    const { repository, routes } = await seeded();

    const response = await invoke(routes, "POST", DEFENDER_TEMPLATES_PATH, { tenantId: TENANT_A }, {
      body: {
        name: "Tighter baseline",
        policyAreas: ["av", "asr"],
        policyJson: { asr: "block" },
      },
    });

    expect(response.status).toBe(201);
    const created = response.body as Record<string, unknown>;
    expect(created).toMatchObject({
      tenantId: TENANT_A,
      name: "Tighter baseline",
      policyAreas: ["av", "asr"],
      policyJson: { asr: "block" },
    });
    expect(created["id"]).toEqual(expect.any(String));
    expect(await repository.list(TENANT_A)).toHaveLength(2);
    expect(await repository.get(TENANT_B, created["id"] as string)).toBeUndefined();
  });

  it("rejects invalid policyAreas and policyJson", async () => {
    const { routes } = await seeded();

    await expect(
      invoke(routes, "POST", DEFENDER_TEMPLATES_PATH, { tenantId: TENANT_A }, {
        body: { name: "x", policyAreas: ["firewall"], policyJson: {} },
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.validationFailed });

    await expect(
      invoke(routes, "POST", DEFENDER_TEMPLATES_PATH, { tenantId: TENANT_A }, {
        body: { name: "x", policyAreas: ["av"], policyJson: ["not", "an", "object"] },
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.validationFailed });
  });

  it("lists and fetches templates scoped by tenant", async () => {
    const { routes } = await seeded();

    const list = await invoke(routes, "GET", DEFENDER_TEMPLATES_PATH, { tenantId: TENANT_A });
    expect(list.status).toBe(200);
    expect((list.body as { items: unknown[] }).items).toHaveLength(1);

    const other = await invoke(routes, "GET", DEFENDER_TEMPLATES_PATH, { tenantId: TENANT_B });
    expect((other.body as { items: unknown[] }).items).toHaveLength(0);

    const one = await invoke(routes, "GET", DEFENDER_TEMPLATE_PATH, {
      tenantId: TENANT_A,
      templateId: TEMPLATE_A,
    });
    expect((one.body as Record<string, unknown>)["id"]).toBe(TEMPLATE_A);

    await expect(
      invoke(routes, "GET", DEFENDER_TEMPLATE_PATH, { tenantId: TENANT_B, templateId: TEMPLATE_A }),
    ).rejects.toMatchObject({ code: ErrorCodes.routeNotFound, status: 404 });
  });

  it("patches and soft-deletes through the routes", async () => {
    const { repository, routes } = await seeded();

    const patched = await invoke(routes, "PATCH", DEFENDER_TEMPLATE_PATH, {
      tenantId: TENANT_A,
      templateId: TEMPLATE_A,
    }, {
      body: { name: "Renamed", policyAreas: ["asr"] },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: "Renamed", policyAreas: ["asr"] });

    const deleted = await invoke(routes, "DELETE", DEFENDER_TEMPLATE_PATH, {
      tenantId: TENANT_A,
      templateId: TEMPLATE_A,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ deleted: true, id: TEMPLATE_A });
    expect(await repository.get(TENANT_A, TEMPLATE_A)).toBeUndefined();

    await expect(
      invoke(routes, "DELETE", DEFENDER_TEMPLATE_PATH, {
        tenantId: TENANT_A,
        templateId: TEMPLATE_A,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("accepts a raw JSON string body", async () => {
    const { routes } = await seeded();

    const response = await invoke(routes, "POST", DEFENDER_TEMPLATES_PATH, { tenantId: TENANT_A }, {
      body: JSON.stringify({ name: "From string", policyAreas: ["edr"], policyJson: {} }),
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ name: "From string", policyAreas: ["edr"] });
  });
});
