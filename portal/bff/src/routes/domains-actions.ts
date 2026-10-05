// Domain add/verify/remove/set-default writes (EPIC-034 SPEC.md §3.1, §4.1, §6, §7, §8; T-0663).
//
//   POST   /v1/tenants/:tenantId/domains                      add (returns the DNS verification records)
//   POST   /v1/tenants/:tenantId/domains/:domain/verify       verify
//   DELETE /v1/tenants/:tenantId/domains/:domain              remove
//   POST   /v1/tenants/:tenantId/domains/:domain/default      set as default
//
// Every write executes through the EPIC-006 apply contract (T-0108): the caller
// needs `Tenant.Domains.ReadWrite` and the tenant in scope (gates), a non-dry-run write
// needs explicit `{ "confirm": true }`, an Idempotency-Key is required and a
// repeated key replays the prior outcome instead of re-running the worker,
// and every applied/failed write's audit event is recorded. The worker
// performs the Graph writes (Domain.ReadWrite.All); the BFF performs no
// tenant writes itself. The OpenAPI fragment is published here so
// `portal.v1.yaml` stays untouched (EPIC-001 SPEC §1).

import { AppError, ErrorCodes } from "../errors.js";
import { RbacErrorCodes, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

// ─── Paths, permissions, error codes ─────────────────────────────────────────

export const DOMAINS_ADD_PATH = "/v1/tenants/:tenantId/domains";
export const DOMAIN_VERIFY_PATH = "/v1/tenants/:tenantId/domains/:domain/verify";
export const DOMAIN_REMOVE_PATH = "/v1/tenants/:tenantId/domains/:domain";
export const DOMAIN_DEFAULT_PATH = "/v1/tenants/:tenantId/domains/:domain/default";

export const DOMAINS_WRITE_PERMISSION = "Tenant.Domains.ReadWrite";

export const DOMAINS_ACTION_UNAUTHENTICATED = "request.unauthenticated";
export const DOMAINS_IDEMPOTENCY_REQUIRED = "domains.idempotency_key_required";
export const DOMAINS_INVALID_IDEMPOTENCY_KEY = "domains.invalid_idempotency_key";
export const DOMAINS_CONFIRM_REQUIRED = "domains.confirm_required";
export const DOMAINS_INVALID_BODY = "domains.invalid_body";

// ─── Records ─────────────────────────────────────────────────────────────────

export type DomainAction = "add" | "verify" | "remove" | "setDefault";
export type DomainActionStatus = "applied" | "planned" | "failed";

export interface DomainVerificationRecord {
  readonly recordType: string;
  readonly label?: string;
  readonly text?: string;
  readonly mailExchange?: string;
  readonly preference?: number;
  readonly ttl?: number;
}

export interface DomainActionRequest {
  readonly action: DomainAction;
  readonly domain: string;
  readonly dryRun: boolean;
  readonly confirmed: boolean;
  readonly reason: string | null;
  readonly actor: string;
}

export interface DomainActionOutcome {
  readonly tenantId: string;
  readonly domain: string;
  readonly action: DomainAction;
  readonly status: DomainActionStatus;
  readonly verificationRecords?: readonly DomainVerificationRecord[] | null;
  readonly code?: string | null;
  readonly error?: string | null;
  readonly auditEvent?: Record<string, unknown> | null;
}

// ─── Dependency seams ────────────────────────────────────────────────────────

/** Runs domain-action.ps1 for one tenant; injectable so routes test without pwsh. */
export interface DomainActionProvider {
  run(tenantId: string, request: DomainActionRequest): Promise<DomainActionOutcome>;
}

export interface DomainActionIdempotencyStore {
  find(tenantId: string, key: string): Promise<DomainActionOutcome | undefined>;
  save(tenantId: string, key: string, outcome: DomainActionOutcome): Promise<void>;
}

export function createMemoryDomainActionIdempotencyStore(): DomainActionIdempotencyStore {
  const outcomes = new Map<string, DomainActionOutcome>();
  return {
    async find(tenantId: string, key: string): Promise<DomainActionOutcome | undefined> {
      return outcomes.get(`${tenantId}\n${key}`);
    },
    async save(tenantId: string, key: string, outcome: DomainActionOutcome): Promise<void> {
      outcomes.set(`${tenantId}\n${key}`, outcome);
    },
  };
}

export interface DomainsWriteCaller extends Caller {
  readonly userId?: string;
}

export interface DomainsActionsRouteOptions {
  readonly provider: DomainActionProvider;
  readonly resolveCaller: (ctx: RequestContext) => DomainsWriteCaller | undefined;
  readonly authorize?: (caller: DomainsWriteCaller, permission: string) => boolean;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly idempotency?: DomainActionIdempotencyStore;
}

export interface DomainsActionRequest extends RequestContext {
  readonly body?: unknown;
}

export interface DomainsActionRoute extends Route {
  readonly handler: (ctx: DomainsActionRequest) => RouteResponse | Promise<RouteResponse>;
}

// ─── Input errors ────────────────────────────────────────────────────────────

export class DomainActionInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainActionInputError";
    this.code = code;
  }
}

