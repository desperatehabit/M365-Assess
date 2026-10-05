// Connector management (EPIC-021 SPEC.md §2 US-3, §3.2, §4.1, §4.3, §5, §6, §7, §8, §11.2; T-0404).
// Exposes GET/POST /v1/tenants/:tenantId/connectors and PATCH/DELETE
// .../connectors/:connectorId. Reads list connectors live (provider is backed
// by the worker queue running the Get-Connectors child job); writes add, edit,
// enable, disable, and delete through the EPIC-006 gated executor: `preview`
// (or ?preview=true) returns the worker plan with no tenant write, otherwise
// the worker applies with before/after capture and returns one AuditEvent.
// Disabling or deleting a connector that carries production mail flow is
// security-sensitive (SPEC §4.3): the plan carries the mail-flow warning with
// requiresConfirmation, and apply without explicit confirmation is refused.
// Connector secrets (e.g. partner TLS certificates) travel by reference only:
// the route stores material in the credential store and passes the reference
// to the worker, which resolves material inside the tenant child process
// (T-0011); redactConnectorSecret strips material from every outcome.
import {
  redactConnectorSecret,
  storeConnectorSecret,
  isConnectorSecretRef,
} from "../domain/transport/connector-secret.js";
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const CONNECTORS_PATH = "/v1/tenants/:tenantId/connectors";
export const CONNECTOR_ITEM_PATH = "/v1/tenants/:tenantId/connectors/:connectorId";
export const TRANSPORT_READ_PERMISSION = "Exchange.Transport.Read";
export const TRANSPORT_WRITE_PERMISSION = "Exchange.Transport.ReadWrite";
export const CONNECTORS_UNAUTHENTICATED = "request.unauthenticated";
export const CONNECTOR_CONFIRM_REQUIRED = "connector.confirm_required";

export type ConnectorType = "inbound" | "outbound";
export type ConnectorState = "enabled" | "disabled";
export type ConnectorAction = "create" | "edit" | "enable" | "disable" | "delete";

export interface ConnectorItem {
  readonly id: string;
  readonly name: string;
  readonly type: ConnectorType | string;
  readonly state: ConnectorState | string;
  readonly from: string | null;
  readonly to: string | null;
  readonly tls: boolean | null;
  readonly lastModified: string | null;
}

export interface ConnectorsFilter {
  readonly search?: string;
  readonly type?: string;
  readonly state?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ConnectorsPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly ConnectorItem[];
  readonly nextCursor: string | null;
}

export interface ConnectorPlan {
  readonly action: ConnectorAction;
  readonly connectorId?: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securitySensitive?: boolean;
  readonly warning?: string;
}

export interface ConnectorAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface ConnectorResult {
  readonly success: boolean;
  readonly plan: ConnectorPlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: ConnectorAuditEvent;
}

