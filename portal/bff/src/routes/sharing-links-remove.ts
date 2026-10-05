// Bulk sharing-link removal (EPIC-027 SPEC.md §2 US-4, §3.4, §4.2, §6, §8; T-0527).
// POST /v1/tenants/{id}/sharing/links/remove plans or applies removal of the
// selected links. `preview: true` returns exactly which links will be removed
// and performs no writes. Apply is high-blast-radius: it needs `Sharing.Permissions.ReadWrite`
// plus `Remediation.Apply`, an explicit `{ "confirm": true }`, and a
// `confirmCount` naming the submitted link count. Every removal attempt emits
// one audit event and lands in a LinkRemovalJob (T-0526 store seam), so a
// partial batch is always fully reported, never silent. v1 removes sharing
// links (anonymous and organization) only; direct-permission removal is
// deferred (SPEC §11 item 3) and such entries are recorded as skipped.
// The BFF owns validation, RBAC/tenant scope, and response shaping; tenant
// writes run in the Remove-SharingLinks worker through the provider seam.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const SHARING_LINKS_REMOVE_PATH = "/v1/tenants/:tenantId/sharing/links/remove";

export const SHARING_WRITE_PERMISSION = "Sharing.Permissions.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

export const SHARING_LINKS_UNAUTHENTICATED = "request.unauthenticated";
export const SHARING_LINKS_UNAVAILABLE = "sharing.remove_unavailable";
export const SHARING_LINKS_CONFIRM_REQUIRED = "sharing.confirm_required";
export const SHARING_LINKS_COUNT_REQUIRED = "sharing.bulk_count_required";

export const REMOVABLE_LINK_TYPES: readonly string[] = ["anonymous", "organization"];

export interface SharingLinkRef {
  readonly linkId: string;
  readonly itemId: string | null;
  readonly driveId: string | null;
  readonly linkType: string | null;
  readonly resourceName: string | null;
}

export type SharingLinkRemovalStatus = "planned" | "removed" | "failed" | "skipped";

export interface SharingLinkPlanEntry extends SharingLinkRef {
  readonly eligible: boolean;
  readonly skipReason: string | null;
}

export interface SharingLinkRemovalResult extends SharingLinkRef {
  readonly status: SharingLinkRemovalStatus;
  readonly before: unknown;
  readonly after: unknown;
  readonly error: string | null;
}

export interface SharingLinkRemovalSummary {
  readonly total: number;
  readonly removed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface SharingLinkRemovalPlan {
  readonly tenantId: string;
  readonly mode: "plan";
  readonly links: readonly SharingLinkPlanEntry[];
  readonly total: number;
  readonly writes: false;
}

export interface SharingLinkRemovalOutcome {
  readonly tenantId: string;
  readonly mode: "apply";
  readonly jobId: string;
  readonly rows: readonly SharingLinkRemovalResult[];
  readonly summary: SharingLinkRemovalSummary;
}

// Queue-backed seam for the removal path: the production wiring enqueues one
// Remove-SharingLinks worker job per call and serves the per-link result.
// Depending on the seam keeps Graph and process code out of the BFF.
export interface SharingLinkRemovalProvider {
  removeLink(
    tenantId: string,
    link: SharingLinkRef,
  ): Promise<{ status: "removed" | "failed"; before: unknown; after: unknown; error?: string | null }>;
}

export type LinkRemovalJobState = "planned" | "running" | "completed" | "failed";

export interface LinkRemovalJobRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly linkIds: readonly string[];
  readonly state: LinkRemovalJobState;
  readonly results: unknown;
  readonly createdAt: string;
  readonly createdBy: string;
}

// Structural subset of the T-0526 repository surface: create the job up front,
// then publish the per-link results once the batch settles.
export interface LinkRemovalJobStore {
  createLinkRemovalJob(input: {
    id: string;
    tenantId: string;
    linkIds: readonly string[];
    createdBy: string;
  }): Promise<LinkRemovalJobRecord>;
  updateLinkRemovalJob(
    tenantId: string,
    jobId: string,
    update: { state?: LinkRemovalJobState; results?: unknown },
  ): Promise<LinkRemovalJobRecord | undefined>;
}

export interface SharingLinkRemovalAuditEvent {
  readonly tenantId: string;
  readonly action: "sharing.linkRemove";
  readonly targetId: string;
  readonly result: "success" | "failure";
  readonly before: unknown;
  readonly after: unknown;
  readonly error: string | null;
  readonly actorUserId: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
}

export interface SharingLinksRemoveCaller extends Caller {
  readonly userId?: string;
}

export type SharingLinksRemoveAuthorizer = (
  caller: SharingLinksRemoveCaller,
  permission: string,
) => void | Promise<void>;

export interface SharingLinksRemoveRequestContext extends RequestContext {
  readonly body?: unknown;
}

