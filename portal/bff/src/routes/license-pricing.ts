// License pricing API (EPIC-033 SPEC §3.3, §6, §7, §11.2; T-0644).
//
// GET /v1/license-pricing returns the effective pricing: a per-tenant
// override when one exists for the requested tenant, the global row otherwise.
// PUT upserts a global row (no tenantId) or a per-tenant override and is
// admin-gated (CIPP.Admin.*, SPEC §7); reads need Tenant.Licensing.Read.
// Every upsert writes an AuditEvent inside the repository transaction. A SKU
// with no pricing is simply absent from the response — missing pricing is
// surfaced honestly and never replaced with a zero (SPEC §9).
import { AppError, ErrorCodes } from "../errors.js";
import type { Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteHandler } from "../server.js";
import type { LicensePricing, LicensePricingInput, LicensingRepository } from "@m365-assess/db";

export const LICENSE_PRICING_PATH = "/v1/license-pricing";

export const LICENSE_PRICING_READ_PERMISSION = "Tenant.Licensing.Read";
export const LICENSE_PRICING_ADMIN_SCOPE = "CIPP.Admin.*";

export const LICENSE_PRICING_UNAUTHENTICATED = "request.unauthenticated";
export const LICENSE_PRICING_FORBIDDEN = "auth.forbidden";

export interface LicensePricingCaller extends Caller {
  readonly userId?: string;
}

export interface LicensePricingRequestContext extends RequestContext {
  readonly body?: unknown;
}

export type LicensePricingAuthorizer = (
  caller: LicensePricingCaller,
  permission: string,
) => void | Promise<void>;

export interface LicensePricingRouteOptions {
  readonly repository: LicensingRepository;
  readonly resolveCaller: (ctx: RequestContext) => LicensePricingCaller | undefined;
  readonly authorize?: LicensePricingAuthorizer;
  readonly readBody?: (ctx: LicensePricingRequestContext) => unknown;
}

export interface LicensePricingRequest {
  readonly caller: LicensePricingCaller;
  readonly tenantId: string | null;
  readonly body?: unknown;
}

export interface LicensePricingResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function unauthenticatedError(): AppError {
  return new AppError(LICENSE_PRICING_UNAUTHENTICATED, "authentication required", 401);
}

function forbiddenError(permission: string): AppError {
  return new AppError(LICENSE_PRICING_FORBIDDEN, `forbidden: requires ${permission}`, 403);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason: "invalid" }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => LicensePricingCaller | undefined,
  ctx: RequestContext,
): LicensePricingCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) throw unauthenticatedError();
  return caller;
}

async function ensurePermission(
  options: LicensePricingRouteOptions,
  caller: LicensePricingCaller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  const granted = caller.permissions ?? [];
  if (!granted.includes(permission) && !granted.includes("*")) {
    throw forbiddenError(permission);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTenantId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function defaultReadBody(ctx: LicensePricingRequestContext): unknown {
  return ctx.body;
}

function parsePricingInput(
  body: Record<string, unknown>,
  tenantId: string | null,
): LicensePricingInput {
  const skuId = body["skuId"];
  if (typeof skuId !== "string" || skuId.trim().length === 0) {
    throw validationError("skuId must be a non-empty string", "skuId");
  }
  const unitPrice = body["unitPrice"];
  if (typeof unitPrice !== "number" || !Number.isFinite(unitPrice) || unitPrice < 0) {
    throw validationError("unitPrice must be a non-negative number", "unitPrice");
  }
  const currency = body["currency"];
  if (typeof currency !== "string" || currency.trim().length === 0) {
    throw validationError("currency must be a non-empty string", "currency");
  }
  const skuPartNumber = body["skuPartNumber"];
  if (
    skuPartNumber !== undefined &&
    (typeof skuPartNumber !== "string" || skuPartNumber.trim().length === 0)
  ) {
    throw validationError("skuPartNumber must be a non-empty string", "skuPartNumber");
  }
  const input: LicensePricingInput = {
    skuId: skuId.trim(),
    unitPrice,
    currency: currency.trim(),
    ...(tenantId === null ? {} : { tenantId }),
    ...(skuPartNumber === undefined ? {} : { skuPartNumber: skuPartNumber.trim() }),
  };
  return input;
}

export async function getLicensePricing(
  repository: LicensingRepository,
  request: LicensePricingRequest,
): Promise<LicensePricingResponse> {
  const pricing =
    request.tenantId === null
      ? await repository.listLicensePricing()
      : await repository.listLicensePricing(request.tenantId);
  return { status: 200, body: { pricing } };
}

export async function putLicensePricing(
  repository: LicensingRepository,
  request: LicensePricingRequest,
): Promise<LicensePricingResponse> {
  const body = request.body;
  if (!isRecord(body)) throw validationError("request body must be a JSON object", "body");
  const pricing = await repository.upsertLicensePricing(
    parsePricingInput(body, request.tenantId),
  );
  return { status: 200, body: { pricing } };
}

export function createLicensePricingRoutes(options: LicensePricingRouteOptions): Route[] {
  const readBody = options.readBody ?? defaultReadBody;

  const get: RouteHandler = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await ensurePermission(options, caller, LICENSE_PRICING_READ_PERMISSION);
    const result = await getLicensePricing(options.repository, {
      caller,
      tenantId: readTenantId(ctx.query.get("tenantId")),
    });
    return { status: result.status, body: result.body };
  };

  const put: RouteHandler = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await ensurePermission(options, caller, LICENSE_PRICING_ADMIN_SCOPE);
    const body = readBody(ctx as LicensePricingRequestContext);
    const tenantId =
      readTenantId(ctx.query.get("tenantId")) ??
      readTenantId(isRecord(body) ? body["tenantId"] : undefined);
    const result = await putLicensePricing(options.repository, { caller, tenantId, body });
    return { status: result.status, body: result.body };
  };

  return [
    { method: "GET", path: LICENSE_PRICING_PATH, handler: get },
    { method: "PUT", path: LICENSE_PRICING_PATH, handler: put },
  ];
}

export const LICENSE_PRICING_OPENAPI = {
  paths: {
    "/license-pricing": {
      get: {
        operationId: "getLicensePricing",
        summary: "List effective license pricing (tenant override else global)",
        permission: LICENSE_PRICING_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "tenantId",
            in: "query",
            required: false,
            schema: { type: "string" },
            description:
              "Tenant whose effective pricing to list; omit for the global rows.",
          },
        ],
        responses: {
          "200": {
            description:
              "Effective pricing rows; a SKU with no pricing is absent, never a zero.",
          },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks the licensing read permission." },
        },
      },
      put: {
        operationId: "putLicensePricing",
        summary: "Upsert a license price (global default or per-tenant override)",
        permission: LICENSE_PRICING_ADMIN_SCOPE,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["skuId", "unitPrice", "currency"],
                properties: {
                  skuId: { type: "string" },
                  skuPartNumber: { type: "string" },
                  unitPrice: { type: "number", minimum: 0 },
                  currency: { type: "string" },
                  tenantId: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The upserted pricing row." },
          "400": { description: "Invalid pricing body." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks the CIPP.Admin.* scope." },
        },
      },
    },
  },
  schemas: {
    LicensePricing: {
      type: "object",
      additionalProperties: false,
      required: ["skuId", "unitPrice", "currency", "updatedAt"],
      properties: {
        skuId: { type: "string" },
        tenantId: { type: ["string", "null"] },
        skuPartNumber: { type: ["string", "null"] },
        unitPrice: { type: "number" },
        currency: { type: "string" },
        updatedAt: { type: "string" },
      },
    },
  },
} as const;
