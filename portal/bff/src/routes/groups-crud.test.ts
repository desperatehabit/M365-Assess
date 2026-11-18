import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  GROUPS_BASE_PATH,
  GROUPS_CONVERT_PATH,
  GROUPS_CRUD_OPENAPI,
  GROUPS_ITEM_PATH,
  GROUPS_WRITE_PERMISSION,
  createGroupCrudRoutes,
  validateDynamicRule,
  type ConvertGroupInput,
  type CreateGroupInput,
  type DeleteGroupInput,
  type EditGroupInput,
  type GroupCrudCaller,
  type GroupCrudProvider,
  type GroupCrudResult,
  type GroupPlan,
} from "./groups-crud.js";

const TENANT = "tenant-test";

class FakeGroupCrudProvider implements GroupCrudProvider {
  readonly createCalls: Array<{ tenantId: string; input: CreateGroupInput; preview: boolean }> = [];
  readonly editCalls: Array<{ tenantId: string; groupId: string; input: EditGroupInput; preview: boolean }> = [];
  readonly deleteCalls: Array<{ tenantId: string; groupId: string; confirmName: string; preview: boolean }> = [];
  readonly convertCalls: Array<{ tenantId: string; groupId: string; input: ConvertGroupInput; preview: boolean }> = [];

  async createGroup(tenantId: string, input: CreateGroupInput, preview: boolean): Promise<GroupCrudResult | GroupPlan> {
    this.createCalls.push({ tenantId, input, preview });
    const plan: GroupPlan = {
      action: "create",
      targetName: input.displayName,
      diff: [`Create group ${input.displayName}`],
      valid: true,
      dryRun: preview,
      requiresConfirmation: false,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { id: "new-grp-id", displayName: input.displayName },
      auditEvent: {
        id: "audit-1",
        tenantId,
        action: "group.create",
        targetId: "new-grp-id",
        targetName: input.displayName,
        timestamp: "2026-09-26T18:00:00Z",
      },
    };
  }

  async editGroup(tenantId: string, groupId: string, input: EditGroupInput, preview: boolean): Promise<GroupCrudResult | GroupPlan> {
    this.editCalls.push({ tenantId, groupId, input, preview });
    const plan: GroupPlan = {
      action: "edit",
      groupId,
      targetName: input.displayName ?? "Existing Group",
      diff: ["Update description"],
      valid: true,
      dryRun: preview,
      requiresConfirmation: false,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { id: groupId },
      auditEvent: {
        id: "audit-2",
        tenantId,
        action: "group.edit",
        targetId: groupId,
        targetName: "Existing Group",
        timestamp: "2026-09-26T18:00:00Z",
      },
    };
  }

  async deleteGroup(tenantId: string, groupId: string, confirmName: string, preview: boolean): Promise<GroupCrudResult | GroupPlan> {
    this.deleteCalls.push({ tenantId, groupId, confirmName, preview });
    const plan: GroupPlan = {
      action: "delete",
      groupId,
      targetName: confirmName,
      diff: [`Delete group ${confirmName}`],
      valid: true,
      dryRun: preview,
      requiresConfirmation: true,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { deleted: true, id: groupId },
      auditEvent: {
        id: "audit-3",
        tenantId,
        action: "group.delete",
        targetId: groupId,
        targetName: confirmName,
        timestamp: "2026-09-26T18:00:00Z",
      },
    };
  }

  async convertGroup(
    tenantId: string,
    groupId: string,
    input: ConvertGroupInput,
    preview: boolean,
  ): Promise<GroupCrudResult | GroupPlan> {
    this.convertCalls.push({ tenantId, groupId, input, preview });
    const plan: GroupPlan = {
      action: "convert",
      groupId,
      targetName: "Target Group",
      diff: [`Convert group to ${input.targetType}`],
      valid: true,
      dryRun: preview,
      requiresConfirmation: false,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { id: groupId, groupType: input.targetType },
      auditEvent: {
        id: "audit-4",
        tenantId,
        action: "group.convert",
        targetId: groupId,
        targetName: "Target Group",
        timestamp: "2026-09-26T18:00:00Z",
      },
    };
  }
}

