// Message encryption read plus gated OME template apply (EPIC-024 SPEC.md
// §2 US-5, §3.5, §4.3, §6, §8, §10; T-0469). Exposes GET
// /v1/tenants/:tenantId/mail/encryption — the IRM/OME configuration and OME
// template settings, read-only — and PUT /v1/tenants/:tenantId/mail/encryption,
// the gated OME template write. Configuration stays live in EXO (§5); the
// injected provider is backed by the worker queue running the
// get-message-encryption child job, so this module holds no M365 SDK call and
// issues no tenant write of its own. The PUT follows the EPIC-006
// gated-executor contract (T-0108): `preview` (or ?preview=true) returns the
// worker plan with no tenant write, otherwise the worker applies with
// before/after capture and returns one AuditEvent, recorded through the
// recordAudit seam (§8: encryption-template changes are audited). Reads
// require `mailtools.read`; the PUT requires `mailtools.write` or
// `Remediation.Apply`, both intersected with the caller tenant scope.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const ENCRYPTION_PATH = "/v1/tenants/:tenantId/mail/encryption";
export const ENCRYPTION_READ_PERMISSION = "mailtools.read";
export const ENCRYPTION_WRITE_PERMISSION = "mailtools.write";
export const ENCRYPTION_APPLY_PERMISSION = "Remediation.Apply";
export const ENCRYPTION_UNAUTHENTICATED = "request.unauthenticated";
export const ENCRYPTION_CONFIRM_REQUIRED = "encryption.confirm_required";
export const ENCRYPTION_NO_SETTINGS = "encryption.no_settings";
export const ENCRYPTION_UNSUPPORTED_SETTING = "encryption.unsupported_setting";
export const ENCRYPTION_INVALID_SETTING = "encryption.invalid_setting";
export const ENCRYPTION_TEMPLATE_NOT_FOUND = "encryption.template_not_found";

export interface MessageEncryptionIrmConfiguration {
  readonly identity: string;
  readonly azureRmsLicensingEnabled: boolean;
  readonly internalLicensingEnabled: boolean;
  readonly externalLicensingEnabled: boolean;
}

export interface MessageEncryptionOmeTemplate {
  readonly identity: string;
  readonly externalMailExpiryInDays: number | null;
  readonly portalText: string;
  readonly disclaimerText: string;
  readonly emailText: string;
  readonly readButtonText: string;
  readonly introductionText: string;
}

export interface MessageEncryption {
  readonly tenantId: string;
  readonly irmConfiguration: MessageEncryptionIrmConfiguration;
  readonly omeTemplates: readonly MessageEncryptionOmeTemplate[];
  readonly retrievedAt: string;
}

