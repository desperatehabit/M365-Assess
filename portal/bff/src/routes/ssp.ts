// CMMC Level 2 System Security Plan routes: the customer questionnaire and the
// generated SSP document.
//
//   GET    /v1/tenants/:tenantId/ssp                         questionnaire view
//   PUT    /v1/tenants/:tenantId/ssp/profile                 save the system profile
//   PUT    /v1/tenants/:tenantId/ssp/practices/:practiceId   save one practice answer
//   DELETE /v1/tenants/:tenantId/ssp/practices/:practiceId   clear one practice answer
//   GET    /v1/tenants/:tenantId/ssp/document?format=docx|html   the SSP document
//
// Reads require Compliance.Ssp.Read and writes Compliance.Ssp.ReadWrite, both
// intersected with the caller's tenant scope. The view merges the tenant's
// latest assessment findings with the recorded answers (domain/ssp/merge.ts);
// automated evidence is read live and never stored with the answers.
import {
  getSspPractice,
  isSspImplementationStatus,
  isSspResponsibility,
  type SspDocumentView,
  type SspPracticeResponse,
  type SspSystemProfile,
} from "@m365-assess/contracts/ssp";
import { renderSspDocx } from "../domain/ssp/document-docx.js";
import { renderSspHtml } from "../domain/ssp/document-html.js";
import { buildSspView, type SspFindingInput } from "../domain/ssp/merge.js";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const SSP_PATH = "/v1/tenants/:tenantId/ssp";
export const SSP_PROFILE_PATH = "/v1/tenants/:tenantId/ssp/profile";
export const SSP_PRACTICE_PATH = "/v1/tenants/:tenantId/ssp/practices/:practiceId";
export const SSP_DOCUMENT_PATH = "/v1/tenants/:tenantId/ssp/document";

export const SSP_PERMISSIONS = {
  read: "Compliance.Ssp.Read",
  write: "Compliance.Ssp.ReadWrite",
} as const;

export const SSP_UNAUTHENTICATED = "request.unauthenticated";
export const SSP_PRACTICE_NOT_FOUND = "ssp.practice_not_found";

const MAX_TEXT = 20_000;
const MAX_EVIDENCE_ITEMS = 50;
const MAX_EVIDENCE_LENGTH = 1_000;
const PROFILE_FIELDS = [
  "organizationName",
  "systemName",
  "systemOwner",
  "securityContact",
  "description",
  "boundary",
  "environment",
  "interconnections",
  "cuiCategories",
] as const;

export interface SspStore {
  getProfile(tenantId: string): Promise<SspSystemProfile | undefined>;
  upsertProfile(profile: SspSystemProfile): Promise<SspSystemProfile>;
  listPracticeResponses(tenantId: string): Promise<readonly SspPracticeResponse[]>;
  upsertPracticeResponse(response: SspPracticeResponse): Promise<SspPracticeResponse>;
  deletePracticeResponse(tenantId: string, practiceId: string, actor: string): Promise<boolean>;
}

export interface SspFindingsSource {
  latestRunId(tenantId: string): Promise<string | null>;
  listFindings(tenantId: string, runId: string): Promise<readonly SspFindingInput[]>;
}

export interface SspRouteOptions {
  readonly store: SspStore;
  readonly findings: SspFindingsSource;
  readonly practiceChecks: () => ReadonlyMap<string, readonly string[]>;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly now?: () => string;
}

function requireCaller(options: SspRouteOptions, ctx: RequestContext): Caller {
  const caller = options.resolveCaller(ctx);
  if (!caller) throw new AppError(SSP_UNAUTHENTICATED, "authentication required", 401);
  return caller;
}

