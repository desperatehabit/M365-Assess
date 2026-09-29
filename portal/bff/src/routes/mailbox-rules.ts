// Mailbox inbox-rule management (EPIC-020 SPEC.md §2 US-5, §3.4, §4.1, §6, §9; T-0385).
// Exposes GET/POST /v1/tenants/:tenantId/mailboxes/:mailboxId/rules and
// PATCH/DELETE .../rules/:ruleId. Reads list the per-mailbox inbox rules and
// forwarding config live (provider is backed by the worker queue running the
// Get-Mailboxes detail read); writes add/edit/remove through the EPIC-006
// gated executor: `preview` (or ?preview=true) returns the worker plan with no
// tenant write, otherwise the worker applies with before/after capture and
// returns one AuditEvent, recorded by the app audit sink. A forwarding-enabling
// change is security-sensitive (BEC vector, SPEC §9): the plan carries the
// forwarding-guard warning with requiresConfirmation, and apply without
// explicit confirmation is refused. The MailboxOperation row persists through
// @m365-assess/db mailbox-repository (wired by a later ticket).
import { assessRuleChange, type RuleForwardingState } from "../domain/mailboxes/forwarding-guard.js";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { MailboxRule } from "./mailboxes.js";
import { MAILBOXES_APPLY_PERMISSION, MAILBOXES_WRITE_PERMISSION } from "./mailboxes.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const MAILBOX_RULES_BASE_PATH = "/v1/tenants/:tenantId/mailboxes/:mailboxId/rules";
export const MAILBOX_RULE_ITEM_PATH =
  "/v1/tenants/:tenantId/mailboxes/:mailboxId/rules/:ruleId";
export const MAILBOX_RULES_READ_PERMISSION = "Mailboxes.Mailbox.Read";
export const MAILBOX_RULES_UNAUTHENTICATED = "request.unauthenticated";
export const MAILBOX_RULE_CONFIRM_REQUIRED = "mailbox.rule_confirm_required";