export interface SharingLinksRemoveRouteOptions {
  readonly provider?: SharingLinkRemovalProvider;
  readonly jobs?: LinkRemovalJobStore;
  readonly resolveCaller: (ctx: RequestContext) => SharingLinksRemoveCaller | undefined;
  readonly authorize?: SharingLinksRemoveAuthorizer;
  readonly readBody?: (ctx: SharingLinksRemoveRequestContext) => unknown;
  readonly recordAudit?: (event: SharingLinkRemovalAuditEvent) => Promise<void>;
  readonly now?: () => string;
  readonly newId?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(SHARING_LINKS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason: "invalid" }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => SharingLinksRemoveCaller | undefined,
  ctx: RequestContext,
): SharingLinksRemoveCaller {
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

function readJsonBody(
  ctx: RequestContext,
  readBody: ((ctx: SharingLinksRemoveRequestContext) => unknown) | undefined,
): Record<string, unknown> {
  let body = readBody ? readBody(ctx as SharingLinksRemoveRequestContext) : (ctx as SharingLinksRemoveRequestContext).body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw new AppError(ErrorCodes.validationFailed, "request body is not valid JSON", 400, [
        { field: "body", reason: "invalid_json" },
      ]);
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCodes.validationFailed, "request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return body as Record<string, unknown>;
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw validationError("link fields must be strings", "links");
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseLinks(body: Record<string, unknown>): SharingLinkRef[] {
  const raw = body["links"];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw validationError("links must be a non-empty array", "links");
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AppError(ErrorCodes.validationFailed, `links[${index}] must be an object`, 400, [
        { field: "links", reason: "invalid" },
      ]);
    }
    const record = entry as Record<string, unknown>;
    const linkId = optionalText(record["linkId"]);
    if (linkId === null) {
      throw new AppError(ErrorCodes.validationFailed, `links[${index}].linkId is required`, 400, [
        { field: "links", reason: "invalid" },
      ]);
    }
    return {
      linkId,
      itemId: optionalText(record["itemId"]),
      driveId: optionalText(record["driveId"]),
      linkType: optionalText(record["linkType"]),
      resourceName: optionalText(record["resourceName"]),
    };
  });
}

function parseReason(body: Record<string, unknown>): string {
  const reason = body["reason"];
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "reason is required", 400, [
      { field: "reason", reason: "required" },
    ]);
  }
  return reason.trim();
}

function parsePreview(body: Record<string, unknown>): boolean {
  const preview = body["preview"];
  if (preview !== undefined && typeof preview !== "boolean") {
    throw validationError("preview must be a boolean", "preview");
  }
  return preview === true;
}

function planLinks(links: readonly SharingLinkRef[]): SharingLinkPlanEntry[] {
  return links.map((link) => {
    const eligible = link.linkType === null || (REMOVABLE_LINK_TYPES as readonly string[]).includes(link.linkType);
    return {
      ...link,
      eligible,
      skipReason: eligible ? null : "unsupported-link-type: direct-permission removal is deferred",
    };
  });
}

async function writeLinkAudit(
  options: SharingLinksRemoveRouteOptions,
  ctx: RequestContext,
  caller: SharingLinksRemoveCaller,
  tenantId: string,
  targetId: string,
  result: "success" | "failure",
  before: unknown,
  after: unknown,
  error: string | null,
): Promise<void> {
  if (!options.recordAudit) {
    return;
  }
  const now = options.now ?? (() => new Date().toISOString());
  await options.recordAudit({
    tenantId,
    action: "sharing.linkRemove",
    targetId,
    result,
    before,
    after,
    error,
    actorUserId: caller.userId ?? null,
    correlationId: ctx.correlationId,
    createdAt: now(),
  });
}