export interface MessageEncryptionTemplatePlan {
  readonly action: "ome-template-apply";
  readonly templateId: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface MessageEncryptionTemplateAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface MessageEncryptionTemplateResult {
  readonly success: boolean;
  readonly plan: MessageEncryptionTemplatePlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: MessageEncryptionTemplateAuditEvent;
}

export interface ApplyMessageEncryptionTemplateInput {
  readonly templateId?: string;
  readonly settings: Record<string, unknown>;
}

// Queue-backed seam for the encryption read and the OME template write: the
// production wiring enqueues a get-message-encryption worker job for
// (tenantId, templateId, settings, preview) and serves the worker result.
// Depending on the seam keeps EXO and process code out of the BFF.
export interface EncryptionProvider {
  getMessageEncryption(tenantId: string): Promise<MessageEncryption | null>;
  applyMessageEncryptionTemplate(
    tenantId: string,
    input: ApplyMessageEncryptionTemplateInput,
    preview: boolean,
  ): Promise<MessageEncryptionTemplateResult | MessageEncryptionTemplatePlan>;
}

export interface EncryptionCaller extends Caller {
  readonly userId?: string;
}

export type EncryptionAuthorizer = (
  caller: EncryptionCaller,
  permission: string,
) => void | Promise<void>;

export interface EncryptionRouteOptions {
  readonly provider: EncryptionProvider;
  readonly resolveCaller: (ctx: RequestContext) => EncryptionCaller | undefined;
  readonly authorize?: EncryptionAuthorizer;
  readonly recordAudit?: (event: MessageEncryptionTemplateAuditEvent) => void | Promise<void>;
}

function unauthenticatedError(): AppError {
  return new AppError(ENCRYPTION_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => EncryptionCaller | undefined,
  ctx: RequestContext,
): EncryptionCaller {
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

async function requireEncryptionRead(
  options: EncryptionRouteOptions,
  caller: EncryptionCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, ENCRYPTION_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(ENCRYPTION_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing mailtools.read", 403);
  }
}

async function requireEncryptionWrite(
  options: EncryptionRouteOptions,
  caller: EncryptionCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, ENCRYPTION_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(ENCRYPTION_WRITE_PERMISSION) ||
    permissions.includes(ENCRYPTION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(
      ErrorCodes.forbidden,
      "forbidden: missing mailtools.write or Remediation.Apply permission",
      403,
    );
  }
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

function parseTemplateId(body: Record<string, unknown>): string | undefined {
  const value = body["templateId"];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(ErrorCodes.validationFailed, "templateId must be a string", 400, [
      { field: "templateId", reason: "invalid" },
    ]);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseSettings(body: Record<string, unknown>): Record<string, unknown> {
  const value = body["settings"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError(ErrorCodes.validationFailed, "settings must be an object", 400, [
      { field: "settings", reason: "required" },
    ]);
  }
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).length === 0) {
    throw new AppError(ENCRYPTION_NO_SETTINGS, "at least one OME template setting is required", 400, [
      { field: "settings", reason: "empty" },
    ]);
  }
  return settings;
}

export function createEncryptionRoutes(options: EncryptionRouteOptions): Route[] {
  const readHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireEncryptionRead(options, caller);

    const config = await options.provider.getMessageEncryption(tenantId);
    if (config === null || config === undefined) {
      throw new AppError(
        ENCRYPTION_TEMPLATE_NOT_FOUND,
        `message encryption configuration for tenant '${tenantId}' was not found`,
        404,
      );
    }

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: config,
    };
  };

  const applyHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireEncryptionWrite(options, caller);

    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const isPreview = readPreviewFlag(ctx, body);
    const templateId = parseTemplateId(body);
    const settings = parseSettings(body);

    const confirmRaw = body["confirm"];
    if (confirmRaw !== undefined && typeof confirmRaw !== "boolean") {
      throw new AppError(ErrorCodes.validationFailed, "confirm must be a boolean", 400, [
        { field: "confirm", reason: "invalid" },
      ]);
    }
    const confirmed = confirmRaw === true;
    if (!isPreview && !confirmed) {
      throw new AppError(
        ENCRYPTION_CONFIRM_REQUIRED,
        "an OME template change requires { \"confirm\": true }",
        400,
        [{ field: "confirm", reason: "required" }],
      );
    }

    let outcome: MessageEncryptionTemplateResult | MessageEncryptionTemplatePlan;
    try {
      outcome = await options.provider.applyMessageEncryptionTemplate(
        tenantId,
        { templateId, settings },
        isPreview,
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "";
      if (/no_settings/i.test(message)) {
        throw new AppError(ENCRYPTION_NO_SETTINGS, message, 400, [
          { field: "settings", reason: "empty" },
        ]);
      }
      if (/unsupported_setting/i.test(message)) {
        throw new AppError(ENCRYPTION_UNSUPPORTED_SETTING, message, 400, [
          { field: "settings", reason: "unsupported_setting" },
        ]);
      }
      if (/invalid_setting/i.test(message)) {
        throw new AppError(ENCRYPTION_INVALID_SETTING, message, 400, [
          { field: "settings", reason: "invalid_setting" },
        ]);
      }
      if (/confirm_required/i.test(message)) {
        throw new AppError(ENCRYPTION_CONFIRM_REQUIRED, message, 400, [
          { field: "confirm", reason: "required" },
        ]);
      }
      if (/not.?found/i.test(message)) {
        throw new AppError(ENCRYPTION_TEMPLATE_NOT_FOUND, message, 404, [
          { field: "templateId", reason: "not_found" },
        ]);
      }
      throw error;
    }

    if (isPreview) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: outcome,
      };
    }

    const result = outcome as MessageEncryptionTemplateResult;
    if (result.auditEvent && options.recordAudit) {
      await options.recordAudit(result.auditEvent);
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  return [
    { method: "GET", path: ENCRYPTION_PATH, handler: readHandler },
    { method: "PUT", path: ENCRYPTION_PATH, handler: applyHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const ENCRYPTION_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/mail/encryption": {
      get: {
        operationId: "getMessageEncryption",
        summary: "Message encryption: IRM/OME configuration and OME template settings",
        permission: ENCRYPTION_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The IRM/OME configuration and OME template settings." },
          "401": { description: "Authentication required." },
          "403": {
            description: "The caller lacks mailtools.read or the tenant is out of scope.",
          },
          "404": { description: "The message encryption configuration was not found." },
        },
      },
      put: {
        operationId: "applyMessageEncryptionTemplate",
        summary: "Apply an OME template change (plan preview with preview:true)",
        permission: ENCRYPTION_WRITE_PERMISSION,
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
                additionalProperties: false,
                required: ["settings"],
                properties: {
                  templateId: { type: "string" },
                  settings: { type: "object", additionalProperties: true },
                  preview: { type: "boolean" },
                  confirm: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Template change plan preview or the applied result with before/after and audit event.",
          },
          "400": {
            description: "Confirmation is missing, or a setting is unsupported or invalid.",
          },
          "401": { description: "Authentication required." },
          "403": {
            description:
              "The caller lacks mailtools.write or Remediation.Apply, or the tenant is out of scope.",
          },
          "404": { description: "The OME template was not found." },
        },
      },
    },
  },
} as const;
