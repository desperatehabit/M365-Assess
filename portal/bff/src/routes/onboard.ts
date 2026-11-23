// Tenant onboarding route (EPIC-002 SPEC.md §4.1, §6, §8, §10).
// POST /v1/tenants/{id}/onboard invokes Grant-M365AssessConsent via the worker pool.
// High-impact setup write: requires explicit confirmation and `Tenant.Administration.ReadWrite` permission.
// An unconfirmed path is rejected with 400 and never invokes the worker with -Force.
// Success records an audit event with before/after and stores a credential reference.
// Partial or half-provisioned failures still record an audit event and return a precise error.

import { randomUUID } from "node:crypto";
import { formatSecretRef, formatThumbprintRef, type CredentialStore } from "../credentials/store.js";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route } from "../server.js";
import type { CredentialStoreRow } from "./credentials.js";
import type { TenantAuditInput, TenantRecord, TenantStore } from "./tenants.js";

export const ONBOARD_PATH = "/v1/tenants/:id/onboard";
export const ONBOARD_PROGRESS_PATH = "/v1/tenants/:id/onboard/progress/:progressId";
export const ONBOARD_PERMISSION = "Tenant.Administration.ReadWrite";

export const ONBOARD_CONFIRMATION_REQUIRED = "onboard.confirmation_required";
export const ONBOARD_FAILED = "onboard.failed";
export const ONBOARD_PARTIAL_FAILURE = "onboard.partial_failure";
export const ONBOARD_UNAUTHENTICATED = "request.unauthenticated";
/** The worker exceeded the 30-minute job timeout, usually waiting on a device code. */
export const ONBOARD_TIMEOUT = "onboard.timeout";

export type OnboardProgressKind = "device-code" | "sign-in-complete" | "sign-in-failed";

/**
 * One sign-in progress event for an onboarding job (T-0916). A device-code event carries
 * the code and verification URL the wizard shows while the worker waits; a
 * sign-in-complete event supersedes it. Sequence is monotonic per progress channel.
 */
export interface OnboardDeviceCodeProgress {
  readonly sequence: number;
  readonly kind: OnboardProgressKind;
  /** Onboarding step: graph-bootstrap, graph-permissions, graph-operator, exchange-online. */
  readonly signIn: string;
  readonly provider: string;
  readonly code?: string | null;
  readonly verificationUrl?: string | null;
  readonly expiresAt?: string | null;
  readonly message?: string | null;
  readonly account?: string | null;
  readonly error?: string | null;
  readonly at: string;
}

/** Receives progress events while the onboarding worker runs. */
export type OnboardProgressSink = (event: OnboardDeviceCodeProgress) => void;

export interface OnboardProgressSnapshot {
  /** unknown means the channel was never created (or has been pruned). */
  readonly state: "unknown" | "pending" | "done";
  readonly events: readonly OnboardDeviceCodeProgress[];
}

/**
 * Parses one JSON stdout line from the onboarding worker. Diagnostics and the final
 * result line are ignored. The relay in adapters/workers.ts feeds every line here.
 */
export function parseOnboardProgressLine(line: string): OnboardDeviceCodeProgress | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  if (kind !== "device-code" && kind !== "sign-in-complete" && kind !== "sign-in-failed") {
    return null;
  }
  const signIn = typeof record["signIn"] === "string" ? record["signIn"] : "";
  if (signIn.length === 0) {
    return null;
  }
  const text = (key: string): string | null =>
    typeof record[key] === "string" && (record[key] as string).length > 0
      ? (record[key] as string)
      : null;
  return {
    sequence: typeof record["sequence"] === "number" ? record["sequence"] : 0,
    kind,
    signIn,
    provider: text("provider") ?? signIn,
    code: text("code"),
    verificationUrl: text("verificationUrl"),
    expiresAt: text("expiresAt"),
    message: text("message"),
    account: text("account"),
    error: text("error"),
    at: text("at") ?? new Date().toISOString(),
  };
}

