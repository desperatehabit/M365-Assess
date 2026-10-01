import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  RESOURCES_CRUD_BASE_PATH,
  RESOURCES_CRUD_ITEM_PATH,
  RESOURCES_WRITE_PERMISSION,
  createResourcesCrudRoutes,
  type CreateResourceInput,
  type EditResourceInput,
  type MembershipInput,
  type ResourceCrudCaller,
  type ResourceCrudProvider,
  type ResourceCrudResult,
  type ResourcePlan,
} from "./resources-crud.js";

const TENANT = "tenant-test";

class FakeResourcesCrudProvider implements ResourcesCrudProvider {
  readonly createCalls: Array<{ tenantId: string; kind: string; input: CreateResourceInput; preview: boolean }> = [];
  readonly editCalls: Array<{ tenantId: string; kind: string; resourceId: string; input: EditResourceInput; preview: boolean }> = [];
  readonly addMemberCalls: Array<{ tenantId: string; kind: string; resourceId: string; input: MembershipInput; preview: boolean }> = [];
  readonly removeMemberCalls: Array<{ tenantId: string; kind: string; resourceId: string; input: MembershipInput; preview: boolean }> = [];
  readonly deleteCalls: Array<{ tenantId: string; kind: string; resourceId: string; preview: boolean }> = [];

  async createResource(tenantId: string, kind: string, input: CreateResourceInput, preview: boolean): Promise<ResourceCrudResult | ResourcePlan> {
    this.createCalls.push({ tenantId, kind, input, preview });
    const plan: ResourcePlan = {
      action: "create",
      targetName: input.displayName,
      diff: [`Create ${kind} resource ${input.displayName}`],
      valid: true,
      dryRun: preview,
      requiresConfirmation: false,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { id: "new-resource-id", displayName: input.displayName },
      auditEvent: {
        id: "audit-1",
        tenantId,
        action: "resources.action:create",
        resourceId: "new-resource-id",
        targetName: input.displayName,
        timestamp: "2026-09-30T10:00:00.000Z",
      },
    };
  }

  async editResource(tenantId: string, kind: string, resourceId: string, input: EditResourceInput, preview: boolean): Promise<ResourceCrudResult | ResourcePlan> {
    this.editCalls.push({ tenantId, kind, resourceId, input, preview });
    const plan: ResourcePlan = {
      action: "edit",
      resourceId,
      targetName: input.displayName ?? "Existing Resource",
      diff: ["Update resource"],
      valid: true,
      dryRun: preview,
      requiresConfirmation: false,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { id: resourceId },
      auditEvent: {
        id: "audit-2",
        tenantId,
        action: "resources.action:edit",
        resourceId,
        targetName: "Existing Resource",
        timestamp: "2026-09-30T10:00:00.000Z",
      },
    };
  }

  async addMember(tenantId: string, kind: string, resourceId: string, input: MembershipInput, preview: boolean): Promise<ResourceCrudResult | ResourcePlan> {
    this.addMemberCalls.push({ tenantId, kind, resourceId, input, preview });
    const plan: ResourcePlan = {
      action: "addMember",
      resourceId,
      targetName: "Building A Rooms",
      diff: [`Add member ${input.memberId} to room list`],
      valid: true,
      dryRun: preview,
      requiresConfirmation: false,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { id: resourceId, memberId: input.memberId },
      auditEvent: {
        id: "audit-3",
        tenantId,
        action: "resources.action:addMember",
        resourceId,
        targetName: "Building A Rooms",
        timestamp: "2026-09-30T10:00:00.000Z",
      },
    };
  }

  async removeMember(tenantId: string, kind: string, resourceId: string, input: MembershipInput, preview: boolean): Promise<ResourceCrudResult | ResourcePlan> {
    this.removeMemberCalls.push({ tenantId, kind, resourceId, input, preview });
    const plan: ResourcePlan = {
      action: "removeMember",
      resourceId,
      targetName: "Building A Rooms",
      diff: [`Remove member ${input.memberId} from room list`],
      valid: true,
      dryRun: preview,
      requiresConfirmation: false,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { id: resourceId, memberId: input.memberId },
      auditEvent: {
        id: "audit-4",
        tenantId,
        action: "resources.action:removeMember",
        resourceId,
        targetName: "Building A Rooms",
        timestamp: "2026-09-30T10:00:00.000Z",
      },
    };
  }