async function authorize(options: SspRouteOptions, caller: Caller, permission: string): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(permission) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${permission}`, 403);
  }
}

function invalid(field: string, message: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason: "invalid" }]);
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (!value) throw invalid(name, `missing route parameter '${name}'`);
  return value;
}

function bodyRecord(ctx: RequestContext): Record<string, unknown> {
  let body = ctx.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      throw invalid("body", "request body is not valid JSON");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid("body", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function optionalText(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalid(field, `${field} must be a string`);
  if (value.length > MAX_TEXT) throw invalid(field, `${field} must be at most ${MAX_TEXT} characters`);
  return value;
}

function nullableText(record: Record<string, unknown>, field: string, max = 500): string | null {
  const value = record[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw invalid(field, `${field} must be a string or null`);
  if (value.length > max) throw invalid(field, `${field} must be at most ${max} characters`);
  return value;
}

function parseEvidence(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("evidence", "evidence must be an array of strings");
  if (value.length > MAX_EVIDENCE_ITEMS) throw invalid("evidence", `evidence holds at most ${MAX_EVIDENCE_ITEMS} items`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") throw invalid(`evidence[${index}]`, "each evidence item must be a non-empty string");
    if (item.length > MAX_EVIDENCE_LENGTH) throw invalid(`evidence[${index}]`, `evidence items are at most ${MAX_EVIDENCE_LENGTH} characters`);
    return item.trim();
  });
}

function parsePlannedCompletion(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalid("plannedCompletion", "plannedCompletion must be a date (YYYY-MM-DD) or null");
  }
  return value;
}

function actorOf(caller: Caller): string {
  return caller.userId ?? "unknown";
}

export function createSspRoutes(options: SspRouteOptions): Route[] {
  const now = options.now ?? (() => new Date().toISOString());

  async function scopedTenant(ctx: RequestContext, permission: string): Promise<{ caller: Caller; tenantId: string }> {
    const caller = requireCaller(options, ctx);
    await authorize(options, caller, permission);
    const tenantId = requireParam(ctx, "tenantId");
    requireTenantInScope(caller, tenantId);
    return { caller, tenantId };
  }

  async function loadView(tenantId: string): Promise<SspDocumentView> {
    const runId = await options.findings.latestRunId(tenantId);
    const [findings, responses, profile] = await Promise.all([
      runId ? options.findings.listFindings(tenantId, runId) : Promise.resolve([]),
      options.store.listPracticeResponses(tenantId),
      options.store.getProfile(tenantId),
    ]);
    return buildSspView({
      tenantId,
      practiceChecks: options.practiceChecks(),
      findings,
      runId,
      responses,
      profile: profile ?? null,
      now,
    });
  }

  function requirePractice(ctx: RequestContext): string {
    const practiceId = requireParam(ctx, "practiceId");
    if (!getSspPractice(practiceId)) {
      throw new AppError(SSP_PRACTICE_NOT_FOUND, `practice ${practiceId} is not a CMMC Level 2 practice`, 404);
    }
    return practiceId;
  }

  return [
    {
      method: "GET",
      path: SSP_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const { tenantId } = await scopedTenant(ctx, SSP_PERMISSIONS.read);
        return { status: 200, body: await loadView(tenantId) };
      },
    },
    {
      method: "PUT",
      path: SSP_PROFILE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const { caller, tenantId } = await scopedTenant(ctx, SSP_PERMISSIONS.write);
        const body = bodyRecord(ctx);
        const fields = Object.fromEntries(PROFILE_FIELDS.map((field) => [field, optionalText(body, field)])) as Record<
          (typeof PROFILE_FIELDS)[number],
          string
        >;
        const profile = await options.store.upsertProfile({
          tenantId,
          ...fields,
          updatedBy: actorOf(caller),
          updatedAt: now(),
        });
        return { status: 200, body: { profile } };
      },
    },
    {
      method: "PUT",
      path: SSP_PRACTICE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const { caller, tenantId } = await scopedTenant(ctx, SSP_PERMISSIONS.write);
        const practiceId = requirePractice(ctx);
        const body = bodyRecord(ctx);
        if (!isSspImplementationStatus(body["implementationStatus"])) {
          throw invalid("implementationStatus", "implementationStatus is required and must be a known status");
        }
        if (!isSspResponsibility(body["responsibility"])) {
          throw invalid("responsibility", "responsibility is required: customer, shared, or inherited");
        }
        const response = await options.store.upsertPracticeResponse({
          tenantId,
          practiceId,
          implementationStatus: body["implementationStatus"],
          responsibility: body["responsibility"],
          narrative: optionalText(body, "narrative"),
          evidence: parseEvidence(body["evidence"]),
          owner: nullableText(body, "owner"),
          plannedCompletion: parsePlannedCompletion(body["plannedCompletion"]),
          updatedBy: actorOf(caller),
          updatedAt: now(),
        });
        return { status: 200, body: { response } };
      },
    },
    {
      method: "DELETE",
      path: SSP_PRACTICE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const { caller, tenantId } = await scopedTenant(ctx, SSP_PERMISSIONS.write);
        const practiceId = requirePractice(ctx);
        const removed = await options.store.deletePracticeResponse(tenantId, practiceId, actorOf(caller));
        return { status: removed ? 204 : 404, ...(removed ? {} : { body: { error: { code: ErrorCodes.notFound, message: "no answer recorded for this practice" } } }) };
      },
    },
    {
      method: "GET",
      path: SSP_DOCUMENT_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const { tenantId } = await scopedTenant(ctx, SSP_PERMISSIONS.read);
        const format = ctx.query.get("format") ?? "docx";
        if (format !== "docx" && format !== "html") throw invalid("format", "format must be docx or html");
        const view = await loadView(tenantId);
        const stamp = view.generatedAt.slice(0, 10);
        if (format === "html") {
          return {
            status: 200,
            raw: renderSspHtml(view),
            contentType: "text/html; charset=utf-8",
            headers: { "Content-Disposition": `inline; filename="SSP-${tenantId}-${stamp}.html"` },
          };
        }
        return {
          status: 200,
          raw: renderSspDocx(view),
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          headers: { "Content-Disposition": `attachment; filename="SSP-${tenantId}-${stamp}.docx"` },
        };
      },
    },
  ];
}

const errorResponse = { content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
const tenantParam = { name: "tenantId", in: "path", required: true, schema: { type: "string" } };
const practiceParam = { name: "practiceId", in: "path", required: true, schema: { type: "string" } };

/** OpenAPI fragment; the permission registry derives the route permissions from it. */
export const SSP_OPENAPI = {
  "/v1/tenants/{tenantId}/ssp": {
    get: {
      tags: ["SSP"],
      operationId: "getSsp",
      summary: "CMMC Level 2 SSP questionnaire: every practice with automated evidence and recorded answers.",
      permission: SSP_PERMISSIONS.read,
      security: [{ bearerAuth: [] }],
      parameters: [tenantParam],
      responses: { "200": { description: "SSP view." }, "403": { description: "Missing permission or tenant out of scope.", ...errorResponse } },
    },
  },
  "/v1/tenants/{tenantId}/ssp/profile": {
    put: {
      tags: ["SSP"],
      operationId: "putSspProfile",
      summary: "Save the SSP system profile (boundary, environment, contacts).",
      permission: SSP_PERMISSIONS.write,
      security: [{ bearerAuth: [] }],
      parameters: [tenantParam],
      responses: { "200": { description: "Saved profile." }, "400": { description: "Invalid field.", ...errorResponse } },
    },
  },
  "/v1/tenants/{tenantId}/ssp/practices/{practiceId}": {
    put: {
      tags: ["SSP"],
      operationId: "putSspPractice",
      summary: "Save the questionnaire answer for one practice.",
      permission: SSP_PERMISSIONS.write,
      security: [{ bearerAuth: [] }],
      parameters: [tenantParam, practiceParam],
      responses: { "200": { description: "Saved answer." }, "400": { description: "Invalid field.", ...errorResponse }, "404": { description: "Unknown practice.", ...errorResponse } },
    },
    delete: {
      tags: ["SSP"],
      operationId: "deleteSspPractice",
      summary: "Clear the recorded answer for one practice (automated evidence applies again).",
      permission: SSP_PERMISSIONS.write,
      security: [{ bearerAuth: [] }],
      parameters: [tenantParam, practiceParam],
      responses: { "204": { description: "Cleared." }, "404": { description: "No answer recorded.", ...errorResponse } },
    },
  },
  "/v1/tenants/{tenantId}/ssp/document": {
    get: {
      tags: ["SSP"],
      operationId: "getSspDocument",
      summary: "Generate the SSP as a Word document (format=docx, default) or HTML (format=html).",
      permission: SSP_PERMISSIONS.read,
      security: [{ bearerAuth: [] }],
      parameters: [tenantParam, { name: "format", in: "query", required: false, schema: { type: "string", enum: ["docx", "html"] } }],
      responses: { "200": { description: "The SSP document." }, "400": { description: "Unknown format.", ...errorResponse } },
    },
  },
} as const;