export interface OnboardInput {
  readonly confirmed?: boolean;
  readonly adminUpn?: string;
  readonly appDisplayName?: string;
  readonly clientId?: string;
  readonly certificateThumbprint?: string;
  readonly createNew?: boolean;
  /** Opt in to the operator app registration (T-0917); omitted means reader-only, unchanged. */
  readonly includeWritePermissions?: boolean;
  readonly writePermissionGroups?: readonly string[];
  readonly confirmDangerous?: boolean;
  readonly displayName?: string | null;
  readonly defaultDomain?: string | null;
  readonly initialDomain?: string | null;
  readonly environment?: string;
}

export interface OnboardWorkerResult {
  readonly tenantId: string;
  readonly status: "succeeded" | "partial" | "failed";
  readonly clientId?: string | null;
  readonly certificateThumbprint?: string | null;
  /** Set when the certificate lives in a PFX file (no certificate store, e.g. Linux/macOS). */
  readonly certificatePath?: string | null;
  readonly appDisplayName?: string | null;
  readonly bootstrapCreated?: boolean;
  /** Operator app results when write access was opted in (T-0917). */
  readonly operatorAppDisplayName?: string | null;
  readonly operatorClientId?: string | null;
  readonly operatorCertificateThumbprint?: string | null;
  readonly operatorCertificatePath?: string | null;
  readonly operatorCreated?: boolean;
  readonly writePermissionGroups?: readonly string[];
  readonly totalFailed?: number;
  readonly error?: string | null;
  readonly completedAt?: string;
}

export type OnboardRunner = (
  tenantId: string,
  input: OnboardInput,
  /** Present when the wizard asked for a progress channel (device-code relay, T-0916). */
  progress?: OnboardProgressSink,
) => Promise<OnboardWorkerResult>;

export interface OnboardCaller extends Caller {
  readonly userId?: string;
}

export type OnboardAuthorizer = (
  caller: OnboardCaller,
  permission: string,
) => void | Promise<void>;

export interface OnboardRequestContext extends RequestContext {
  readonly body?: unknown;
}

export interface OnboardRouteOptions {
  readonly tenantStore: TenantStore;
  readonly credentialStore?: CredentialStoreRow;
  /** Backend for PFX credential material. Required to persist a PFX-backed onboarding. */
  readonly secrets?: CredentialStore;
  readonly runner: OnboardRunner;
  readonly resolveCaller: (ctx: RequestContext) => OnboardCaller | undefined;
  readonly authorize?: OnboardAuthorizer;
  readonly readBody?: (ctx: OnboardRequestContext) => unknown;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(ONBOARD_UNAUTHENTICATED, "authentication required", 401);
}

/** In-memory per-job device-code channel; created by the POST and read by the wizard. */
interface ProgressChannel {
  readonly tenantId: string;
  state: "pending" | "done";
  sequence: number;
  readonly events: OnboardDeviceCodeProgress[];
  updatedAt: number;
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => OnboardCaller | undefined,
  ctx: RequestContext,
): OnboardCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function extractTenantId(ctx: RequestContext): string {
  const rawId = ctx.params["id"] ?? ctx.params["tenantId"];
  if (typeof rawId !== "string" || rawId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenant id is required", 400);
  }
  return rawId.trim();
}

function parseJsonObject(ctx: OnboardRequestContext, readBody?: (ctx: OnboardRequestContext) => unknown): Record<string, unknown> {
  let body = readBody ? readBody(ctx) : ctx.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw new AppError(ErrorCodes.validationFailed, "request body is not valid JSON", 400);
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCodes.validationFailed, "request body must be a JSON object", 400);
  }
  return body as Record<string, unknown>;
}