export const MAX_DOMAIN_IDEMPOTENCY_KEY_LENGTH = 256;

/**
 * Parses a write Idempotency-Key. Required on every domain write (EPIC-006
 * SPEC §6): a missing or blank key is an error, not a silent pass.
 */
export function parseDomainActionIdempotencyKey(value: unknown): string {
  const header = Array.isArray(value) ? value[0] : value;
  if (header === undefined || header === null) {
    throw new DomainActionInputError(
      DOMAINS_IDEMPOTENCY_REQUIRED,
      "Idempotency-Key header is required for domain writes",
    );
  }
  if (typeof header !== "string") {
    throw new DomainActionInputError(DOMAINS_INVALID_IDEMPOTENCY_KEY, "Idempotency-Key must be a string");
  }
  const key = header.trim();
  if (key.length === 0) {
    throw new DomainActionInputError(
      DOMAINS_IDEMPOTENCY_REQUIRED,
      "Idempotency-Key header is required for domain writes",
    );
  }
  if (key.length > MAX_DOMAIN_IDEMPOTENCY_KEY_LENGTH) {
    throw new DomainActionInputError(
      DOMAINS_INVALID_IDEMPOTENCY_KEY,
      `Idempotency-Key exceeds ${MAX_DOMAIN_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  return key;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireBodyRecord(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError(ErrorCodes.validationFailed, "Request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return parsed as Record<string, unknown>;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError(ErrorCodes.validationFailed, "Request body is not valid JSON", 400, [
      { field: "body", reason: "invalid_json" },
    ]);
  }
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing required string field '${field}'`, 400, [
      { field, reason: "required" },
    ]);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new AppError(ErrorCodes.validationFailed, `Field '${field}' must be a string`, 400, [
      { field, reason: "invalid" },
    ]);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new AppError(ErrorCodes.validationFailed, `Field '${field}' must be a boolean`, 400, [
      { field, reason: "invalid" },
    ]);
  }
  return value;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (!value || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing route parameter '${name}'`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value;
}

function toAppError(error: unknown, fallbackField: string): AppError {
  if (error instanceof DomainActionInputError) {
    return new AppError(error.code, error.message, 400, [{ field: fallbackField, reason: "invalid" }]);
  }
  throw error;
}

function publicOutcome(outcome: DomainActionOutcome): Record<string, unknown> {
  const { auditEvent: _omit, ...body } = outcome;
  return body as Record<string, unknown>;
}

// ─── Route factory ───────────────────────────────────────────────────────────

export function createDomainsActionsRoutes(options: DomainsActionsRouteOptions): DomainsActionRoute[] {
  // Single store per route set so Idempotency-Key replay works across requests.
  const idempotency = options.idempotency ?? createMemoryDomainActionIdempotencyStore();

  const authorize =
    options.authorize ??
    ((caller: DomainsWriteCaller, permission: string) => {
      const granted = caller.permissions ?? [];
      return granted.includes(permission) || granted.includes("*");
    });

  const requireWriter = (ctx: RequestContext): DomainsWriteCaller => {
    const caller = options.resolveCaller(ctx);
    if (caller === undefined) {
      throw new AppError(DOMAINS_ACTION_UNAUTHENTICATED, "authentication required", 401);
    }
    if (!authorize(caller, DOMAINS_WRITE_PERMISSION)) {
      throw new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${DOMAINS_WRITE_PERMISSION}`, 403);
    }
    return caller;
  };

  async function runDomainAction(
    ctx: DomainsActionRequest,
    tenantId: string,
    action: DomainAction,
    domain: string,
  ): Promise<RouteResponse> {
    const caller = requireWriter(ctx);
    requireTenantInScope(caller, tenantId);

    let idempotencyKey: string;
    try {
      idempotencyKey = parseDomainActionIdempotencyKey(ctx.headers["idempotency-key"]);
    } catch (error) {
      throw toAppError(error, "Idempotency-Key");
    }

    const prior = await idempotency.find(tenantId, idempotencyKey);
    if (prior) {
      // Replay: return the original outcome without re-running the worker.
      return { status: 200, body: { ...publicOutcome(prior), replayed: true } };
    }

    const body = requireBodyRecord(ctx.body);
    // dryRun defaults to true: an absent flag must never imply a live write
    // (EPIC-006 SPEC §4.3 step 6).
    const dryRun = asBoolean(body["dryRun"], "dryRun") ?? true;
    const confirmed = body["confirm"] === true;
    if (!dryRun && !confirmed) {
      throw new AppError(DOMAINS_CONFIRM_REQUIRED, `action '${action}' requires { "confirm": true }`, 400, [
        { field: "confirm", reason: "required" },
      ]);
    }
    const reason = optionalString(body, "reason");

    const outcome = await options.provider.run(tenantId, {
      action,
      domain,
      dryRun,
      confirmed,
      reason,
      actor: caller.userId ?? "unknown",
    });
    if (outcome.auditEvent) {
      await options.recordAudit?.(outcome.auditEvent);
    }
    await idempotency.save(tenantId, idempotencyKey, outcome);
    return { status: 200, body: publicOutcome(outcome) };
  }

  return [
    {
      method: "POST",
      path: DOMAINS_ADD_PATH,
      handler: async (ctx: DomainsActionRequest): Promise<RouteResponse> => {
        const tenantId = requireParam(ctx, "tenantId");
        const body = requireBodyRecord(ctx.body);
        const domain = requireString(body, "domain");
        return runDomainAction(ctx, tenantId, "add", domain);
      },
    },
    {
      method: "POST",
      path: DOMAIN_VERIFY_PATH,
      handler: async (ctx: DomainsActionRequest): Promise<RouteResponse> =>
        runDomainAction(ctx, requireParam(ctx, "tenantId"), "verify", requireParam(ctx, "domain")),
    },
    {
      method: "DELETE",
      path: DOMAIN_REMOVE_PATH,
      handler: async (ctx: DomainsActionRequest): Promise<RouteResponse> =>
        runDomainAction(ctx, requireParam(ctx, "tenantId"), "remove", requireParam(ctx, "domain")),
    },
    {
      method: "POST",
      path: DOMAIN_DEFAULT_PATH,
      handler: async (ctx: DomainsActionRequest): Promise<RouteResponse> =>
        runDomainAction(ctx, requireParam(ctx, "tenantId"), "setDefault", requireParam(ctx, "domain")),
    },
  ];
}

