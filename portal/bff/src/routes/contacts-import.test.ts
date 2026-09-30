import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  CONTACTS_IMPORT_OPENAPI,
  CONTACTS_IMPORT_PATH,
  CONTACTS_WRITE_PERMISSION,
  createContactsImportRoutes,
  parseContactsImportInput,
  type ContactImportRowResult,
  type ContactsImportCaller,
  type ContactsImportInput,
  type ContactsImportProvider,
  type ContactsImportReport,
} from "./contacts-import.js";

const TENANT = "tenant-test";

const REPORT: ContactsImportReport = {
  tenantId: TENANT,
  preview: false,
  rows: [
    { row: 1, displayName: "New Vendor", externalAddress: "new@example.com", status: "created", reason: null, contactId: "contact-new" },
    { row: 2, displayName: "New Vendor", externalAddress: "new@example.com", status: "skipped-duplicate", reason: "address appears earlier in this import", contactId: null },
    { row: 3, displayName: "Existing Vendor", externalAddress: "vendor@example.com", status: "skipped-duplicate", reason: "address already exists in the tenant", contactId: null },
    { row: 4, displayName: "Bad Address", externalAddress: "not-an-address", status: "invalid", reason: "externalAddress 'not-an-address' is not a valid email address", contactId: null },
    { row: 5, displayName: "Rejected", externalAddress: "rejected@example.com", status: "failed", reason: "Authorization_RequestDenied", contactId: null },
  ],
  summary: { total: 5, created: 1, skippedDuplicate: 2, invalid: 1, failed: 1, ready: 0 },
};

class FakeContactsImportProvider implements ContactsImportProvider {
  readonly calls: Array<{ tenantId: string; input: ContactsImportInput }> = [];

  async importContacts(tenantId: string, input: ContactsImportInput): Promise<ContactsImportReport> {
    this.calls.push({ tenantId, input });
    return { ...REPORT, tenantId, preview: input.preview };
  }
}

describe("Contacts import route (T-0444)", () => {
  const caller = (): ContactsImportCaller => ({
    tenantScope: tenantScope([TENANT]),
    permissions: [CONTACTS_WRITE_PERMISSION],
  });

  const routesFor = (
    provider: FakeContactsImportProvider,
    resolved: ContactsImportCaller | undefined,
  ) => createContactsImportRoutes({ provider, resolveCaller: () => resolved });

  const postHandler = (provider: FakeContactsImportProvider, resolved: ContactsImportCaller | undefined) => {
    const handler = routesFor(provider, resolved).find((route) => route.method === "POST")?.handler;
    if (!handler) throw new Error("contacts import POST handler is missing");
    return handler;
  };

  it("exposes POST /v1/tenants/:tenantId/contacts/import", () => {
    const routes = createContactsImportRoutes({
      provider: new FakeContactsImportProvider(),
      resolveCaller: () => undefined,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `POST ${CONTACTS_IMPORT_PATH}`,
    ]);
    expect(CONTACTS_IMPORT_OPENAPI.paths["/tenants/{tenantId}/contacts/import"].post.permission).toBe(
      CONTACTS_WRITE_PERMISSION,
    );
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeContactsImportProvider();
    await expect(
      postHandler(provider, undefined)({
        method: "POST",
        path: `/v1/tenants/${TENANT}/contacts/import`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { csv: "externalAddress\nnew@example.com" },
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a tenant outside the caller scope with 403", async () => {
    const provider = new FakeContactsImportProvider();
    const outside: ContactsImportCaller = {
      tenantScope: tenantScope(["different-tenant"]),
      permissions: [CONTACTS_WRITE_PERMISSION],
    };
    await expect(
      postHandler(provider, outside)({
        method: "POST",
        path: `/v1/tenants/${TENANT}/contacts/import`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { csv: "externalAddress\nnew@example.com" },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects callers missing contacts.write with 403", async () => {
    const provider = new FakeContactsImportProvider();
    const readOnly: ContactsImportCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: ["contacts.read"],
    };
    await expect(
      postHandler(provider, readOnly)({
        method: "POST",
        path: `/v1/tenants/${TENANT}/contacts/import`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { csv: "externalAddress\nnew@example.com" },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("accepts the CSV payload and returns one result per row without aborting on invalid or duplicate", async () => {
    const provider = new FakeContactsImportProvider();
    const csv = [
      "displayName,externalAddress,type",
      "New Vendor,new@example.com,mailContact",
      "New Vendor,new@example.com,mailContact",
      "Existing Vendor,vendor@example.com,mailContact",
      "Bad Address,not-an-address,mailContact",
    ].join("\n");

    const response = await postHandler(provider, caller())({
      method: "POST",
      path: `/v1/tenants/${TENANT}/contacts/import`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { csv },
    });

    expect(response.status).toBe(200);
    const body = response.body as ContactsImportReport;
    expect(body.rows).toHaveLength(5);
    expect(body.rows.map((row: ContactImportRowResult) => row.status)).toEqual([
      "created",
      "skipped-duplicate",
      "skipped-duplicate",
      "invalid",
      "failed",
    ]);
    expect(body.rows[1]?.reason).toContain("earlier in this import");
    expect(body.rows[2]?.reason).toContain("already exists in the tenant");
    expect(body.summary).toMatchObject({ total: 5, created: 1, skippedDuplicate: 2, invalid: 1, failed: 1 });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.tenantId).toBe(TENANT);
    expect(provider.calls[0]?.input.csv).toBe(csv);
    expect(provider.calls[0]?.input.preview).toBe(false);
  });

  it("accepts a rows array and forwards the preview flag", async () => {
    const provider = new FakeContactsImportProvider();
    const response = await postHandler(provider, caller())({
      method: "POST",
      path: `/v1/tenants/${TENANT}/contacts/import`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { rows: [{ displayName: "New Vendor", externalAddress: "new@example.com" }], preview: true },
    });

    expect(response.status).toBe(200);
    expect((response.body as ContactsImportReport).preview).toBe(true);
    expect(provider.calls[0]?.input.rows).toHaveLength(1);
    expect(provider.calls[0]?.input.preview).toBe(true);
  });

  it("rejects a body with neither csv nor rows before dispatch", async () => {
    const provider = new FakeContactsImportProvider();
    await expect(
      postHandler(provider, caller())({
        method: "POST",
        path: `/v1/tenants/${TENANT}/contacts/import`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a body carrying both csv and rows", async () => {
    const provider = new FakeContactsImportProvider();
    await expect(
      postHandler(provider, caller())({
        method: "POST",
        path: `/v1/tenants/${TENANT}/contacts/import`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { csv: "externalAddress\nnew@example.com", rows: [{ externalAddress: "new@example.com" }] },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects an empty csv string and a non-array rows value", () => {
    expect(() => parseContactsImportInput({ csv: "   " })).toThrowError();
    expect(() => parseContactsImportInput({ rows: "not-an-array" })).toThrowError();
    expect(() => parseContactsImportInput({ rows: [] })).toThrowError();
    expect(() => parseContactsImportInput({ csv: "externalAddress\nx@example.com", preview: "yes" })).toThrowError();
  });
});
