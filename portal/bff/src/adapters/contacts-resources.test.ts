import type { ContactTemplate } from "@m365-assess/db";
import { describe, expect, it } from "vitest";
import { FeatureWorkerError } from "../jobs/feature-worker.js";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import { createContactsResourcesAdapters } from "./contacts-resources.js";
import { WORKER_FAILED, type WorkerRunner } from "./workers.js";

function makeCredential(tenantId: string): CredentialRecord {
  return {
    id: `cred-${tenantId}`,
    tenantId,
    authMethod: "certificate-thumbprint",
    clientId: "app-1",
    secretRef: "thumbprint://ABC",
    thumbprint: "ABC",
    environment: "commercial",
    expiresOn: null,
    lastValidated: null,
    createdAt: "",
    updatedAt: "",
  };
}

const credentials: CredentialStoreRow = {
  getCredential: async (tenantId) =>
    tenantId === "t-a" || tenantId === "t-b" ? makeCredential(tenantId) : undefined,
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

interface RecordedCall {
  readonly entrypoint: string;
  readonly job: Record<string, unknown>;
}

function harness(
  respond: (entrypoint: string, job: Record<string, unknown>) => unknown = () => ({}),
) {
  const calls: RecordedCall[] = [];
  const run: WorkerRunner = async <T>(entrypoint: string, job: Record<string, unknown>): Promise<T> => {
    calls.push({ entrypoint, job });
    return respond(entrypoint, job) as T;
  };
  return { adapters: createContactsResourcesAdapters(run, credentials), calls };
}

const CONTACT_TEMPLATE: ContactTemplate = {
  id: "tpl-vendor",
  name: "Vendor",
  properties: {
    displayName: "{name} Vendor",
    externalAddress: "{address}",
    type: "{type}",
  },
  variables: { type: "mailContact", address: "default@example.invalid" },
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  deletedAt: null,
};

describe("EPIC-023 Contacts & Resources adapters (T-0853)", () => {
  describe("contacts", () => {
    it("lists contacts in a T-0007 envelope, clamps limit to 999, and maps empty nextCursor to null", async () => {
      const { adapters, calls } = harness(() => ({
        tenantId: "t-a",
        items: {
          id: "contact-1",
          displayName: "Vendor Support",
          externalAddress: "smtp:vendor@example.invalid",
          type: "mailContact",
          hiddenFromGal: false,
          lastModified: "2026-09-20T10:00:00Z",
        },
        nextCursor: "",
        totalCount: 1,
        retrievedAt: "2026-09-21T10:00:00Z",
      }));

      const page = await adapters.contacts.listContacts("t-a", {
        search: "vendor",
        type: "mailContact",
        hidden: false,
        cursor: "MQ",
        limit: 1000,
      });

      expect(page).toEqual({
        tenantId: "t-a",
        totalCount: 1,
        items: [
          {
            id: "contact-1",
            displayName: "Vendor Support",
            externalAddress: "smtp:vendor@example.invalid",
            type: "mailContact",
            hiddenFromGal: false,
            lastModified: "2026-09-20T10:00:00Z",
          },
        ],
        nextCursor: null,
      });
      expect(calls[0]?.entrypoint).toBe("get-contacts.ps1");
      expect(calls[0]?.job).toMatchObject({
        tenantId: "t-a",
        schemaVersion: "v1",
        credential: {
          credentialRef: "tenants/t-a/credential",
          record: { tenantId: "t-a", thumbprint: "ABC" },
        },
        payload: {
          search: "vendor",
          type: "mailContact",
          hidden: "false",
          top: 999,
          cursor: "MQ",
        },
      });
      expect(typeof calls[0]?.job["correlationId"]).toBe("string");
    });

    it("throws 409 when the tenant has no credential and surfaces worker errors", async () => {
      const missing = harness();
      await expect(
        missing.adapters.contacts.listContacts("t-missing", { cursor: null, limit: 50 }),
      ).rejects.toMatchObject({ status: 409 });

      const workerErr = harness(() => ({
        error: "contacts.query_failed",
        message: "EXO unavailable",
        statusCode: 503,
      }));
      await expect(
        workerErr.adapters.contacts.listContacts("t-a", { cursor: null, limit: 50 }),
      ).rejects.toMatchObject({ code: "contacts.query_failed", message: "EXO unavailable", status: 503 });

      const crashed = harness(() => {
        throw new FeatureWorkerError("worker.failed", "get-contacts.ps1 exited with code 1", 1, "Auth expired");
      });
      await expect(
        crashed.adapters.contacts.listContacts("t-a", { cursor: null, limit: 50 }),
      ).rejects.toMatchObject({ code: WORKER_FAILED, status: 502, message: expect.stringContaining("Auth expired") });
    });
  });

  describe("contactsCrud", () => {
    it("previews and applies contact creation through invoke-contact-action.ps1", async () => {
      const previewHarness = harness(() => ({
        action: "create",
        contactId: "",
        targetName: "New Vendor",
        before: null,
        after: {
          id: "",
          displayName: "New Vendor",
          externalAddress: "new@example.com",
          type: "mailUser",
          hiddenFromGal: true,
        },
        diff: ["Create mailUser contact 'New Vendor'", "Hide from GAL"],
        valid: true,
        dryRun: true,
        requiresConfirmation: false,
      }));

      const plan = await previewHarness.adapters.contactsCrud.createContact(
        "t-a",
        {
          displayName: "New Vendor",
          externalAddress: "new@example.com",
          type: "mailUser",
          hiddenFromGal: true,
        },
        true,
      );

      expect(plan).toEqual({
        action: "create",
        targetName: "New Vendor",
        before: null,
        after: {
          id: "",
          displayName: "New Vendor",
          externalAddress: "new@example.com",
          type: "mailUser",
          hiddenFromGal: true,
        },
        diff: ["Create mailUser contact 'New Vendor'", "Hide from GAL"],
        valid: true,
        dryRun: true,
        requiresConfirmation: false,
      });
      expect(previewHarness.calls[0]?.entrypoint).toBe("invoke-contact-action.ps1");
      expect(previewHarness.calls[0]?.job).toMatchObject({
        schemaVersion: "v1",
        payload: {
          action: "create",
          displayName: "New Vendor",
          externalAddress: "new@example.com",
          type: "mailUser",
          hiddenFromGal: true,
          dryRun: true,
          confirm: false,
        },
      });

      const applyHarness = harness(() => ({
        plan: {
          action: "create",
          contactId: "",
          targetName: "New Vendor",
          before: null,
          after: { id: "contact-new", displayName: "New Vendor" },
          diff: ["Create mailContact contact 'New Vendor'"],
          valid: true,
          dryRun: false,
          requiresConfirmation: false,
        },
        result: { ExchangeObjectId: "contact-new" },
        auditEvent: {
          id: "audit-1",
          tenantId: "t-a",
          action: "contacts.action:create",
          contactId: "contact-new",
          targetName: "New Vendor",
          timestamp: "2026-09-30T10:00:00Z",
          before: null,
          after: { id: "contact-new", displayName: "New Vendor" },
        },
        success: true,
      }));

      const applied = await applyHarness.adapters.contactsCrud.createContact(
        "t-a",
        { displayName: "New Vendor", externalAddress: "new@example.com" },
        false,
      );

      expect(applied).toMatchObject({
        success: true,
        plan: { action: "create", dryRun: false, targetName: "New Vendor" },
        result: { ExchangeObjectId: "contact-new" },
        auditEvent: { id: "audit-1", contactId: "contact-new" },
      });
      expect(applyHarness.calls[0]?.job).toMatchObject({
        payload: { action: "create", dryRun: false, confirm: true },
      });
    });

    it("previews and applies editContact, hideFromGal, and deleteContact", async () => {
      const { adapters, calls } = harness((_ep, job) => {
        const payload = job["payload"] as Record<string, unknown>;
        const action = payload["action"] as string;
        const contactId = payload["contactId"] as string;
        const dryRun = Boolean(payload["dryRun"]);
        const plan = {
          action,
          contactId,
          targetName: "Vendor Support",
          before: { id: contactId, hiddenFromGal: false },
          after: action === "delete" ? null : { id: contactId, hiddenFromGal: true },
          diff: [`${action} ${contactId}`],
          valid: true,
          dryRun,
          requiresConfirmation: action === "delete",
        };
        if (dryRun) return plan;
        return {
          success: true,
          plan,
          result: action === "delete" ? { deleted: true, id: contactId } : { id: contactId },
          auditEvent: {
            id: `audit-${action}`,
            tenantId: "t-a",
            action: `contacts.action:${action}`,
            contactId,
            targetName: "Vendor Support",
            timestamp: "2026-09-30T10:00:00Z",
          },
        };
      });

      const editPlan = await adapters.contactsCrud.editContact(
        "t-a",
        "contact-1",
        { displayName: "Renamed", hiddenFromGal: false },
        true,
      );
      expect(editPlan).toMatchObject({ action: "edit", contactId: "contact-1", dryRun: true });
      expect(calls[0]?.job).toMatchObject({
        payload: {
          action: "edit",
          contactId: "contact-1",
          displayName: "Renamed",
          hiddenFromGal: false,
          dryRun: true,
          confirm: false,
        },
      });

      const editApplied = await adapters.contactsCrud.editContact(
        "t-a",
        "contact-1",
        { externalAddress: "updated@example.invalid" },
        false,
      );
      expect(editApplied).toMatchObject({ success: true, auditEvent: { action: "contacts.action:edit" } });
      expect((calls[1]?.job["payload"] as Record<string, unknown>)["hiddenFromGal"]).toBeUndefined();

      const hidePlan = await adapters.contactsCrud.hideFromGal("t-a", "contact-1", true);
      expect(hidePlan).toMatchObject({ action: "hideFromGal", dryRun: true });

      const hideApplied = await adapters.contactsCrud.hideFromGal("t-a", "contact-1", false);
      expect(hideApplied).toMatchObject({ success: true, auditEvent: { action: "contacts.action:hideFromGal" } });

      const deletePlan = await adapters.contactsCrud.deleteContact("t-a", "contact-1", true);
      expect(deletePlan).toMatchObject({
        action: "delete",
        dryRun: true,
        requiresConfirmation: true,
      });

      const deleteApplied = await adapters.contactsCrud.deleteContact("t-a", "contact-1", false);
      expect(deleteApplied).toMatchObject({
        success: true,
        result: { deleted: true, id: "contact-1" },
        auditEvent: { action: "contacts.action:delete" },
      });
      expect(calls[5]?.job).toMatchObject({
        payload: { action: "delete", contactId: "contact-1", dryRun: false, confirm: true },
      });
    });

    it("maps missing contacts to 404 and EXO write failures to 502", async () => {
      const notFound = harness(() => ({
        contactId: "contact-404",
        action: "hideFromGal",
        status: "failed",
        before: null,
        after: null,
        error: "contact 'contact-404' was not found",
      }));
      await expect(
        notFound.adapters.contactsCrud.hideFromGal("t-a", "contact-404", false),
      ).rejects.toMatchObject({ code: "contacts.not_found", status: 404 });

      const exoDenied = harness(() => ({
        contactId: "contact-1",
        action: "delete",
        status: "failed",
        before: { id: "contact-1" },
        after: null,
        error: "Authorization_RequestDenied",
      }));
      await expect(
        exoDenied.adapters.contactsCrud.deleteContact("t-a", "contact-1", false),
      ).rejects.toMatchObject({ code: WORKER_FAILED, status: 502, message: "Authorization_RequestDenied" });
    });
  });

  describe("contactsImport", () => {
    it("imports CSV on apply and rows array on preview through import-contacts.ps1", async () => {
      const csvHarness = harness(() => ({
        tenantId: "t-a",
        preview: false,
        rows: [
          {
            row: 1,
            displayName: "New Vendor",
            externalAddress: "new@example.com",
            status: "created",
            reason: null,
            contactId: "contact-new",
          },
          {
            row: 2,
            displayName: "Dup",
            externalAddress: "dup@example.com",
            status: "skipped-duplicate",
            reason: "address already exists in the tenant",
            contactId: null,
          },
        ],
        summary: {
          total: 2,
          created: 1,
          skippedDuplicate: 1,
          invalid: 0,
          failed: 0,
          ready: 0,
        },
        auditEvents: [{ id: "evt-1" }],
      }));

      const csv = "displayName,externalAddress\nNew Vendor,new@example.com\nDup,dup@example.com";
      const report = await csvHarness.adapters.contactsImport.importContacts("t-a", {
        csv,
        preview: false,
      });

      expect(report).toEqual({
        tenantId: "t-a",
        preview: false,
        rows: [
          {
            row: 1,
            displayName: "New Vendor",
            externalAddress: "new@example.com",
            status: "created",
            reason: null,
            contactId: "contact-new",
          },
          {
            row: 2,
            displayName: "Dup",
            externalAddress: "dup@example.com",
            status: "skipped-duplicate",
            reason: "address already exists in the tenant",
            contactId: null,
          },
        ],
        summary: {
          total: 2,
          created: 1,
          skippedDuplicate: 1,
          invalid: 0,
          failed: 0,
          ready: 0,
        },
      });
      expect(csvHarness.calls[0]?.entrypoint).toBe("import-contacts.ps1");
      expect(csvHarness.calls[0]?.job).toMatchObject({
        schemaVersion: "v1",
        payload: { csv, preview: false },
      });

      const rowsHarness = harness(() => ({
        tenantId: "t-a",
        preview: true,
        rows: {
          row: 1,
          displayName: "Preview Vendor",
          externalAddress: "preview@example.invalid",
          status: "ready",
          reason: null,
          contactId: null,
        },
        summary: { total: 1, created: 0, skippedDuplicate: 0, invalid: 0, failed: 0, ready: 1 },
      }));

      const previewReport = await rowsHarness.adapters.contactsImport.importContacts("t-a", {
        rows: [{ displayName: "Preview Vendor", externalAddress: "preview@example.invalid" }],
        preview: true,
      });
      expect(previewReport.preview).toBe(true);
      expect(previewReport.rows).toHaveLength(1);
      expect(previewReport.rows[0]?.status).toBe("ready");
      expect(rowsHarness.calls[0]?.job).toMatchObject({
        payload: {
          rows: [{ displayName: "Preview Vendor", externalAddress: "preview@example.invalid" }],
          preview: true,
        },
      });
    });

    it("raises structured 400 errors from import-contacts.ps1", async () => {
      const { adapters } = harness(() => ({
        error: "contacts.csv_invalid",
        message: "CSV is missing the 'externalAddress' column",
        statusCode: 400,
      }));

      await expect(
        adapters.contactsImport.importContacts("t-a", { csv: "displayName\nNo Address", preview: true }),
      ).rejects.toMatchObject({ code: "contacts.csv_invalid", status: 400 });
    });
  });

  describe("contactTemplateDeploy", () => {
    it("plans per target and marks missing credentials or invalid variables without aborting siblings", async () => {
      const { adapters, calls } = harness((_ep, job) => {
        const tenantId = job["tenantId"] as string;
        if (tenantId === "t-a") {
          return {
            templateId: "tpl-vendor",
            preview: true,
            targets: [
              {
                tenantId: "t-a",
                displayName: "Acme Vendor",
                externalAddress: "acme@example.com",
                type: "mailContact",
                status: "ready",
                reason: null,
                contactId: null,
              },
            ],
            auditEvents: [],
          };
        }
        return {
          templateId: "tpl-vendor",
          preview: true,
          targets: [
            {
              tenantId: "t-b",
              displayName: "Bad Vendor",
              externalAddress: "not-an-address",
              type: "mailContact",
              status: "invalid",
              reason: "externalAddress 'not-an-address' is not a valid email address",
              contactId: null,
            },
          ],
          auditEvents: [],
        };
      });

      const plans = await adapters.contactTemplateDeploy.planDeploy(CONTACT_TEMPLATE, [
        { tenantId: "t-a", variables: { name: "Acme", address: "acme@example.com" } },
        { tenantId: "t-b", variables: { name: "Bad", address: "not-an-address" } },
        { tenantId: "t-missing", variables: { name: "Missing", address: "missing@example.invalid" } },
      ]);

      expect(plans).toEqual([
        {
          tenantId: "t-a",
          displayName: "Acme Vendor",
          externalAddress: "acme@example.com",
          type: "mailContact",
          diff: ["Create mailContact contact 'Acme Vendor'"],
          valid: true,
          error: null,
        },
        {
          tenantId: "t-b",
          displayName: "Bad Vendor",
          externalAddress: "not-an-address",
          type: "mailContact",
          diff: [],
          valid: false,
          error: "externalAddress 'not-an-address' is not a valid email address",
        },
        {
          tenantId: "t-missing",
          displayName: null,
          externalAddress: null,
          type: "mailContact",
          diff: [],
          valid: false,
          error: expect.stringContaining("no credential"),
        },
      ]);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.entrypoint).toBe("deploy-contact-template.ps1");
      expect(calls[0]?.job).toMatchObject({
        tenantId: "t-a",
        schemaVersion: "v1",
        payload: {
          template: CONTACT_TEMPLATE,
          targets: [{ tenantId: "t-a", variables: { name: "Acme", address: "acme@example.com" } }],
          dryRun: true,
        },
      });
    });

    it("executes deploy per target, mapping created, invalid, and failed outcomes with audit events", async () => {
      const { adapters, calls } = harness((_ep, job) => {
        const tenantId = job["tenantId"] as string;
        if (tenantId === "t-a") {
          return {
            templateId: "tpl-vendor",
            preview: false,
            targets: [
              {
                tenantId: "t-a",
                displayName: "Acme Vendor",
                externalAddress: "acme@example.com",
                type: "mailContact",
                status: "created",
                reason: null,
                contactId: "contact-acme",
              },
            ],
            auditEvents: [
              { id: "evt-a", tenantId: "t-a", contactId: "contact-acme", result: "success" },
            ],
          };
        }
        return {
          templateId: "tpl-vendor",
          preview: false,
          targets: [
            {
              tenantId: "t-b",
              displayName: "Globex Vendor",
              externalAddress: "globex@example.invalid",
              type: "mailContact",
              status: "failed",
              reason: "Authorization_RequestDenied",
              contactId: null,
            },
          ],
          auditEvents: [
            { id: "evt-b", tenantId: "t-b", result: "failure", error: "Authorization_RequestDenied" },
          ],
        };
      });

      const results = await adapters.contactTemplateDeploy.executeDeploy(
        CONTACT_TEMPLATE,
        [
          { tenantId: "t-a", variables: { name: "Acme", address: "acme@example.com" } },
          { tenantId: "t-b", variables: { name: "Globex", address: "globex@example.invalid" } },
          { tenantId: "t-missing", variables: { name: "Missing", address: "missing@example.invalid" } },
        ],
        "operator-1",
      );

      expect(results).toEqual([
        {
          tenantId: "t-a",
          status: "created",
          displayName: "Acme Vendor",
          externalAddress: "acme@example.com",
          contactId: "contact-acme",
          error: null,
          auditEvent: { id: "evt-a", tenantId: "t-a", contactId: "contact-acme", result: "success" },
        },
        {
          tenantId: "t-b",
          status: "failed",
          displayName: "Globex Vendor",
          externalAddress: "globex@example.invalid",
          contactId: null,
          error: "Authorization_RequestDenied",
          auditEvent: { id: "evt-b", tenantId: "t-b", result: "failure", error: "Authorization_RequestDenied" },
        },
        {
          tenantId: "t-missing",
          status: "failed",
          displayName: null,
          externalAddress: null,
          contactId: null,
          error: expect.stringMatching(/no (operator )?credential/),
          auditEvent: null,
        },
      ]);
      expect(calls[0]?.job).toMatchObject({
        payload: { dryRun: false, actor: "operator-1" },
      });
    });
  });

  describe("resources", () => {
    it("lists rooms, equipment, and roomlists, normalizing members and empty cursors", async () => {
      const { adapters, calls } = harness((_ep, job) => {
        const payload = job["payload"] as Record<string, unknown>;
        const kind = payload["kind"] as string;
        if (kind === "roomlists") {
          return {
            tenantId: "t-a",
            kind: "roomlists",
            items: [
              {
                id: "rl-1",
                name: "Building A Rooms",
                primarySmtpAddress: "building.a.rooms@example.invalid",
                capacity: null,
                location: null,
                type: "roomlist",
                hidden: false,
                members: { name: "Board Room", primarySmtpAddress: "board.room@example.invalid" },
              },
            ],
            nextCursor: "",
            totalCount: 1,
          };
        }
        return {
          tenantId: "t-a",
          kind,
          items: [
            {
              id: "room-1",
              name: "Board Room",
              primarySmtpAddress: "board.room@example.com",
              capacity: 12,
              location: "Building A",
              type: kind === "equipment" ? "equipment" : "room",
              hidden: false,
              members: [],
            },
          ],
          nextCursor: "MQ",
          totalCount: 2,
        };
      });

      const rooms = await adapters.resources.listResources("t-a", "rooms", {
        search: "board",
        cursor: null,
        limit: 1000,
      });
      expect(rooms).toEqual({
        tenantId: "t-a",
        kind: "rooms",
        totalCount: 2,
        items: [
          {
            id: "room-1",
            name: "Board Room",
            primarySmtpAddress: "board.room@example.com",
            capacity: 12,
            location: "Building A",
            type: "room",
            hidden: false,
            members: [],
          },
        ],
        nextCursor: "MQ",
      });
      expect(calls[0]?.entrypoint).toBe("get-resources.ps1");
      expect(calls[0]?.job).toMatchObject({
        schemaVersion: "v1",
        payload: { kind: "rooms", search: "board", top: 999 },
      });

      const roomLists = await adapters.resources.listResources("t-a", "roomlists", {
        cursor: "MQ",
        limit: 25,
      });
      expect(roomLists.nextCursor).toBeNull();
      expect(roomLists.items[0]?.members).toEqual([
        { name: "Board Room", primarySmtpAddress: "board.room@example.invalid" },
      ]);
      expect(calls[1]?.job).toMatchObject({
        payload: { kind: "roomlists", top: 25, cursor: "MQ" },
      });
    });

    it("surfaces worker errors from get-resources.ps1", async () => {
      const { adapters } = harness(() => ({
        error: "resources.query_failed",
        message: "EXO timeout",
        statusCode: 504,
      }));
      await expect(
        adapters.resources.listResources("t-a", "equipment", { cursor: null, limit: 50 }),
      ).rejects.toMatchObject({ code: "resources.query_failed", status: 504 });
    });
  });

  describe("resourcesCrud", () => {
    it("previews and applies create, edit, addMember, removeMember, and delete", async () => {
      const { adapters, calls } = harness((_ep, job) => {
        const payload = job["payload"] as Record<string, unknown>;
        const action = payload["action"] as string;
        const resourceId = payload["resourceId"] as string | undefined;
        const dryRun = Boolean(payload["dryRun"]);
        const plan = {
          action,
          ...(resourceId ? { resourceId } : {}),
          targetName: (payload["displayName"] as string | undefined) ?? "Board Room",
          before: action === "create" ? null : { id: resourceId },
          after: action === "delete" ? null : { id: resourceId ?? "room-new" },
          diff: [`${action} resource`],
          valid: true,
          dryRun,
          requiresConfirmation: action === "delete",
        };
        if (dryRun) return plan;
        return {
          success: true,
          plan,
          result: action === "delete" ? { deleted: true, id: resourceId } : { id: resourceId ?? "room-new" },
          auditEvent: {
            id: `audit-${action}`,
            tenantId: "t-a",
            action: `resources.action:${action}`,
            resourceId: resourceId ?? "room-new",
            targetName: "Board Room",
            timestamp: "2026-09-30T10:00:00Z",
          },
        };
      });

      const createPlan = await adapters.resourcesCrud.createResource(
        "t-a",
        "rooms",
        { displayName: "Focus Room", capacity: 8, location: "Building B", hidden: false },
        true,
      );
      expect(createPlan).toMatchObject({
        action: "create",
        targetName: "Focus Room",
        dryRun: true,
        requiresConfirmation: false,
      });
      expect(calls[0]?.entrypoint).toBe("invoke-resource-action.ps1");
      expect(calls[0]?.job).toMatchObject({
        schemaVersion: "v1",
        payload: {
          kind: "rooms",
          action: "create",
          displayName: "Focus Room",
          capacity: 8,
          location: "Building B",
          hidden: false,
          dryRun: true,
          confirm: false,
        },
      });

      const createApplied = await adapters.resourcesCrud.createResource(
        "t-a",
        "equipment",
        { displayName: "Projector Cart" },
        false,
      );
      expect(createApplied).toMatchObject({
        success: true,
        plan: { action: "create", dryRun: false },
        auditEvent: { action: "resources.action:create" },
      });

      const editPlan = await adapters.resourcesCrud.editResource(
        "t-a",
        "rooms",
        "room-1",
        { displayName: "Renamed Room", capacity: 20, location: null },
        true,
      );
      expect(editPlan).toMatchObject({ action: "edit", resourceId: "room-1", dryRun: true });
      expect((calls[2]?.job["payload"] as Record<string, unknown>)["location"]).toBeUndefined();

      const editApplied = await adapters.resourcesCrud.editResource(
        "t-a",
        "rooms",
        "room-1",
        { hidden: true },
        false,
      );
      expect(editApplied).toMatchObject({ success: true, auditEvent: { action: "resources.action:edit" } });

      const addMemberPlan = await adapters.resourcesCrud.addMember(
        "t-a",
        "roomlists",
        "rl-1",
        { action: "addMember", memberId: "room-1" },
        true,
      );
      expect(addMemberPlan).toMatchObject({ action: "addMember", resourceId: "rl-1", dryRun: true });

      const addMemberApplied = await adapters.resourcesCrud.addMember(
        "t-a",
        "roomlists",
        "rl-1",
        { action: "addMember", memberId: "room-1" },
        false,
      );
      expect(addMemberApplied).toMatchObject({
        success: true,
        auditEvent: { action: "resources.action:addMember" },
      });
      expect(calls[5]?.job).toMatchObject({
        payload: {
          kind: "roomlists",
          action: "addMember",
          resourceId: "rl-1",
          memberId: "room-1",
          dryRun: false,
          confirm: true,
        },
      });

      const removePlan = await adapters.resourcesCrud.removeMember(
        "t-a",
        "roomlists",
        "rl-1",
        { action: "removeMember", memberId: "room-1" },
        true,
      );
      expect(removePlan).toMatchObject({ action: "removeMember", dryRun: true });

      const removeApplied = await adapters.resourcesCrud.removeMember(
        "t-a",
        "roomlists",
        "rl-1",
        { action: "removeMember", memberId: "room-1" },
        false,
      );
      expect(removeApplied).toMatchObject({
        success: true,
        auditEvent: { action: "resources.action:removeMember" },
      });

      const deletePlan = await adapters.resourcesCrud.deleteResource("t-a", "rooms", "room-1", true);
      expect(deletePlan).toMatchObject({
        action: "delete",
        resourceId: "room-1",
        dryRun: true,
        requiresConfirmation: true,
      });

      const deleteApplied = await adapters.resourcesCrud.deleteResource("t-a", "rooms", "room-1", false);
      expect(deleteApplied).toMatchObject({
        success: true,
        result: { deleted: true, id: "room-1" },
        auditEvent: { action: "resources.action:delete" },
      });
    });

    it("maps resource not-found, duplicate/missing member, and EXO errors to AppErrors", async () => {
      const notFound = harness(() => ({
        resourceId: "room-9",
        action: "edit",
        status: "failed",
        before: null,
        after: null,
        error: "resource 'room-9' was not found",
      }));
      await expect(
        notFound.adapters.resourcesCrud.editResource("t-a", "rooms", "room-9", { displayName: "X" }, false),
      ).rejects.toMatchObject({ code: "resources.not_found", status: 404 });

      const dupMember = harness(() => ({
        resourceId: "rl-1",
        action: "addMember",
        status: "failed",
        before: { id: "rl-1" },
        after: null,
        error: "resource 'room-1' is already a member of room list 'rl-1'",
      }));
      await expect(
        dupMember.adapters.resourcesCrud.addMember(
          "t-a",
          "roomlists",
          "rl-1",
          { action: "addMember", memberId: "room-1" },
          false,
        ),
      ).rejects.toMatchObject({ code: "resources.member_exists", status: 409 });

      const missingMember = harness(() => ({
        resourceId: "rl-1",
        action: "removeMember",
        status: "failed",
        before: { id: "rl-1" },
        after: null,
        error: "resource 'equip-1' is not a member of room list 'rl-1'",
      }));
      await expect(
        missingMember.adapters.resourcesCrud.removeMember(
          "t-a",
          "roomlists",
          "rl-1",
          { action: "removeMember", memberId: "equip-1" },
          false,
        ),
      ).rejects.toMatchObject({ code: "resources.member_not_found", status: 404 });

      const exoError = harness(() => ({
        resourceId: "room-1",
        action: "delete",
        status: "failed",
        before: { id: "room-1" },
        after: null,
        error: "Authorization_RequestDenied",
      }));
      await expect(
        exoError.adapters.resourcesCrud.deleteResource("t-a", "rooms", "room-1", false),
      ).rejects.toMatchObject({ code: WORKER_FAILED, status: 502 });
    });
  });
});