  async deleteResource(tenantId: string, kind: string, resourceId: string, preview: boolean): Promise<ResourceCrudResult | ResourcePlan> {
    this.deleteCalls.push({ tenantId, kind, resourceId, preview });
    const plan: ResourcePlan = {
      action: "delete",
      resourceId,
      targetName: "Existing Resource",
      diff: [`Delete ${kind} ${resourceId}`],
      valid: true,
      dryRun: preview,
      requiresConfirmation: true,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { deleted: true, id: resourceId },
      auditEvent: {
        id: "audit-5",
        tenantId,
        action: "resources.action:delete",
        resourceId,
        targetName: "Existing Resource",
        timestamp: "2026-09-30T10:00:00.000Z",
      },
    };
  }
}

describe("Resources CRUD routes (T-0449)", () => {
  const getRoutes = (provider: FakeResourcesCrudProvider, caller?: ResourceCrudCaller) => {
    return createResourcesCrudRoutes({
      provider,
      resolveCaller: () => caller,
    });
  };

  it("exposes POST /v1/tenants/:tenantId/resources/:kind and PATCH/DELETE /v1/tenants/:tenantId/resources/:kind/:resourceId", () => {
    const routes = createResourcesCrudRoutes({
      provider: new FakeResourcesCrudProvider(),
      resolveCaller: () => undefined,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `POST ${RESOURCES_CRUD_BASE_PATH}`,
      `PATCH ${RESOURCES_CRUD_ITEM_PATH}`,
      `DELETE ${RESOURCES_CRUD_ITEM_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = getRoutes(new FakeResourcesCrudProvider(), undefined);
    const postRoute = routes.find((r) => r.method === "POST")!;

    await expect(
      postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/resources/rooms`,
        params: { tenantId: TENANT, kind: "rooms" },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Focus Room" },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const caller: ResourceCrudCaller = {
      tenantScope: tenantScope(["different-tenant"]),
      permissions: [RESOURCES_WRITE_PERMISSION],
    };
    const routes = getRoutes(new FakeResourcesCrudProvider(), caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    await expect(
      postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/resources/rooms`,
        params: { tenantId: TENANT, kind: "rooms" },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Focus Room" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing resources.write with 403", async () => {
    const caller: ResourceCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: ["resources.read"],
    };
    const routes = getRoutes(new FakeResourcesCrudProvider(), caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    await expect(
      postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/resources/rooms`,
        params: { tenantId: TENANT, kind: "rooms" },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Focus Room" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns plan preview on create when preview requested", async () => {
    const provider = new FakeResourcesCrudProvider();
    const caller: ResourceCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [RESOURCES_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    const response = await postRoute.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/resources/rooms`,
      params: { tenantId: TENANT, kind: "rooms" },
      query: new URLSearchParams("preview=true"),
      headers: {},
      body: { displayName: "Preview Room", capacity: 8 },
    });

    expect(response.status).toBe(200);
    const body = response.body as ResourcePlan;
    expect(body.valid).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.createCalls[0]?.preview).toBe(true);
  });

  it("creates a resource and returns the audit record on apply", async () => {
    const provider = new FakeResourcesCrudProvider();
    const caller: ResourceCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [RESOURCES_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    const response = await postRoute.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/resources/rooms`,
      params: { tenantId: TENANT, kind: "rooms" },
      query: new URLSearchParams(),
      headers: {},
      body: {
        displayName: "Live Room",
        capacity: 12,
        location: "Building A",
        hidden: true,
      },
    });

    expect(response.status).toBe(201);
    const body = response.body as ResourceCrudResult;
    expect(body.success).toBe(true);
    expect(body.auditEvent?.action).toBe("resources.action:create");
    expect(body.auditEvent?.resourceId).toBe("new-resource-id");
    expect(provider.createCalls[0]?.input.capacity).toBe(12);
    expect(provider.createCalls[0]?.input.location).toBe("Building A");
    expect(provider.createCalls[0]?.input.hidden).toBe(true);
  });

  it("rejects create without displayName before dispatch", async () => {
    const provider = new FakeResourcesCrudProvider();
    const caller: ResourceCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [RESOURCES_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    await expect(
      postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/resources/rooms`,
        params: { tenantId: TENANT, kind: "rooms" },
        query: new URLSearchParams(),
        headers: {},
        body: { capacity: 8 },
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(provider.createCalls).toHaveLength(0);
  });

  it("dispatches PATCH action edit to the edit provider", async () => {
    const provider = new FakeResourcesCrudProvider();
    const caller: ResourceCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [RESOURCES_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const patchRoute = routes.find((r) => r.method === "PATCH")!;

    const response = await patchRoute.handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/resources/rooms/room-1`,
      params: { tenantId: TENANT, kind: "rooms", resourceId: "room-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { displayName: "Renamed Room", capacity: 20 },
    });

    expect(response.status).toBe(200);
    const body = response.body as ResourceCrudResult;
    expect(body.auditEvent?.action).toBe("resources.action:edit");
    expect(provider.editCalls).toHaveLength(1);
    expect(provider.editCalls[0]?.input.displayName).toBe("Renamed Room");
    expect(provider.editCalls[0]?.input.capacity).toBe(20);
  });

  it("dispatches PATCH action addMember to the addMember provider", async () => {
    const provider = new FakeResourcesCrudProvider();
    const caller: ResourceCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [RESOURCES_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const patchRoute = routes.find((r) => r.method === "PATCH")!;

    const response = await patchRoute.handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/resources/roomlists/rl-1`,
      params: { tenantId: TENANT, kind: "roomlists", resourceId: "rl-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { action: "addMember", memberId: "room-1" },
    });

    expect(response.status).toBe(200);
    const body = response.body as ResourceCrudResult;
    expect(body.auditEvent?.action).toBe("resources.action:addMember");
    expect(provider.addMemberCalls).toHaveLength(1);
    expect(provider.addMemberCalls[0]?.input.memberId).toBe("room-1");
    expect(provider.removeMemberCalls).toHaveLength(0);
  });

  it("dispatches PATCH action removeMember to the removeMember provider", async () => {
    const provider = new FakeResourcesCrudProvider();
    const caller: ResourceCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [RESOURCES_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const patchRoute = routes.find((r) => r.method === "PATCH")!;

    const response = await patchRoute.handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/resources/roomlists/rl-1`,
      params: { tenantId: TENANT, kind: "roomlists", resourceId: "rl-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { action: "removeMember", memberId: "room-1" },
    });

    expect(response.status).toBe(200);
    const body = response.body as ResourceCrudResult;
    expect(body.auditEvent?.action).toBe("resources.action:removeMember");
    expect(provider.removeMemberCalls).toHaveLength(1);
    expect(provider.removeMemberCalls[0]?.input.memberId).toBe("room-1");
    expect(provider.addMemberCalls).toHaveLength(0);
  });

  it("rejects membership actions without memberId before dispatch", async () => {
    const provider = new FakeResourcesCrudProvider();
    const caller: ResourceCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [RESOURCES_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const patchRoute = routes.find((r) => r.method === "PATCH")!;

    await expect(
      patchRoute.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/resources/roomlists/rl-1`,
        params: { tenantId: TENANT, kind: "roomlists", resourceId: "rl-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { action: "addMember" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(provider.addMemberCalls).toHaveLength(0);
  });

  it("requires the confirm flag for deletion", async () => {
    const provider = new FakeResourcesCrudProvider();
    const caller: ResourceCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [RESOURCES_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const deleteRoute = routes.find((r) => r.method === "DELETE")!;

    await expect(
      deleteRoute.handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/resources/rooms/room-1`,
        params: { tenantId: TENANT, kind: "rooms", resourceId: "room-1" },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      deleteRoute.handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/resources/rooms/room-1`,
        params: { tenantId: TENANT, kind: "rooms", resourceId: "room-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { confirm: false },
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(provider.deleteCalls).toHaveLength(0);
  });

  it("deletes the resource with the confirm flag and returns the audit record", async () => {
    const provider = new FakeResourcesCrudProvider();
    const caller: ResourceCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [RESOURCES_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const deleteRoute = routes.find((r) => r.method === "DELETE")!;

    const response = await deleteRoute.handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/resources/rooms/room-1`,
      params: { tenantId: TENANT, kind: "rooms", resourceId: "room-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { confirm: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as ResourceCrudResult;
    expect(body.success).toBe(true);
    expect(body.auditEvent?.action).toBe("resources.action:delete");
    expect(provider.deleteCalls).toHaveLength(1);
  });
});