// ─── OpenAPI fragment (paths published by the route module, SPEC §6) ─────────

const DOMAIN_ACTION_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["confirm"],
  properties: {
    confirm: {
      type: "boolean",
      description: "Required unless dryRun is true; the EPIC-006 apply confirmation.",
    },
    dryRun: {
      type: "boolean",
      description: "Plans the write with no tenant change. Defaults to true.",
    },
    reason: {
      type: "string",
      description: "Caller-supplied reason recorded on the audit event.",
    },
  },
} as const;

const DOMAIN_IDEMPOTENCY_PARAMETER = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", maxLength: MAX_DOMAIN_IDEMPOTENCY_KEY_LENGTH },
  description: "Required. A repeated key replays the prior outcome.",
} as const;

const TENANT_ID_PARAMETER = {
  name: "tenantId",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

const DOMAIN_PARAMETER = {
  name: "domain",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

const ERROR_RESPONSES = {
  "400": {
    description: "Missing Idempotency-Key, confirmation, or invalid body.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "401": {
    description: "Unauthenticated.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "403": {
    description: "Forbidden or tenant out of scope.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
} as const;

export const DOMAINS_ACTIONS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/domains": {
      post: {
        tags: ["Domains"],
        operationId: "addDomain",
        summary:
          "Add a domain; returns the DNS verification records (TXT/MX) to publish. The domain stays unverified until verify succeeds.",
        permission: DOMAINS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [TENANT_ID_PARAMETER, DOMAIN_IDEMPOTENCY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["domain", "confirm"],
                properties: {
                  domain: { type: "string", description: "The domain name to add." },
                  ...DOMAIN_ACTION_REQUEST_SCHEMA.properties,
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The add outcome with the verification records to publish.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DomainActionOutcome" },
              },
            },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    "/tenants/{tenantId}/domains/{domain}/verify": {
      post: {
        tags: ["Domains"],
        operationId: "verifyDomain",
        summary: "Trigger Graph verification for an unverified domain (confirm; dryRun plans only).",
        permission: DOMAINS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [TENANT_ID_PARAMETER, DOMAIN_PARAMETER, DOMAIN_IDEMPOTENCY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/DomainActionRequest" } },
          },
        },
        responses: {
          "200": {
            description: "The verify outcome.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DomainActionOutcome" },
              },
            },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    "/tenants/{tenantId}/domains/{domain}": {
      delete: {
        tags: ["Domains"],
        operationId: "removeDomain",
        summary: "Remove a domain from the tenant (confirm; dryRun plans only)",
        permission: DOMAINS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [TENANT_ID_PARAMETER, DOMAIN_PARAMETER, DOMAIN_IDEMPOTENCY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/DomainActionRequest" } },
          },
        },
        responses: {
          "200": {
            description: "The remove outcome.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DomainActionOutcome" },
              },
            },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    "/tenants/{tenantId}/domains/{domain}/default": {
      post: {
        tags: ["Domains"],
        operationId: "setDomainDefault",
        summary: "Set the domain as the tenant's default domain (confirm; dryRun plans only)",
        permission: DOMAINS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [TENANT_ID_PARAMETER, DOMAIN_PARAMETER, DOMAIN_IDEMPOTENCY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/DomainActionRequest" } },
          },
        },
        responses: {
          "200": {
            description: "The set-default outcome.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DomainActionOutcome" },
              },
            },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
  },
} as const;