export async function postSharingLinksRemove(
  options: SharingLinksRemoveRouteOptions,
  ctx: RequestContext,
  tenantId: string,
  caller: SharingLinksRemoveCaller,
): Promise<{ status: number; body: SharingLinkRemovalPlan | SharingLinkRemovalOutcome }> {
  if (tenantId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  const body = readJsonBody(ctx, options.readBody);
  const links = parseLinks(body);
  parseReason(body);
  const preview = parsePreview(body);
  const planned = planLinks(links);
  if (preview) {
    return {
      status: 200,
      body: { tenantId, mode: "plan", links: planned, total: planned.length, writes: false },
    };
  }
  if (options.provider === undefined || options.jobs === undefined) {
    throw new AppError(SHARING_LINKS_UNAVAILABLE, "sharing-link removal is not wired for this tenant", 501);
  }
  if (options.authorize) {
    await options.authorize(caller, REMEDIATION_APPLY_PERMISSION);
  } else {
    const permissions = caller.permissions ?? [];
    if (!permissions.includes(REMEDIATION_APPLY_PERMISSION) && !permissions.includes("*")) {
      throw new AppError(ErrorCodes.forbidden, "forbidden: missing Remediation.Apply", 403);
    }
  }
  if (body["confirm"] !== true) {
    throw new AppError(
      SHARING_LINKS_CONFIRM_REQUIRED,
      `removing sharing links requires { "confirm": true } with a reason`,
      400,
      [{ field: "confirm", reason: "required" }],
    );
  }
  const confirmCount = body["confirmCount"];
  if (typeof confirmCount !== "number" || !Number.isInteger(confirmCount) || confirmCount !== links.length) {
    throw new AppError(
      SHARING_LINKS_COUNT_REQUIRED,
      `removal affects ${links.length} links and requires { "confirmCount": ${links.length} }`,
      400,
      [{ field: "confirmCount", reason: "required" }],
    );
  }
  const newId = options.newId ?? randomUUID;
  const jobId = newId();
  const actor = caller.userId ?? "unknown";
  await options.jobs.createLinkRemovalJob({
    id: jobId,
    tenantId,
    linkIds: links.map((link) => link.linkId),
    createdBy: actor,
  });
  await options.jobs.updateLinkRemovalJob(tenantId, jobId, { state: "running" });
  const rows: SharingLinkRemovalResult[] = [];
  for (let index = 0; index < planned.length; index += 1) {
    const entry = planned[index] as SharingLinkPlanEntry;
    const link = links[index] as SharingLinkRef;
    if (!entry.eligible) {
      rows.push({ ...link, status: "skipped", before: entry, after: null, error: entry.skipReason });
      continue;
    }
    try {
      const outcome = await options.provider.removeLink(tenantId, link);
      if (outcome.status === "failed") {
        const error = outcome.error ?? "removal failed without a provider result";
        rows.push({ ...link, status: "failed", before: outcome.before, after: outcome.after, error });
        await writeLinkAudit(options, ctx, caller, tenantId, link.linkId, "failure", outcome.before, outcome.after, error);
      } else {
        rows.push({ ...link, status: "removed", before: outcome.before, after: outcome.after, error: null });
        await writeLinkAudit(options, ctx, caller, tenantId, link.linkId, "success", outcome.before, outcome.after, null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "removal failed without a provider result";
      rows.push({ ...link, status: "failed", before: entry, after: null, error: message });
      await writeLinkAudit(options, ctx, caller, tenantId, link.linkId, "failure", entry, null, message);
    }
  }
  const summary: SharingLinkRemovalSummary = {
    total: rows.length,
    removed: rows.filter((row) => row.status === "removed").length,
    failed: rows.filter((row) => row.status === "failed").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
  };
  const jobState: LinkRemovalJobState = summary.failed > 0 ? "failed" : "completed";
  await options.jobs.updateLinkRemovalJob(tenantId, jobId, { state: jobState, results: { rows, summary } });
  return { status: 200, body: { tenantId, mode: "apply", jobId, rows, summary } };
}

export function createSharingLinksRemoveRoutes(options: SharingLinksRemoveRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    if (options.authorize) {
      await options.authorize(caller, SHARING_WRITE_PERMISSION);
    } else {
      const permissions = caller.permissions ?? [];
      if (!permissions.includes(SHARING_WRITE_PERMISSION) && !permissions.includes("*")) {
        throw new AppError(ErrorCodes.forbidden, "forbidden: missing Sharing.Permissions.ReadWrite", 403);
      }
    }
    const result = await postSharingLinksRemove(options, ctx, tenantId, caller);
    return { status: result.status, body: result.body };
  };
  return [{ method: "POST", path: SHARING_LINKS_REMOVE_PATH, handler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const SHARING_LINKS_REMOVE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/sharing/links/remove": {
      post: {
        operationId: "removeSharingLinks",
        summary: "Preview (preview: true) or apply bulk sharing-link removal; apply needs Sharing.Permissions.ReadWrite plus Remediation.Apply, confirm, and the confirmed link count",
        permission: SHARING_WRITE_PERMISSION,
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
                required: ["links", "reason"],
                properties: {
                  links: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["linkId"],
                      properties: {
                        linkId: { type: "string" },
                        itemId: { type: "string" },
                        driveId: { type: "string" },
                        linkType: { type: "string" },
                        resourceName: { type: "string" },
                      },
                    },
                  },
                  reason: { type: "string" },
                  preview: { type: "boolean" },
                  confirm: { type: "boolean" },
                  confirmCount: { type: "integer" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The plan preview, or the per-link removal results with the job id." },
          "400": { description: "Invalid links, or missing confirmation/count/reason." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Sharing.Permissions.ReadWrite (or Remediation.Apply) or the tenant is out of scope." },
          "501": { description: "Removal is not wired for this tenant." },
        },
      },
    },
  },
} as const;