export function createOnboardRoutes(options: OnboardRouteOptions): Route[] {
  const now = options.now ?? (() => new Date().toISOString());
  const authorize: OnboardAuthorizer =
    options.authorize ??
    ((caller, perm) => {
      if (!caller.roles.includes("admin")) {
        throw new AppError("rbac.forbidden", `permission ${perm} required (admin only)`, 403);
      }
    });

  // Device-code relay channels (T-0916): one per onboarding job, keyed by the
  // client-generated progressId. Events live only while the job runs plus a short
  // grace period; they carry no credential material, only the pending code.
  const channels = new Map<string, ProgressChannel>();
  const CHANNEL_TTL_MS = 30 * 60 * 1000;
  const CHANNEL_MAX_EVENTS = 50;

  const pruneChannels = (nowIso: string): void => {
    const current = Date.parse(nowIso);
    for (const [id, channel] of channels) {
      if (current - channel.updatedAt > CHANNEL_TTL_MS) {
        channels.delete(id);
      }
    }
  };

  return [
    {
      method: "POST",
      path: ONBOARD_PATH,
      handler: async (ctx: RequestContext) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = extractTenantId(ctx);
        requireTenantInScope(caller, tenantId);
        await authorize(caller, ONBOARD_PERMISSION);

        const bodyObj = parseJsonObject(ctx as OnboardRequestContext, options.readBody);
        const confirmed = bodyObj["confirmed"] === true || bodyObj["confirm"] === true;
        if (!confirmed) {
          throw new AppError(
            ONBOARD_CONFIRMATION_REQUIRED,
            "onboarding is a tenant-mutating setup action and requires explicit confirmation (confirmed: true)",
            400,
          );
        }

        const input: OnboardInput = {
          confirmed: true,
          adminUpn: typeof bodyObj["adminUpn"] === "string" ? bodyObj["adminUpn"] : undefined,
          appDisplayName:
            typeof bodyObj["appDisplayName"] === "string" ? bodyObj["appDisplayName"] : undefined,
          clientId: typeof bodyObj["clientId"] === "string" ? bodyObj["clientId"] : undefined,
          certificateThumbprint:
            typeof bodyObj["certificateThumbprint"] === "string"
              ? bodyObj["certificateThumbprint"]
              : undefined,
          createNew: bodyObj["createNew"] === true,
          includeWritePermissions: bodyObj["includeWritePermissions"] === true,
          writePermissionGroups: Array.isArray(bodyObj["writePermissionGroups"])
            ? bodyObj["writePermissionGroups"].filter((value): value is string => typeof value === "string")
            : undefined,
          confirmDangerous: bodyObj["confirmDangerous"] === true,
          displayName:
            typeof bodyObj["displayName"] === "string" ? bodyObj["displayName"] : undefined,
          defaultDomain:
            typeof bodyObj["defaultDomain"] === "string" ? bodyObj["defaultDomain"] : undefined,
          initialDomain:
            typeof bodyObj["initialDomain"] === "string" ? bodyObj["initialDomain"] : undefined,
          environment:
            typeof bodyObj["environment"] === "string" ? bodyObj["environment"] : "commercial",
        };

        const existing = await options.tenantStore.getTenant(tenantId, { includeDeleted: true });
        const instant = now();
        let workerResult: OnboardWorkerResult;

        // Device-code relay (T-0916). The wizard generates the id and polls the
        // progress route while this POST waits for the operator; a new onboarding for
        // the same tenant supersedes any earlier channel, clearing stale codes.
        const rawProgressId = bodyObj["progressId"];
        const progressId =
          typeof rawProgressId === "string" && rawProgressId.trim().length > 0
            ? rawProgressId.trim()
            : randomUUID();
        pruneChannels(instant);
        for (const [id, channel] of channels) {
          if (channel.tenantId === tenantId && id !== progressId) {
            channel.state = "done";
          }
        }
        const channel: ProgressChannel = {
          tenantId,
          state: "pending",
          sequence: 0,
          events: [],
          updatedAt: Date.parse(instant),
        };
        channels.set(progressId, channel);
        const progress: OnboardProgressSink = (event) => {
          channel.sequence += 1;
          channel.events.push({
            ...event,
            sequence: channel.sequence,
            at: event.at || now(),
          });
          if (channel.events.length > CHANNEL_MAX_EVENTS) {
            channel.events.splice(0, channel.events.length - CHANNEL_MAX_EVENTS);
          }
          channel.updatedAt = Date.parse(now());
        };

        try {
          workerResult = await options.runner(tenantId, input, progress);
        } catch (err) {
          const timedOut =
            typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "worker.timeout";
          const errMsg = timedOut
            ? "Onboarding did not finish within 30 minutes. If a device code was shown, it expired or nobody signed in; start onboarding again for a fresh code."
            : err instanceof Error
              ? err.message
              : String(err);
          if (options.tenantStore.appendAuditEvent) {
            const audit: TenantAuditInput = {
              id: randomUUID(),
              timestamp: instant,
              actorUserId: caller.userId ?? null,
              actorType: caller.userId ? "user" : "system",
              tenantId,
              action: "tenant.onboard",
              targetType: "tenant",
              targetId: tenantId,
              before: existing ? { status: existing.status, id: existing.id } : null,
              after: { tenantId, confirmed: true },
              result: "failure",
              error: errMsg,
              source: "request",
              correlationId: (ctx.headers["x-correlation-id"] as string) ?? null,
            };
            await options.tenantStore.appendAuditEvent(audit);
          }
          if (timedOut) {
            throw new AppError(ONBOARD_TIMEOUT, errMsg, 504);
          }
          throw new AppError(ONBOARD_FAILED, `Tenant onboarding failed: ${errMsg}`, 500);
        } finally {
          channel.state = "done";
          channel.updatedAt = Date.parse(now());
        }

        if (workerResult.status === "failed") {
          const errMsg = workerResult.error ?? "Tenant onboarding failed";
          if (options.tenantStore.appendAuditEvent) {
            const audit: TenantAuditInput = {
              id: randomUUID(),
              timestamp: instant,
              actorUserId: caller.userId ?? null,
              actorType: caller.userId ? "user" : "system",
              tenantId,
              action: "tenant.onboard",
              targetType: "tenant",
              targetId: tenantId,
              before: existing ? { status: existing.status, id: existing.id } : null,
              after: { tenantId, totalFailed: workerResult.totalFailed ?? 1 },
              result: "failure",
              error: errMsg,
              source: "request",
              correlationId: (ctx.headers["x-correlation-id"] as string) ?? null,
            };
            await options.tenantStore.appendAuditEvent(audit);
          }
          throw new AppError(ONBOARD_FAILED, errMsg, 500);
        }

        if (workerResult.status === "partial") {
          const errMsg = workerResult.error ?? "Tenant onboarding partially failed";
          if (options.tenantStore.appendAuditEvent) {
            const audit: TenantAuditInput = {
              id: randomUUID(),
              timestamp: instant,
              actorUserId: caller.userId ?? null,
              actorType: caller.userId ? "user" : "system",
              tenantId,
              action: "tenant.onboard",
              targetType: "tenant",
              targetId: tenantId,
              before: existing ? { status: existing.status, id: existing.id } : null,
              after: {
                tenantId,
                clientId: workerResult.clientId ?? null,
                thumbprint: workerResult.certificateThumbprint ?? null,
                totalFailed: workerResult.totalFailed,
              },
              result: "failure",
              error: errMsg,
              source: "request",
              correlationId: (ctx.headers["x-correlation-id"] as string) ?? null,
            };
            await options.tenantStore.appendAuditEvent(audit);
          }
          throw new AppError(ONBOARD_PARTIAL_FAILURE, errMsg, 502);
        }

        // Write access was requested, so a successful run must have produced the
        // operator credential. Never report a reader-only success for an opt-in run.
        if (input.includeWritePermissions && !workerResult.operatorClientId) {
          throw new AppError(
            ONBOARD_PARTIAL_FAILURE,
            "onboarding reported success but did not provision the operator app; write access was not granted",
            502,
          );
        }

        // Success path: upsert tenant row and credential reference
        const tenantRecord: TenantRecord = {
          id: tenantId,
          displayName:
            input.displayName ?? workerResult.appDisplayName ?? existing?.displayName ?? null,
          defaultDomain: input.defaultDomain ?? existing?.defaultDomain ?? null,
          initialDomain: input.initialDomain ?? existing?.initialDomain ?? null,
          source: "direct",
          status: "active",
          excluded: false,
          excludeReason: null,
          excludeDate: null,
          environment: input.environment ?? existing?.environment ?? "commercial",
          lastRunAt: existing?.lastRunAt ?? null,
          errorCount: 0,
          lastError: null,
          createdAt: existing?.createdAt ?? instant,
          updatedAt: instant,
          deletedAt: null,
        };
        // Checked before any write so a misconfigured backend never leaves a tenant row with no
        // credential. The app registration already exists by now, so the PFX path is reported.
        if (
          (workerResult.certificatePath || workerResult.operatorCertificatePath) &&
          !options.secrets
        ) {
          const path = workerResult.certificatePath ?? workerResult.operatorCertificatePath;
          throw new AppError(
            ONBOARD_FAILED,
            `onboarding created an app registration with a PFX certificate at ${path}, but no credential backend is configured to store it`,
            500,
          );
        }
        const savedTenant = await options.tenantStore.upsertTenant(tenantRecord);

        if (options.credentialStore && workerResult.clientId && workerResult.certificatePath) {
          // The worker kept the private key in an owner-only PFX file. Only its path is stored,
          // in the credential backend; the database row holds just the reference.
          const secretRef = formatSecretRef(tenantId);
          await options.secrets!.writeSecret(
            secretRef,
            JSON.stringify({ certificatePath: workerResult.certificatePath }),
          );
          await options.credentialStore.upsertCredential({
            id: randomUUID(),
            tenantId,
            authMethod: "certificate-pfx",
            clientId: workerResult.clientId,
            secretRef,
            thumbprint: workerResult.certificateThumbprint ?? null,
            environment: input.environment ?? "commercial",
            expiresOn: null,
            lastValidated: instant,
            purpose: "reader",
            createdAt: instant,
            updatedAt: instant,
          });
        } else if (
          options.credentialStore &&
          workerResult.clientId &&
          workerResult.certificateThumbprint
        ) {
          await options.credentialStore.upsertCredential({
            id: randomUUID(),
            tenantId,
            authMethod: "certificate-thumbprint",
            clientId: workerResult.clientId,
            secretRef: formatThumbprintRef(workerResult.certificateThumbprint),
            thumbprint: workerResult.certificateThumbprint,
            environment: input.environment ?? "commercial",
            expiresOn: null,
            lastValidated: instant,
            purpose: "reader",
            createdAt: instant,
            updatedAt: instant,
          });
        }

        // Operator credential (T-0917): stored beside the reader row, never over it.
        // The worker reuses the reader certificate, so the same secret material and
        // thumbprint apply; only the purpose and client id differ.
        if (
          options.credentialStore &&
          workerResult.operatorClientId &&
          workerResult.operatorCertificatePath
        ) {
          const operatorSecretRef = formatSecretRef(tenantId);
          await options.secrets!.writeSecret(
            operatorSecretRef,
            JSON.stringify({ certificatePath: workerResult.operatorCertificatePath }),
          );
          await options.credentialStore.upsertCredential({
            id: randomUUID(),
            tenantId,
            authMethod: "certificate-pfx",
            clientId: workerResult.operatorClientId,
            secretRef: operatorSecretRef,
            thumbprint: workerResult.operatorCertificateThumbprint ?? null,
            environment: input.environment ?? "commercial",
            expiresOn: null,
            lastValidated: instant,
            purpose: "operator",
            createdAt: instant,
            updatedAt: instant,
          });
        } else if (
          options.credentialStore &&
          workerResult.operatorClientId &&
          workerResult.operatorCertificateThumbprint
        ) {
          await options.credentialStore.upsertCredential({
            id: randomUUID(),
            tenantId,
            authMethod: "certificate-thumbprint",
            clientId: workerResult.operatorClientId,
            secretRef: formatThumbprintRef(workerResult.operatorCertificateThumbprint),
            thumbprint: workerResult.operatorCertificateThumbprint,
            environment: input.environment ?? "commercial",
            expiresOn: null,
            lastValidated: instant,
            purpose: "operator",
            createdAt: instant,
            updatedAt: instant,
          });
        }

        if (options.tenantStore.appendAuditEvent) {
          const audit: TenantAuditInput = {
            id: randomUUID(),
            timestamp: instant,
            actorUserId: caller.userId ?? null,
            actorType: caller.userId ? "user" : "system",
            tenantId,
            action: "tenant.onboard",
            targetType: "tenant",
            targetId: tenantId,
            before: existing ? { status: existing.status, source: existing.source } : null,
            after: {
              tenantId,
              clientId: workerResult.clientId,
              thumbprint: workerResult.certificateThumbprint,
              appDisplayName: workerResult.appDisplayName,
              operatorClientId: workerResult.operatorClientId ?? null,
              writePermissionGroups: workerResult.writePermissionGroups ?? [],
              status: "active",
            },
            result: "success",
            error: null,
            source: "request",
            correlationId: (ctx.headers["x-correlation-id"] as string) ?? null,
          };
          await options.tenantStore.appendAuditEvent(audit);
        }

        return {
          status: 201,
          body: {
            tenant: savedTenant,
            onboarding: workerResult,
            progressId,
          },
        };
      },
    },
    {
      method: "GET",
      path: ONBOARD_PROGRESS_PATH,
      handler: async (ctx: RequestContext) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = extractTenantId(ctx);
        requireTenantInScope(caller, tenantId);
        await authorize(caller, ONBOARD_PERMISSION);

        const progressId = ctx.params["progressId"];
        if (typeof progressId !== "string" || progressId.trim().length === 0) {
          throw new AppError(ErrorCodes.validationFailed, "progress id is required", 400);
        }

        const sinceRaw = Number(ctx.query.get("since") ?? "0");
        const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;

        pruneChannels(now());
        const channel = channels.get(progressId);
        if (!channel || channel.tenantId !== tenantId) {
          // The wizard polls immediately after submitting, before the POST has created
          // the channel on a busy BFF; unknown is a normal answer, not an error.
          return { status: 200, body: { state: "unknown", events: [] } };
        }

        return {
          status: 200,
          body: {
            state: channel.state,
            events: channel.events.filter((event) => event.sequence > since),
          },
        };
      },
    },
  ];
}

