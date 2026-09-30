// Contacts bulk CSV import (EPIC-023 SPEC.md §3.1, §4.1, §6, §7, §8, §9; T-0444).
// Exposes POST /v1/tenants/:tenantId/contacts/import. The route accepts a CSV
// payload (or a JSON rows array), requires `contacts.write` (SPEC §7) within
// the caller tenant scope, and returns one result per input row — created,
// skipped-duplicate, invalid, or failed — so a malformed address or a duplicate
// never aborts the rest of the file. The injected provider is backed by the
// worker queue running the Import-Contacts child job through the EPIC-006 gated
// executor; this module holds no M365 SDK call and issues no tenant write.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const CONTACTS_IMPORT_PATH = "/v1/tenants/:tenantId/contacts/import";
export const CONTACTS_WRITE_PERMISSION = "contacts.write";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const CONTACTS_IMPORT_UNAUTHENTICATED = "request.unauthenticated";

export type ContactImportRowStatus =
  | "created"
  | "skipped-duplicate"
  | "invalid"
  | "failed"
  | "ready";

export interface ContactImportRowResult {
  readonly row: number;
  readonly displayName: string;
  readonly externalAddress: string;
  readonly status: ContactImportRowStatus;
  readonly reason: string | null;
  readonly contactId: string | null;
}

export interface ContactImportSummary {
  readonly total: number;
  readonly created: number;
  readonly skippedDuplicate: number;
  readonly invalid: number;
  readonly failed: number;
  readonly ready: number;
}

export interface ContactsImportReport {
  readonly tenantId: string;
  readonly preview: boolean;
  readonly rows: readonly ContactImportRowResult[];
  readonly summary: ContactImportSummary;
}

export interface ContactsImportInput {
  readonly csv?: string;
  readonly rows?: readonly Record<string, unknown>[];
  readonly preview: boolean;
}

export interface ContactsImportProvider {
  importContacts(tenantId: string, input: ContactsImportInput): Promise<ContactsImportReport>;
}

export interface ContactsImportCaller extends Caller {
  readonly userId?: string;
}

export type ContactsImportAuthorizer = (
  caller: ContactsImportCaller,
  permission: string,
) => void | Promise<void>;

export interface ContactsImportRouteOptions {
  readonly provider: ContactsImportProvider;
  readonly resolveCaller: (ctx: RequestContext) => ContactsImportCaller | undefined;
  readonly authorize?: ContactsImportAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(CONTACTS_IMPORT_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => ContactsImportCaller | undefined,
  ctx: RequestContext,
): ContactsImportCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireTenantParam(ctx: RequestContext): string {
  const value = ctx.params["tenantId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorizeWrite(
  options: ContactsImportRouteOptions,
  caller: ContactsImportCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, CONTACTS_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite = permissions.includes(CONTACTS_WRITE_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing contacts.write permission", 403);
  }
}

function parsePreview(body: Record<string, unknown>): boolean {
  const preview = body["preview"];
  if (preview !== undefined && typeof preview !== "boolean") {
    throw validationError("preview must be a boolean", "preview");
  }
  return preview === true;
}

export function parseContactsImportInput(body: Record<string, unknown>): ContactsImportInput {
  const hasCsv = body["csv"] !== undefined && body["csv"] !== null;
  const hasRows = body["rows"] !== undefined && body["rows"] !== null;
  if (hasCsv && hasRows) {
    throw validationError("provide either 'csv' or 'rows', not both", "csv");
  }
  if (hasCsv) {
    const csv = body["csv"];
    if (typeof csv !== "string" || csv.trim().length === 0) {
      throw validationError("csv must be a non-empty string", "csv");
    }
    return { csv, preview: parsePreview(body) };
  }
  if (hasRows) {
    const rows = body["rows"];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw validationError("rows must be a non-empty array", "rows");
    }
    const parsed = rows.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw validationError(`rows[${index}] must be an object`, "rows");
      }
      return entry as Record<string, unknown>;
    });
    return { rows: parsed, preview: parsePreview(body) };
  }
  throw validationError("provide a csv string or a non-empty rows array", "csv");
}

export function createContactsImportRoutes(options: ContactsImportRouteOptions): Route[] {
  const importHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await authorizeWrite(options, caller);

    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const input = parseContactsImportInput(body);
    const report = await options.provider.importContacts(tenantId, input);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: report,
    };
  };
  return [
    { method: "POST", path: CONTACTS_IMPORT_PATH, handler: importHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const CONTACTS_IMPORT_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/contacts/import": {
      post: {
        operationId: "importContacts",
        summary: "Bulk-import contacts from CSV with per-row results and duplicate detection",
        permission: CONTACTS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  csv: { type: "string" },
                  rows: { type: "array", items: { type: "object" } },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Per-row import results (created, skipped-duplicate, invalid, failed)." },
          "400": { description: "The request shape or CSV is invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks contacts.write or the tenant is out of scope." },
        },
      },
    },
  },
} as const;