export interface MailboxRulePlan {
  readonly action: "create" | "edit" | "delete";
  readonly mailboxId: string;
  readonly ruleId?: string;
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

export interface MailboxRuleAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface MailboxRuleResult {
  readonly success: boolean;
  readonly noop?: boolean;
  readonly plan: MailboxRulePlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: MailboxRuleAuditEvent;
}

export interface MailboxRulesListResponse {
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly rules: readonly MailboxRule[];
  readonly retrievedAt: string;
}

export interface CreateMailboxRuleInput {
  readonly name: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly forwardTo?: unknown;
  readonly forwardAsAttachmentTo?: unknown;
  readonly redirectTo?: unknown;
  readonly deleteMessage?: boolean;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

export interface EditMailboxRuleInput {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly forwardTo?: unknown;
  readonly forwardAsAttachmentTo?: unknown;
  readonly redirectTo?: unknown;
  readonly deleteMessage?: boolean;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

export interface MailboxRulesProvider {
  listRules(tenantId: string, mailboxId: string): Promise<MailboxRulesListResponse>;
  createRule(
    tenantId: string,
    mailboxId: string,
    input: CreateMailboxRuleInput,
    preview: boolean,
  ): Promise<MailboxRuleResult | MailboxRulePlan>;
  editRule(
    tenantId: string,
    mailboxId: string,
    ruleId: string,
    input: EditMailboxRuleInput,
    preview: boolean,
  ): Promise<MailboxRuleResult | MailboxRulePlan>;
  deleteRule(
    tenantId: string,
    mailboxId: string,
    ruleId: string,
    preview: boolean,
  ): Promise<MailboxRuleResult | MailboxRulePlan>;
}

export interface MailboxRulesCaller extends Caller {
  readonly userId?: string;
}

export type MailboxRulesAuthorizer = (
  caller: MailboxRulesCaller,
  permission: string,
) => void | Promise<void>;

export interface MailboxRulesRouteOptions {
  readonly provider: MailboxRulesProvider;
  readonly resolveCaller: (ctx: RequestContext) => MailboxRulesCaller | undefined;
  readonly authorize?: MailboxRulesAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(MAILBOX_RULES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => MailboxRulesCaller | undefined,
  ctx: RequestContext,
): MailboxRulesCaller {
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

function requireMailboxParam(ctx: RequestContext): string {
  const value = ctx.params["mailboxId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "mailboxId is required", 400, [
      { field: "mailboxId", reason: "required" },
    ]);
  }
  return value.trim();
}

function requireRuleParam(ctx: RequestContext): string {
  const value = ctx.params["ruleId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "ruleId is required", 400, [
      { field: "ruleId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireRulesRead(
  options: MailboxRulesRouteOptions,
  caller: MailboxRulesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, MAILBOX_RULES_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(MAILBOX_RULES_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Mailboxes.Mailbox.Read", 403);
  }
}

async function requireRulesWrite(
  options: MailboxRulesRouteOptions,
  caller: MailboxRulesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, MAILBOXES_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(MAILBOXES_WRITE_PERMISSION) ||
    permissions.includes(MAILBOXES_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Mailboxes.Mailbox.ReadWrite", 403);
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

function optionalPriority(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw validationError("priority must be a non-negative integer", "priority");
  }
  return value;
}

function toRuleState(input: {
  readonly forwardTo?: unknown;
  readonly forwardAsAttachmentTo?: unknown;
  readonly redirectTo?: unknown;
  readonly deleteMessage?: boolean;
  readonly enabled?: boolean;
}): RuleForwardingState {
  return {
    forwardTo: input.forwardTo,
    forwardAsAttachmentTo: input.forwardAsAttachmentTo,
    redirectTo: input.redirectTo,
    deleteMessage: input.deleteMessage,
    enabled: input.enabled,
  };
}

function applyGuardToPlan(
  plan: MailboxRulePlan,
  action: "create" | "edit",
  state: RuleForwardingState,
): MailboxRulePlan {
  const assessment = assessRuleChange({ action, after: state });
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

function applyGuardToOutcome(
  outcome: MailboxRuleResult | MailboxRulePlan,
  action: "create" | "edit",
  state: RuleForwardingState,
): MailboxRuleResult | MailboxRulePlan {
  if ("success" in outcome) {
    return { ...outcome, plan: applyGuardToPlan(outcome.plan, action, state) };
  }
  return applyGuardToPlan(outcome, action, state);
}

function requireSensitiveConfirm(
  action: "create" | "edit",
  state: RuleForwardingState,
  confirm: boolean,
): void {
  const assessment = assessRuleChange({ action, after: state });
  if (assessment.securitySensitive && !confirm) {
    throw new AppError(
      MAILBOX_RULE_CONFIRM_REQUIRED,
      assessment.warning ?? "forwarding change requires explicit confirmation",
      400,
      [{ field: "confirm", reason: "confirmation_required" }],
    );
  }
}

export function createMailboxRuleRoutes(options: MailboxRulesRouteOptions): Route[] {
  return [
    // GET /v1/tenants/:tenantId/mailboxes/:mailboxId/rules - list inbox rules and forwarding config
    {
      method: "GET",
      path: MAILBOX_RULES_BASE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const mailboxId = requireMailboxParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireRulesRead(options, caller);

        const result = await options.provider.listRules(tenantId, mailboxId);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },

    // POST /v1/tenants/:tenantId/mailboxes/:mailboxId/rules - add a rule or plan preview
    {
      method: "POST",
      path: MAILBOX_RULES_BASE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const mailboxId = requireMailboxParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireRulesWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const name = typeof body["name"] === "string" ? body["name"].trim() : "";
        if (!name) {
          throw validationError("name is required", "name");
        }

        const input: CreateMailboxRuleInput = {
          name,
          enabled: optionalBoolean(body["enabled"]),
          priority: optionalPriority(body["priority"]),
          forwardTo: body["forwardTo"],
          forwardAsAttachmentTo: body["forwardAsAttachmentTo"],
          redirectTo: body["redirectTo"],
          deleteMessage: optionalBoolean(body["deleteMessage"]),
          preview: readPreviewFlag(ctx, body),
          confirm: readConfirmFlag(body),
        };
        const state = toRuleState(input);
        const isPreview = readPreviewFlag(ctx, body);
        if (!isPreview) {
          requireSensitiveConfirm("create", state, readConfirmFlag(body));
        }

        const outcome = await options.provider.createRule(tenantId, mailboxId, input, isPreview);
        return {
          status: isPreview ? 200 : 201,
          headers: { "content-type": "application/json" },
          body: applyGuardToOutcome(outcome, "create", state),
        };
      },
    },

    // PATCH /v1/tenants/:tenantId/mailboxes/:mailboxId/rules/:ruleId - edit a rule or plan preview
    {
      method: "PATCH",
      path: MAILBOX_RULE_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const mailboxId = requireMailboxParam(ctx);
        const ruleId = requireRuleParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireRulesWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const name =
          typeof body["name"] === "string" && body["name"].trim().length > 0
            ? body["name"].trim()
            : undefined;
        const input: EditMailboxRuleInput = {
          name,
          enabled: optionalBoolean(body["enabled"]),
          priority: optionalPriority(body["priority"]),
          forwardTo: body["forwardTo"],
          forwardAsAttachmentTo: body["forwardAsAttachmentTo"],
          redirectTo: body["redirectTo"],
          deleteMessage: optionalBoolean(body["deleteMessage"]),
          preview: readPreviewFlag(ctx, body),
          confirm: readConfirmFlag(body),
        };
        const hasChange =
          name !== undefined ||
          input.enabled !== undefined ||
          input.priority !== undefined ||
          body["forwardTo"] !== undefined ||
          body["forwardAsAttachmentTo"] !== undefined ||
          body["redirectTo"] !== undefined ||
          input.deleteMessage !== undefined;
        if (!hasChange) {
          throw validationError("at least one rule field must be supplied for edit", "name");
        }
        const state = toRuleState(input);
        const isPreview = readPreviewFlag(ctx, body);
        if (!isPreview) {
          requireSensitiveConfirm("edit", state, readConfirmFlag(body));
        }

        const outcome = await options.provider.editRule(tenantId, mailboxId, ruleId, input, isPreview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: applyGuardToOutcome(outcome, "edit", state),
        };
      },
    },

    // DELETE /v1/tenants/:tenantId/mailboxes/:mailboxId/rules/:ruleId - remove a rule or plan preview
    {
      method: "DELETE",
      path: MAILBOX_RULE_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const mailboxId = requireMailboxParam(ctx);
        const ruleId = requireRuleParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireRulesWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const isPreview = readPreviewFlag(ctx, body);
        if (!isPreview && !readConfirmFlag(body)) {
          throw new AppError(
            MAILBOX_RULE_CONFIRM_REQUIRED,
            "removing an inbox rule requires explicit confirmation",
            400,
            [{ field: "confirm", reason: "confirmation_required" }],
          );
        }

        const outcome = await options.provider.deleteRule(tenantId, mailboxId, ruleId, isPreview);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: outcome,
        };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const MAILBOX_RULES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/mailboxes/{mailboxId}/rules": {
      get: {
        operationId: "listMailboxRules",
        summary: "List per-mailbox inbox rules and forwarding config",
        permission: MAILBOX_RULES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "mailboxId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The mailbox inbox rules with forwarding config." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Mailboxes.Mailbox.Read or the tenant is out of scope." },
          "404": { description: "The mailbox was not found." },
        },
      },
      post: {
        operationId: "createMailboxRule",
        summary: "Add an inbox rule (plan preview with preview:true; forwarding changes warn and require confirm:true)",
        permission: MAILBOXES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "mailboxId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Plan preview of the rule create, with the forwarding warning when security-sensitive." },
          "201": { description: "The created rule with before/after and audit event." },
          "400": { description: "Validation failed, or a forwarding-enabling change lacks confirm:true." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Mailboxes.Mailbox.ReadWrite or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/mailboxes/{mailboxId}/rules/{ruleId}": {
      patch: {
        operationId: "editMailboxRule",
        summary: "Edit an inbox rule (plan preview with preview:true; forwarding changes warn and require confirm:true)",
        permission: MAILBOXES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "mailboxId", in: "path", required: true, schema: { type: "string" } },
          { name: "ruleId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Edit plan preview, applied result, or structured no-op." },
          "400": { description: "Validation failed, or a forwarding-enabling change lacks confirm:true." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Mailboxes.Mailbox.ReadWrite or the tenant is out of scope." },
          "404": { description: "The rule was not found." },
        },
      },
      delete: {
        operationId: "deleteMailboxRule",
        summary: "Remove an inbox rule (plan preview with preview:true; apply requires confirm:true)",
        permission: MAILBOXES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "mailboxId", in: "path", required: true, schema: { type: "string" } },
          { name: "ruleId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Delete plan preview or applied result with before/after and audit event." },
          "400": { description: "Confirmation is missing for the removal." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Mailboxes.Mailbox.ReadWrite or the tenant is out of scope." },
          "404": { description: "The rule was not found." },
        },
      },
    },
  },
} as const;
