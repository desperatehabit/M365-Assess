import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  CONTACTS_CRUD_BASE_PATH,
  CONTACTS_CRUD_ITEM_PATH,
  CONTACTS_WRITE_PERMISSION,
  createContactsCrudRoutes,
  type ContactCrudCaller,
  type ContactCrudProvider,
  type ContactCrudResult,
  type ContactPlan,
  type CreateContactInput,
  type EditContactInput,
} from "./contacts-crud.js";

const TENANT = "tenant-test";

class FakeContactsCrudProvider implements ContactsCrudProvider {
  readonly createCalls: Array<{ tenantId: string; input: CreateContactInput; preview: boolean }> = [];
  readonly editCalls: Array<{ tenantId: string; contactId: string; input: EditContactInput; preview: boolean }> = [];
  readonly hideCalls: Array<{ tenantId: string; contactId: string; preview: boolean }> = [];
  readonly deleteCalls: Array<{ tenantId: string; contactId: string; preview: boolean }> = [];

  async createContact(tenantId: string, input: CreateContactInput, preview: boolean): Promise<ContactCrudResult | ContactPlan> {
    this.createCalls.push({ tenantId, input, preview });
    const plan: ContactPlan = {
      action: "create",
      targetName: input.displayName,
      diff: [`Create ${input.type ?? "mailContact"} contact ${input.displayName}`],
      valid: true,
      dryRun: preview,
      requiresConfirmation: false,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { id: "new-contact-id", displayName: input.displayName },
      auditEvent: {
        id: "audit-1",
        tenantId,
        action: "contacts.action:create",
        contactId: "new-contact-id",
        targetName: input.displayName,
        timestamp: "2026-09-30T10:00:00.000Z",
      },
    };
  }

  async editContact(tenantId: string, contactId: string, input: EditContactInput, preview: boolean): Promise<ContactCrudResult | ContactPlan> {
    this.editCalls.push({ tenantId, contactId, input, preview });
    const plan: ContactPlan = {
      action: "edit",
      contactId,
      targetName: input.displayName ?? "Existing Contact",
      diff: ["Update contact"],
      valid: true,
      dryRun: preview,
      requiresConfirmation: false,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { id: contactId },
      auditEvent: {
        id: "audit-2",
        tenantId,
        action: "contacts.action:edit",
        contactId,
        targetName: "Existing Contact",
        timestamp: "2026-09-30T10:00:00.000Z",
      },
    };
  }

  async hideFromGal(tenantId: string, contactId: string, preview: boolean): Promise<ContactCrudResult | ContactPlan> {
    this.hideCalls.push({ tenantId, contactId, preview });
    const plan: ContactPlan = {
      action: "hideFromGal",
      contactId,
      targetName: "Existing Contact",
      diff: ["Hide contact from the GAL"],
      valid: true,
      dryRun: preview,
      requiresConfirmation: false,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { id: contactId, hiddenFromGal: true },
      auditEvent: {
        id: "audit-3",
        tenantId,
        action: "contacts.action:hideFromGal",
        contactId,
        targetName: "Existing Contact",
        timestamp: "2026-09-30T10:00:00.000Z",
      },
    };
  }

  async deleteContact(tenantId: string, contactId: string, preview: boolean): Promise<ContactCrudResult | ContactPlan> {
    this.deleteCalls.push({ tenantId, contactId, preview });
    const plan: ContactPlan = {
      action: "delete",
      contactId,
      targetName: "Existing Contact",
      diff: [`Delete contact ${contactId}`],
      valid: true,
      dryRun: preview,
      requiresConfirmation: true,
    };
    if (preview) return plan;
    return {
      success: true,
      plan,
      result: { deleted: true, id: contactId },
      auditEvent: {
        id: "audit-4",
        tenantId,
        action: "contacts.action:delete",
        contactId,
        targetName: "Existing Contact",
        timestamp: "2026-09-30T10:00:00.000Z",
      },
    };
  }
}