export const ONBOARD_OPENAPI = {
  paths: {
    "/v1/tenants/{id}/onboard": {
      post: {
        operationId: "onboardTenant",
        summary: "Direct tenant onboarding with app registration and consent",
        permission: ONBOARD_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["confirmed"],
                properties: {
                  confirmed: { type: "boolean" },
                  adminUpn: { type: "string" },
                  appDisplayName: { type: "string" },
                  clientId: { type: "string" },
                  certificateThumbprint: { type: "string" },
                  createNew: { type: "boolean" },
                  includeWritePermissions: { type: "boolean" },
                  writePermissionGroups: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: ["identity", "security", "intune", "sharepoint", "exchange"],
                    },
                  },
                  confirmDangerous: { type: "boolean" },
                  displayName: { type: "string" },
                  defaultDomain: { type: "string" },
                  initialDomain: { type: "string" },
                  environment: { type: "string" },
                  progressId: {
                    type: "string",
                    description:
                      "Client-generated id for the device-code progress channel the wizard polls while onboarding waits for a sign-in (T-0916).",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Tenant onboarded successfully." },
          "400": { description: "Confirmation required or invalid input." },
          "401": { description: "Authentication required." },
          "403": { description: "Forbidden; tenants.onboard permission required." },
          "500": { description: "Onboarding failed." },
          "502": { description: "Partial onboarding failure." },
          "504": { description: "Onboarding exceeded the 30-minute job timeout while waiting for sign-in." },
        },
      },
    },
    "/v1/tenants/{id}/onboard/progress/{progressId}": {
      get: {
        operationId: "getOnboardProgress",
        summary: "Read pending device-code progress for an onboarding job",
        description:
          "Returns the sign-in events emitted by the onboarding worker since `since`. A pending device-code event carries the code and verification URL the wizard shows while the job waits (T-0916).",
        permission: ONBOARD_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "progressId", in: "path", required: true, schema: { type: "string" } },
          { name: "since", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Progress snapshot: state (unknown, pending, done) and new events." },
          "401": { description: "Authentication required." },
          "403": { description: "Forbidden; tenants.onboard permission required." },
        },
      },
    },
  },
} as const;