export interface CreateConnectorInput {
  readonly name: string;
  readonly type: ConnectorType | string;
  readonly senderDomains?: string;
  readonly recipientDomains?: string;
  readonly requireTls?: boolean;
  readonly enabled?: boolean;
  readonly secretRef?: string;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

export interface EditConnectorInput {
  readonly action?: "enable" | "disable";
  readonly name?: string;
  readonly senderDomains?: string;
  readonly recipientDomains?: string;
  readonly requireTls?: boolean;
  readonly enabled?: boolean;
  readonly secretRef?: string;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

export interface ConnectorsProvider {
  listConnectors(tenantId: string, filter: ConnectorsFilter): Promise<ConnectorsPage>;
  createConnector(
    tenantId: string,
    input: CreateConnectorInput,
    preview: boolean,
  ): Promise<ConnectorResult | ConnectorPlan>;
  editConnector(
    tenantId: string,
    connectorId: string,
    input: EditConnectorInput,
    preview: boolean,
  ): Promise<ConnectorResult | ConnectorPlan>;
  deleteConnector(
    tenantId: string,
    connectorId: string,
    preview: boolean,
  ): Promise<ConnectorResult | ConnectorPlan>;
}

export interface ConnectorsCaller extends Caller {
  readonly userId?: string;
}

export type ConnectorsAuthorizer = (
  caller: ConnectorsCaller,
  permission: string,
) => void | Promise<void>;

export interface ConnectorsRouteOptions {
  readonly provider: ConnectorsProvider;
  readonly resolveCaller: (ctx: RequestContext) => ConnectorsCaller | undefined;
  readonly authorize?: ConnectorsAuthorizer;
  readonly secrets?: import("../credentials/store.js").CredentialStore;
}

export const CONNECTOR_MAIL_FLOW_WARNING =
  "Disabling this connector affects production mail flow: review the connector before applying. This change is audited with before/after.";

export interface ConnectorMailFlowState {
  readonly enabled?: boolean | null;
}

export interface ConnectorMailFlowAssessment {
  readonly securitySensitive: boolean;
  readonly requiresConfirmation: boolean;
  readonly warning?: string;
  readonly reasons: readonly string[];
}

function mailFlowSensitive(reason: string): ConnectorMailFlowAssessment {
  return {
    securitySensitive: true,
    requiresConfirmation: true,
    warning: CONNECTOR_MAIL_FLOW_WARNING,
    reasons: [reason],
  };
}

function mailFlowClear(): ConnectorMailFlowAssessment {
  return { securitySensitive: false, requiresConfirmation: false, reasons: [] };
}

// SPEC §4.3: disabling (or deleting) a connector that carries production mail
// flow is security-sensitive. `enabled` is tri-state: true/false are explicit,
// null/undefined means the field is not part of the change. The route
// classifies from the declared intent (unknown current state is conservative:
// a disable or delete always warns), and the worker re-classifies from the
// before/after snapshots so the warning is precise.
export function assessConnectorMailFlow(input: {
  readonly action: ConnectorAction;
  readonly before?: ConnectorMailFlowState | null;
  readonly after?: ConnectorMailFlowState | null;
}): ConnectorMailFlowAssessment {
  const { action, before, after } = input;
  const beforeKnown = before !== null && before !== undefined;
  const beforeEnabled = before?.enabled === true;
  const afterDisabled = after?.enabled === false;

  if (action === "disable") {
    return beforeEnabled || !beforeKnown
      ? mailFlowSensitive("connector disable affects production mail flow")
      : mailFlowClear();
  }
  if (action === "delete") {
    return beforeEnabled || !beforeKnown
      ? mailFlowSensitive("connector delete affects production mail flow")
      : mailFlowClear();
  }
  if (action === "edit") {
    if (afterDisabled && (!beforeKnown || beforeEnabled)) {
      return mailFlowSensitive("edit disables a connector that carries production mail flow");
    }
    return mailFlowClear();
  }
  return mailFlowClear();
}

function unauthenticatedError(): AppError {
  return new AppError(CONNECTORS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => ConnectorsCaller | undefined,
  ctx: RequestContext,
): ConnectorsCaller {
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

function requireConnectorParam(ctx: RequestContext): string {
  const value = ctx.params["connectorId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "connectorId is required", 400, [
      { field: "connectorId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireConnectorsRead(
  options: ConnectorsRouteOptions,
  caller: ConnectorsCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, TRANSPORT_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(TRANSPORT_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Exchange.Transport.Read", 403);
  }
}

async function requireConnectorsWrite(
  options: ConnectorsRouteOptions,
  caller: ConnectorsCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, TRANSPORT_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(TRANSPORT_WRITE_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Exchange.Transport.ReadWrite", 403);
  }
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

function readConfirmFlag(body: Record<string, unknown>): boolean {
  return body["confirm"] === true;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalConnectorType(value: unknown): ConnectorType | undefined {
  if (value === "inbound" || value === "outbound") {
    return value;
  }
  return undefined;
}

// Exchanges declared secret material for a store reference. Material is stored
// in the credential store and only the reference continues into the provider
// input, the worker job envelope, the API response, and the audit event.
async function resolveConnectorSecretRef(
  body: Record<string, unknown>,
  tenantId: string,
  options: ConnectorsRouteOptions,
): Promise<string | undefined> {
  const material = typeof body["partnerCert"] === "string" ? body["partnerCert"].trim() : "";
  if (material.length > 0) {
    if (!options.secrets) {
      throw new AppError(
        ErrorCodes.internalError,
        "connector secret material was supplied but no credential store is configured",
        500,
      );
    }
    const record = await storeConnectorSecret({ secrets: options.secrets, tenantId, material });
    return record.secretRef;
  }
  const supplied = optionalText(body["secretRef"]);
  if (supplied !== undefined) {
    if (!isConnectorSecretRef(supplied)) {
      throw validationError("secretRef must be a connector secret reference", "secretRef");
    }
    return supplied;
  }
  return undefined;
}

function applyMailFlowGuardToPlan(
  plan: ConnectorPlan,
  action: ConnectorAction,
  state: ConnectorMailFlowState,
): ConnectorPlan {
  const assessment = assessConnectorMailFlow({ action, after: state });
  if (!assessment.securitySensitive) {
    return plan;
  }
  return {
    ...plan,
    securitySensitive: true,
    requiresConfirmation: true,
    warning: plan.warning ?? assessment.warning,
  };
}

function applyMailFlowGuardToOutcome(
  outcome: ConnectorResult | ConnectorPlan,
  action: ConnectorAction,
  state: ConnectorMailFlowState,
): ConnectorResult | ConnectorPlan {
  if ("success" in outcome) {
    return { ...outcome, plan: applyMailFlowGuardToPlan(outcome.plan, action, state) };
  }
  return applyMailFlowGuardToPlan(outcome, action, state);
}

function requireMailFlowConfirm(
  action: ConnectorAction,
  state: ConnectorMailFlowState,
  confirm: boolean,
): void {
  const assessment = assessConnectorMailFlow({ action, after: state });
  if (assessment.securitySensitive && !confirm) {
    throw new AppError(
      CONNECTOR_CONFIRM_REQUIRED,
      assessment.warning ?? "connector change requires explicit confirmation",
      400,
      [{ field: "confirm", reason: "confirmation_required" }],
    );
  }
}

function planAction(input: EditConnectorInput): ConnectorAction {
  if (input.action === "enable" || input.action === "disable") {
    return input.action;
  }
  return "edit";
}

export function parseConnectorsFilter(query: URLSearchParams): ConnectorsFilter {
  const pagination = parsePagination(query);
  const search = optionalText(query.get("search") ?? undefined);
  const type = optionalText(query.get("type") ?? undefined);
  const state = optionalText(query.get("state") ?? undefined);
  if (type !== undefined && type !== "inbound" && type !== "outbound") {
    throw new AppError(ErrorCodes.validationFailed, "type must be inbound or outbound", 400, [
      { field: "type", reason: "invalid" },
    ]);
  }
  if (state !== undefined && state !== "enabled" && state !== "disabled") {
    throw new AppError(ErrorCodes.validationFailed, "state must be enabled or disabled", 400, [
      { field: "state", reason: "invalid" },
    ]);
  }

  return {
    search,
    type,
    state,
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createConnectorRoutes(options: ConnectorsRouteOptions): Route[] {
  return [
    // GET /v1/tenants/:tenantId/connectors - list connectors with the §3.2 columns
    {
      method: "GET",
      path: CONNECTORS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);

        requireTenantInScope(caller, tenantId);

        await requireConnectorsRead(options, caller);

        const filter = parseConnectorsFilter(ctx.query);
        const page = await options.provider.listConnectors(tenantId, filter);

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: page,
        };
      },
    },

    // POST /v1/tenants/:tenantId/connectors - add a connector or plan preview
    {
      method: "POST",
      path: CONNECTORS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireConnectorsWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const name = optionalText(body["name"]);
        if (name === undefined) {
          throw validationError("name is required", "name");
        }
        const type = optionalConnectorType(body["type"]);
        if (type === undefined) {
          throw validationError("type must be inbound or outbound", "type");
        }
        const secretRef = await resolveConnectorSecretRef(body, tenantId, options);
        const input: CreateConnectorInput = {
          name,
          type,
          senderDomains: optionalText(body["senderDomains"]),
          recipientDomains: optionalText(body["recipientDomains"]),
          requireTls: optionalBoolean(body["requireTls"]),
          enabled: optionalBoolean(body["enabled"]),
          ...(secretRef === undefined ? {} : { secretRef }),
          preview: readPreviewFlag(ctx, body),
          confirm: readConfirmFlag(body),
        };
        const isPreview = readPreviewFlag(ctx, body);
        const state: ConnectorMailFlowState = { enabled: input.enabled };
        if (!isPreview) {
          requireMailFlowConfirm("create", state, readConfirmFlag(body));
        }

        const outcome = await options.provider.createConnector(tenantId, input, isPreview);
        return {
          status: isPreview ? 200 : 201,
          headers: { "content-type": "application/json" },
          body: redactConnectorSecret(applyMailFlowGuardToOutcome(outcome, "create", state)),
        };
      },
    },

    // PATCH /v1/tenants/:tenantId/connectors/:connectorId - edit, enable, disable, or plan preview
    {
      method: "PATCH",
      path: CONNECTOR_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const connectorId = requireConnectorParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireConnectorsWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const declaredAction = body["action"];
        if (declaredAction !== undefined && declaredAction !== "enable" && declaredAction !== "disable") {
          throw validationError("action must be enable or disable", "action");
        }
        const enabled = optionalBoolean(body["enabled"]);
        if (declaredAction !== undefined && enabled !== undefined) {
          throw validationError("supply action or enabled, not both", "action");
        }
        const secretRef = await resolveConnectorSecretRef(body, tenantId, options);
        const input: EditConnectorInput = {
          ...(declaredAction === undefined ? {} : { action: declaredAction }),
          name: optionalText(body["name"]),
          senderDomains: optionalText(body["senderDomains"]),
          recipientDomains: optionalText(body["recipientDomains"]),
          requireTls: optionalBoolean(body["requireTls"]),
          ...(enabled === undefined ? {} : { enabled }),
          ...(secretRef === undefined ? {} : { secretRef }),
          preview: readPreviewFlag(ctx, body),
          confirm: readConfirmFlag(body),
        };
        const hasChange =
          declaredAction !== undefined ||
          input.name !== undefined ||
          input.senderDomains !== undefined ||
          input.recipientDomains !== undefined ||
          input.requireTls !== undefined ||
          enabled !== undefined;
        if (!hasChange) {
          throw validationError("at least one connector field must be supplied for edit", "name");
        }
        const action = planAction(input);
        const state: ConnectorMailFlowState = {
          enabled: declaredAction === "disable" ? false : declaredAction === "enable" ? true : enabled,
        };
        const isPreview = readPreviewFlag(ctx, body);
        if (!isPreview) {
          requireMailFlowConfirm(action, state, readConfirmFlag(body));
        }

        const outcome = await options.provider.editConnector(tenantId, connectorId, input, isPreview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: redactConnectorSecret(applyMailFlowGuardToOutcome(outcome, action, state)),
        };
      },
    },

    // DELETE /v1/tenants/:tenantId/connectors/:connectorId - remove a connector or plan preview
    {
      method: "DELETE",
      path: CONNECTOR_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const connectorId = requireConnectorParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireConnectorsWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const isPreview = readPreviewFlag(ctx, body);
        if (!isPreview && !readConfirmFlag(body)) {
          throw new AppError(
            CONNECTOR_CONFIRM_REQUIRED,
            "removing a connector requires explicit confirmation",
            400,
            [{ field: "confirm", reason: "confirmation_required" }],
          );
        }

        const outcome = await options.provider.deleteConnector(tenantId, connectorId, isPreview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: redactConnectorSecret(applyMailFlowGuardToOutcome(outcome, "delete", {})),
        };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const CONNECTORS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/connectors": {
      get: {
        operationId: "listConnectors",
        summary:
          "List connectors live from EXO (name, type inbound/outbound, state, from/to, TLS, last modified)",
        permission: TRANSPORT_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          {
            name: "type",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["inbound", "outbound"] },
          },
          {
            name: "state",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["enabled", "disabled"] },
          },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated connectors with the §3.2 columns." },
          "400": { description: "An unsupported filter value was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.Transport.Read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createConnector",
        summary:
          "Add a connector (plan preview with preview:true; secrets travel by reference only)",
        permission: TRANSPORT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Plan preview of the connector create." },
          "201": { description: "The created connector with before/after and audit event; secret reference only." },
          "400": { description: "Validation failed." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.Transport.ReadWrite or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/connectors/{connectorId}": {
      patch: {
        operationId: "editConnector",
        summary:
          "Edit, enable, or disable a connector (plan preview with preview:true; disabling a mail-flow connector warns and requires confirm:true)",
        permission: TRANSPORT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "connectorId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Edit/enable/disable plan preview or applied result with before/after and audit event." },
          "400": { description: "Validation failed, or a mail-flow-affecting change lacks confirm:true." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.Transport.ReadWrite or the tenant is out of scope." },
          "404": { description: "The connector was not found." },
        },
      },
      delete: {
        operationId: "deleteConnector",
        summary: "Remove a connector (plan preview with preview:true; apply requires confirm:true)",
        permission: TRANSPORT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "connectorId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Delete plan preview or applied result with before/after and audit event." },
          "400": { description: "Confirmation is missing for the removal." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.Transport.ReadWrite or the tenant is out of scope." },
          "404": { description: "The connector was not found." },
        },
      },
    },
  },
} as const;