describe("Contacts CRUD routes (T-0443)", () => {
  const getRoutes = (provider: FakeContactsCrudProvider, caller?: ContactCrudCaller) => {
    return createContactsCrudRoutes({
      provider,
      resolveCaller: () => caller,
    });
  };

  it("exposes POST /v1/tenants/:tenantId/contacts and PATCH/DELETE /v1/tenants/:tenantId/contacts/:contactId", () => {
    const routes = createContactsCrudRoutes({
      provider: new FakeContactsCrudProvider(),
      resolveCaller: () => undefined,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `POST ${CONTACTS_CRUD_BASE_PATH}`,
      `PATCH ${CONTACTS_CRUD_ITEM_PATH}`,
      `DELETE ${CONTACTS_CRUD_ITEM_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = getRoutes(new FakeContactsCrudProvider(), undefined);
    const postRoute = routes.find((r) => r.method === "POST")!;

    await expect(
      postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/contacts`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Vendor", externalAddress: "vendor@example.com" },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const caller: ContactsCrudCaller = {
      tenantScope: tenantScope(["different-tenant"]),
      permissions: [CONTACTS_WRITE_PERMISSION],
    };
    const routes = getRoutes(new FakeContactsCrudProvider(), caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    await expect(
      postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/contacts`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Vendor", externalAddress: "vendor@example.com" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Exchange.Contact.ReadWrite with 403", async () => {
    const caller: ContactsCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: ["Exchange.Contact.Read"],
    };
    const routes = getRoutes(new FakeContactsCrudProvider(), caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    await expect(
      postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/contacts`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Vendor", externalAddress: "vendor@example.com" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns plan preview on create when preview requested", async () => {
    const provider = new FakeContactsCrudProvider();
    const caller: ContactsCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [CONTACTS_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    const response = await postRoute.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/contacts`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("preview=true"),
      headers: {},
      body: { displayName: "Preview Vendor", externalAddress: "vendor@example.com" },
    });

    expect(response.status).toBe(200);
    const body = response.body as ContactPlan;
    expect(body.valid).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.createCalls[0]?.preview).toBe(true);
  });

  it("creates a contact and returns the audit record on apply", async () => {
    const provider = new FakeContactsCrudProvider();
    const caller: ContactsCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [CONTACTS_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    const response = await postRoute.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/contacts`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: {
        displayName: "Live Vendor",
        externalAddress: "vendor@example.com",
        type: "mailContact",
        hiddenFromGal: true,
      },
    });

    expect(response.status).toBe(201);
    const body = response.body as ContactCrudResult;
    expect(body.success).toBe(true);
    expect(body.auditEvent?.action).toBe("contacts.action:create");
    expect(body.auditEvent?.contactId).toBe("new-contact-id");
    expect(provider.createCalls[0]?.input.hiddenFromGal).toBe(true);
  });

  it("rejects create without displayName or externalAddress before dispatch", async () => {
    const provider = new FakeContactsCrudProvider();
    const caller: ContactsCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [CONTACTS_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const postRoute = routes.find((r) => r.method === "POST")!;

    await expect(
      postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/contacts`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { externalAddress: "vendor@example.com" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      postRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/contacts`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Vendor" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(provider.createCalls).toHaveLength(0);
  });

  it("dispatches PATCH action hideFromGal to the hide provider", async () => {
    const provider = new FakeContactsCrudProvider();
    const caller: ContactsCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [CONTACTS_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const patchRoute = routes.find((r) => r.method === "PATCH")!;

    const response = await patchRoute.handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/contacts/contact-1`,
      params: { tenantId: TENANT, contactId: "contact-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { action: "hideFromGal" },
    });

    expect(response.status).toBe(200);
    const body = response.body as ContactCrudResult;
    expect(body.auditEvent?.action).toBe("contacts.action:hideFromGal");
    expect(provider.hideCalls).toHaveLength(1);
    expect(provider.editCalls).toHaveLength(0);
  });

  it("dispatches PATCH action edit to the edit provider", async () => {
    const provider = new FakeContactsCrudProvider();
    const caller: ContactsCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [CONTACTS_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const patchRoute = routes.find((r) => r.method === "PATCH")!;

    const response = await patchRoute.handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/contacts/contact-1`,
      params: { tenantId: TENANT, contactId: "contact-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { displayName: "Renamed Vendor" },
    });

    expect(response.status).toBe(200);
    const body = response.body as ContactCrudResult;
    expect(body.auditEvent?.action).toBe("contacts.action:edit");
    expect(provider.editCalls).toHaveLength(1);
    expect(provider.editCalls[0]?.input.displayName).toBe("Renamed Vendor");
    expect(provider.hideCalls).toHaveLength(0);
  });

  it("requires the confirm flag for deletion", async () => {
    const provider = new FakeContactsCrudProvider();
    const caller: ContactsCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [CONTACTS_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const deleteRoute = routes.find((r) => r.method === "DELETE")!;

    await expect(
      deleteRoute.handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/contacts/contact-1`,
        params: { tenantId: TENANT, contactId: "contact-1" },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      deleteRoute.handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/contacts/contact-1`,
        params: { tenantId: TENANT, contactId: "contact-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { confirm: false },
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(provider.deleteCalls).toHaveLength(0);
  });

  it("deletes the contact with the confirm flag and returns the audit record", async () => {
    const provider = new FakeContactsCrudProvider();
    const caller: ContactsCrudCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [CONTACTS_WRITE_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const deleteRoute = routes.find((r) => r.method === "DELETE")!;

    const response = await deleteRoute.handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/contacts/contact-1`,
      params: { tenantId: TENANT, contactId: "contact-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { confirm: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as ContactCrudResult;
    expect(body.success).toBe(true);
    expect(body.auditEvent?.action).toBe("contacts.action:delete");
    expect(provider.deleteCalls).toHaveLength(1);
  });
});