describe("Group CRUD routes (T-0262)", () => {
  const getRoutes = (provider: FakeGroupCrudProvider, caller?: GroupCrudCaller) => {
    return createGroupCrudRoutes({
      provider,
      resolveCaller: () => caller,
    });
  };

  it("validates dynamic rules accurately", () => {
    expect(validateDynamicRule('(user.department -eq "Sales")').valid).toBe(true);
    expect(validateDynamicRule('(user.city -startsWith "New")').valid).toBe(true);
    expect(validateDynamicRule("").valid).toBe(false);
    expect(validateDynamicRule("not-parenthesized").valid).toBe(false);
    expect(validateDynamicRule('(user.department is "Sales")').valid).toBe(false);
    expect(validateDynamicRule('(user.department -eq "Sales"').valid).toBe(false);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeGroupCrudProvider();
    const routes = getRoutes(provider, undefined);
    const postRoute = routes.find((r) => r.method === "POST" && r.path === GROUPS_BASE_PATH)!;

    await expect(
      postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/groups`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Test", groupType: "security" },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects callers missing groups.write with 403", async () => {
    const provider = new FakeGroupCrudProvider();
    const caller: GroupCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: ["Identity.Group.Read"],
    };
    const routes = getRoutes(provider, caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    await expect(
      postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/groups`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Test", groupType: "security" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns plan preview on create when preview requested", async () => {
    const provider = new FakeGroupCrudProvider();
    const caller: GroupCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [GROUPS_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    const response = await postRoute.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/groups`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("preview=true"),
      headers: {},
      body: { displayName: "Preview Sec Group", groupType: "security" },
    });

    expect(response.status).toBe(200);
    const body = response.body as GroupPlan;
    expect(body.valid).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.createCalls[0]?.preview).toBe(true);
  });

  it("creates group and returns audit record on apply", async () => {
    const provider = new FakeGroupCrudProvider();
    const caller: GroupCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [GROUPS_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    const response = await postRoute.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/groups`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { displayName: "Live Sec Group", groupType: "security" },
    });

    expect(response.status).toBe(201);
    const body = response.body as GroupCrudResult;
    expect(body.success).toBe(true);
    expect(body.auditEvent?.action).toBe("group.create");
    expect(body.auditEvent?.targetId).toBe("new-grp-id");
  });

  it("rejects dynamic group creation with invalid rule before dispatch", async () => {
    const provider = new FakeGroupCrudProvider();
    const caller: GroupCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [GROUPS_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    await expect(
      postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/groups`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: {
          displayName: "Bad Dynamic Group",
          groupType: "dynamic",
          dynamicRule: "user.department eq Sales",
        },
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(provider.createCalls).toHaveLength(0);
  });

  it("requires confirmName for group deletion", async () => {
    const provider = new FakeGroupCrudProvider();
    const caller: GroupCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [GROUPS_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const deleteRoute = routes.find((r) => r.method === "DELETE")!;

    await expect(
      deleteRoute.handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/groups/grp-to-delete`,
        params: { tenantId: TENANT, groupId: "grp-to-delete" },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400 });

    // Succeeds when confirmName is provided
    const response = await deleteRoute.handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/groups/grp-to-delete`,
      params: { tenantId: TENANT, groupId: "grp-to-delete" },
      query: new URLSearchParams(),
      headers: {},
      body: { confirmName: "Confirmed Group" },
    });

    expect(response.status).toBe(200);
    const body = response.body as GroupCrudResult;
    expect(body.success).toBe(true);
    expect(body.auditEvent?.action).toBe("group.delete");
    expect(provider.deleteCalls).toHaveLength(1);
  });

  describe("PATCH /groups/:groupId (T-0883 Edit row action)", () => {
    const writer: GroupCrudCaller = { tenantScope: tenantScope([TENANT]), permissions: [GROUPS_WRITE_PERMISSION] };
    const patch = (provider: FakeGroupCrudProvider, caller: GroupCrudCaller | undefined, body: unknown, query = "") => {
      const route = getRoutes(provider, caller).find((r) => r.method === "PATCH")!;
      return route.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/groups/grp-1`,
        params: { tenantId: TENANT, groupId: "grp-1" },
        query: new URLSearchParams(query),
        headers: {},
        body,
      });
    };

    it("previews an edit without applying it", async () => {
      const provider = new FakeGroupCrudProvider();
      const response = await patch(provider, writer, { displayName: " Renamed ", description: "New", preview: true });
      expect(response.status).toBe(200);
      expect((response.body as GroupPlan).dryRun).toBe(true);
      expect(provider.editCalls).toEqual([
        {
          tenantId: TENANT,
          groupId: "grp-1",
          input: { displayName: "Renamed", description: "New", dynamicRule: undefined, preview: true },
          preview: true,
        },
      ]);
    });

    it("applies an edit and returns the audit event", async () => {
      const provider = new FakeGroupCrudProvider();
      const response = await patch(provider, writer, { displayName: "Renamed" });
      expect(response.status).toBe(200);
      const body = response.body as GroupCrudResult;
      expect(body.success).toBe(true);
      expect(body.auditEvent?.action).toBe("group.edit");
      expect(provider.editCalls[0]).toMatchObject({ groupId: "grp-1", preview: false });
    });

    it("rejects an invalid dynamic rule before dispatch", async () => {
      const provider = new FakeGroupCrudProvider();
      await expect(patch(provider, writer, { dynamicRule: "no parentheses -eq x" })).rejects.toMatchObject({ status: 400 });
      expect(provider.editCalls).toHaveLength(0);
    });

    it("rejects an unauthenticated caller, a caller without write, and a tenant out of scope", async () => {
      const provider = new FakeGroupCrudProvider();
      await expect(patch(provider, undefined, {})).rejects.toMatchObject({ status: 401 });
      await expect(
        patch(provider, { tenantScope: tenantScope([TENANT]), permissions: [] }, {}),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        patch(provider, { tenantScope: tenantScope(["other"]), permissions: [GROUPS_WRITE_PERMISSION] }, {}),
      ).rejects.toMatchObject({ status: 403 });
      expect(provider.editCalls).toHaveLength(0);
    });
  });

  it("previews a delete without a confirmName and sends the preview flag to the provider", async () => {
    const provider = new FakeGroupCrudProvider();
    const caller: GroupCrudCaller = { tenantScope: tenantScope([TENANT]), permissions: [GROUPS_WRITE_PERMISSION] };
    const deleteRoute = getRoutes(provider, caller).find((r) => r.method === "DELETE")!;
    const response = await deleteRoute.handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/groups/grp-1`,
      params: { tenantId: TENANT, groupId: "grp-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { confirmName: "Finance Team", preview: true },
    });
    expect(response.status).toBe(200);
    expect((response.body as GroupPlan).dryRun).toBe(true);
    expect(provider.deleteCalls).toEqual([
      { tenantId: TENANT, groupId: "grp-1", confirmName: "Finance Team", preview: true },
    ]);
  });

  describe("create GAL & delivery options and empty description edit (T-0900)", () => {
    const writer: GroupCrudCaller = { tenantScope: tenantScope([TENANT]), permissions: [GROUPS_WRITE_PERMISSION] };

    it("forwards GAL and delivery options on group create and rejects invalid types", async () => {
      const provider = new FakeGroupCrudProvider();
      const postRoute = getRoutes(provider, writer).find((r) => r.method === "POST" && r.path === GROUPS_BASE_PATH)!;

      const res = await postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/groups`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: {
          displayName: "Mail Group",
          groupType: "m365",
          hiddenFromAddressListsEnabled: true,
          requireSenderAuthenticationEnabled: true,
          grantSendOnBehalfTo: ["delegate@example.invalid"],
        },
      });
      expect(res.status).toBe(201);
      expect(provider.createCalls[0]?.input).toMatchObject({
        displayName: "Mail Group",
        groupType: "m365",
        hiddenFromAddressListsEnabled: true,
        requireSenderAuthenticationEnabled: true,
        grantSendOnBehalfTo: ["delegate@example.invalid"],
      });

      await expect(
        postRoute.handler({
          method: "POST",
          path: `/v1/tenants/${TENANT}/groups`,
          params: { tenantId: TENANT },
          query: new URLSearchParams(),
          headers: {},
          body: {
            displayName: "Bad Flag",
            groupType: "m365",
            hiddenFromAddressListsEnabled: "yes",
          },
        }),
      ).rejects.toMatchObject({ status: 400 });

      await expect(
        postRoute.handler({
          method: "POST",
          path: `/v1/tenants/${TENANT}/groups`,
          params: { tenantId: TENANT },
          query: new URLSearchParams(),
          headers: {},
          body: {
            displayName: "Bad Grants",
            groupType: "m365",
            grantSendOnBehalfTo: ["valid@example.invalid", "  "],
          },
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("preserves empty string description on PATCH so descriptions can be cleared", async () => {
      const provider = new FakeGroupCrudProvider();
      const patchRoute = getRoutes(provider, writer).find((r) => r.method === "PATCH")!;
      await patchRoute.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/groups/grp-1`,
        params: { tenantId: TENANT, groupId: "grp-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { description: "" },
      });
      expect(provider.editCalls[0]?.input.description).toBe("");

      await patchRoute.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/groups/grp-1`,
        params: { tenantId: TENANT, groupId: "grp-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Unchanged Desc" },
      });
      expect(provider.editCalls[1]?.input.description).toBeUndefined();
    });
  });

  describe("POST /groups/:groupId/convert (T-0900)", () => {
    const writer: GroupCrudCaller = { tenantScope: tenantScope([TENANT]), permissions: [GROUPS_WRITE_PERMISSION] };
    const convert = (provider: FakeGroupCrudProvider, caller: GroupCrudCaller | undefined, body: unknown, query = "") => {
      const route = getRoutes(provider, caller).find((r) => r.method === "POST" && r.path === GROUPS_CONVERT_PATH)!;
      return route.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/groups/grp-1/convert`,
        params: { tenantId: TENANT, groupId: "grp-1" },
        query: new URLSearchParams(query),
        headers: {},
        body,
      });
    };

    it("declares the convert path with GROUPS_WRITE_PERMISSION in GROUPS_CRUD_OPENAPI", () => {
      const convertOp = GROUPS_CRUD_OPENAPI.paths["/tenants/{tenantId}/groups/{groupId}/convert"]?.post;
      expect(convertOp).toBeDefined();
      expect(convertOp?.permission).toBe(GROUPS_WRITE_PERMISSION);
    });

    it("enforces authentication, tenant scope, and write permission", async () => {
      const provider = new FakeGroupCrudProvider();
      await expect(convert(provider, undefined, { targetType: "m365" })).rejects.toMatchObject({ status: 401 });
      await expect(
        convert(provider, { tenantScope: tenantScope([TENANT]), permissions: ["Identity.Group.Read"] }, { targetType: "m365" }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        convert(provider, { tenantScope: tenantScope(["other"]), permissions: [GROUPS_WRITE_PERMISSION] }, { targetType: "m365" }),
      ).rejects.toMatchObject({ status: 403 });
      expect(provider.convertCalls).toHaveLength(0);
    });

    it("validates targetType/groupType and dynamicRule before dispatching", async () => {
      const provider = new FakeGroupCrudProvider();
      await expect(convert(provider, writer, {})).rejects.toMatchObject({ status: 400 });
      await expect(convert(provider, writer, { targetType: "unknownType" })).rejects.toMatchObject({ status: 400 });
      await expect(
        convert(provider, writer, { targetType: "dynamic", dynamicRule: "invalid rule" }),
      ).rejects.toMatchObject({ status: 400 });
      expect(provider.convertCalls).toHaveLength(0);
    });

    it("previews conversion with preview=true or dryRun=true without applying", async () => {
      const provider = new FakeGroupCrudProvider();
      const res = await convert(provider, writer, { targetType: "m365", preview: true });
      expect(res.status).toBe(200);
      expect((res.body as GroupPlan).action).toBe("convert");
      expect((res.body as GroupPlan).dryRun).toBe(true);

      const resDry = await convert(provider, writer, { groupType: "security", dryRun: true });
      expect(resDry.status).toBe(200);
      expect((resDry.body as GroupPlan).dryRun).toBe(true);
      expect(provider.convertCalls[1]?.input.targetType).toBe("security");
    });

    it("applies conversion and returns audit event", async () => {
      const provider = new FakeGroupCrudProvider();
      const res = await convert(provider, writer, {
        targetType: "dynamic",
        dynamicRule: '(user.department -eq "Finance")',
      });
      expect(res.status).toBe(200);
      const body = res.body as GroupCrudResult;
      expect(body.success).toBe(true);
      expect(body.auditEvent?.action).toBe("group.convert");
      expect(provider.convertCalls[0]).toMatchObject({
        tenantId: TENANT,
        groupId: "grp-1",
        preview: false,
        input: {
          targetType: "dynamic",
          groupType: "dynamic",
          dynamicRule: '(user.department -eq "Finance")',
        },
      });
    });
  });
});
