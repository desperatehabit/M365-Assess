// Intune app upload queue API and job runner (EPIC-017 SPEC.md §3.2, §4.1, §6, §7, §8, §9; T-0323).
//
//   POST /v1/tenants/:tenantId/apps/upload                    — queue an upload (or preview its plan)
//   GET  /v1/tenants/:tenantId/apps/queue                     — per-item state from AppDeployment rows
//   POST /v1/tenants/:tenantId/apps/queue/:deploymentId/rerun — re-queue a failed item (SPEC §9)
//
// Writes follow the T-0108 gated-write seam: `Endpoint.Application.ReadWrite` or
// `Remediation.Apply`, a `preview` that plans without queueing, and an audit event for
// every state transition. The package must already be on the artifact tier (T-0322);
// the request names it by id and the worker receives only a signed, short-lived URL.
//
// `runAppUploadJob` is the queue-side half: it moves the AppDeployment row through
// queued → uploading → committing → succeeded/failed around the Queue-IntuneAppUpload
// worker, emits progress, and keeps the worker's resume point so a re-run continues
// the same Graph app instead of creating a duplicate.
import { randomUUID } from "node:crypto";
import { lookupAppType, supportedAppTypes } from "../domain/intune-app-types.js";
import { AppError, ErrorCodes } from "../errors.js";
import { RbacErrorCodes, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import {
  AppDeploymentValidationError,
  type AppDeployment,
  type AppDeploymentRepository,
  type AppDeploymentState,
  APP_DEPLOYMENT_STATES,
} from "../repository/app-deployments.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { AppPackageStore, StoredAppPackage } from "../storage/app-packages.js";
import { INTUNE_APPS_WRITE_PERMISSION } from "./intune-apps.js";

export const INTUNE_APPS_UPLOAD_PATH = "/v1/tenants/:tenantId/apps/upload";
export const INTUNE_APPS_QUEUE_PATH = "/v1/tenants/:tenantId/apps/queue";
export const INTUNE_APPS_QUEUE_RERUN_PATH = "/v1/tenants/:tenantId/apps/queue/:deploymentId/rerun";
export const INTUNE_APPS_QUEUE_READ_PERMISSION = "Endpoint.Application.Read";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
/** The worker entrypoint the job runner starts. */
export const APP_UPLOAD_ENTRYPOINT = "queue-intune-app-upload.ps1";

export const AppUploadErrorCodes = Object.freeze({
  packageNotFound: "app-upload.package_not_found",
  deploymentNotFound: "app-upload.deployment_not_found",
  notRerunnable: "app-upload.not_rerunnable",
});

const WIN32_RUN_AS = ["system", "user"] as const;
const WIN32_RESTART = ["allow", "basedOnReturnCode", "suppress", "force"] as const;
const WIN32_ARCHITECTURES = ["x86", "x64", "arm64"] as const;
const DETECTION_TYPES = ["msi", "file", "registry", "script"] as const;

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

export type AppDetectionRule = Record<string, unknown> & { readonly type: (typeof DETECTION_TYPES)[number] };

export interface Win32AppUploadRequest {
  readonly appType: "win32";
  readonly packageId: string;
  readonly displayName: string;
  readonly description: string;
  readonly publisher: string;
  readonly installCommandLine: string;
  readonly uninstallCommandLine: string;
  readonly runAsAccount: (typeof WIN32_RUN_AS)[number];
  readonly deviceRestartBehavior: (typeof WIN32_RESTART)[number];
  readonly applicableArchitectures: readonly (typeof WIN32_ARCHITECTURES)[number][];
  readonly minimumSupportedWindowsRelease: string;
  readonly detectionRules: readonly AppDetectionRule[];
}

export interface StoreAppUploadRequest {
  readonly appType: "store";
  readonly packageIdentifier: string;
  readonly displayName: string;
  readonly description: string;
  readonly publisher: string;
  readonly runAsAccount: (typeof WIN32_RUN_AS)[number];
}

export type AppUploadRequest = Win32AppUploadRequest | StoreAppUploadRequest;

// ---------------------------------------------------------------------------
// Queue view
// ---------------------------------------------------------------------------

export interface AppUploadStep {
  readonly step: string;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly error?: string;
}

export interface AppQueueItem {
  readonly deploymentId: string;
  readonly appType: string;
  readonly displayName: string;
  readonly state: AppDeploymentState;
  readonly rerunnable: boolean;
  readonly appId: string | null;
  readonly steps: readonly AppUploadStep[];
  readonly error: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** What the queue receives: references only (ADR-0014), never a URL, path, or bytes. */
export interface AppUploadJob {
  readonly jobId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly correlationId: string;
}

export interface AppUploadQueue {
  enqueue(job: AppUploadJob): Promise<string>;
}

export interface AppUploadCaller extends Caller {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

export type AppUploadAuthorizer = (caller: AppUploadCaller, permission: string) => boolean;

export type AppUploadPackageStore = Pick<AppPackageStore, "getPackage" | "createSignedUrl">;

export interface IntuneAppsQueueRoutesOptions {
  readonly repository: AppDeploymentRepository;
  readonly packages: AppUploadPackageStore;
  readonly queue: AppUploadQueue;
  readonly resolveCaller: (ctx: RequestContext) => AppUploadCaller | undefined;
  readonly authorize?: AppUploadAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function invalid(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function text(body: Record<string, unknown>, field: string, options: { required?: boolean; max?: number } = {}): string {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === "") {
    if (options.required) throw invalid(`${field} is required`, field, "required");
    return "";
  }
  if (typeof raw !== "string") throw invalid(`${field} must be a string`, field);
  const value = raw.trim();
  if (options.required && value.length === 0) throw invalid(`${field} is required`, field, "required");
  if (value.length > (options.max ?? 1024)) throw invalid(`${field} is too long`, field, "too-long");
  return value;
}

function oneOf<T extends string>(body: Record<string, unknown>, field: string, allowed: readonly T[], fallback: T): T {
  const raw = body[field] ?? fallback;
  if (!(allowed as readonly unknown[]).includes(raw)) {
    throw invalid(`${field} must be one of: ${allowed.join(", ")}`, field);
  }
  return raw as T;
}

function parseDetectionRules(body: Record<string, unknown>): AppDetectionRule[] {
  const raw = body["detectionRules"];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalid("win32 apps need at least one detection rule", "detectionRules", "required");
  }
  return raw.map((rule, i) => {
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
      throw invalid(`detectionRules[${i}] must be an object`, "detectionRules");
    }
    const type = (rule as Record<string, unknown>)["type"];
    if (!(DETECTION_TYPES as readonly unknown[]).includes(type)) {
      throw invalid(`detectionRules[${i}].type must be one of: ${DETECTION_TYPES.join(", ")}`, "detectionRules");
    }
    return rule as AppDetectionRule;
  });
}

export function parseAppUploadRequest(input: unknown): AppUploadRequest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("Request body must be a JSON object", "body");
  }
  const body = input as Record<string, unknown>;
  const appType = typeof body["appType"] === "string" ? body["appType"].trim().toLowerCase() : "";
  const entry = lookupAppType(appType);
  if (!entry) throw invalid(`appType must be one of: ${supportedAppTypes().join(", ")}`, "appType");
  if (!entry.supported) {
    throw new AppError(
      "intune.app-type.unsupported",
      `app type '${appType}' is not yet supported; supported types in v1: ${supportedAppTypes().join(", ")}`,
      501,
    );
  }

  const common = {
    displayName: text(body, "displayName", { required: true, max: 256 }),
    description: text(body, "description", { max: 10_000 }),
    publisher: text(body, "publisher", { required: true, max: 256 }),
    runAsAccount: oneOf(body, "runAsAccount", WIN32_RUN_AS, "system"),
  };

  if (appType === "store") {
    return {
      appType: "store",
      packageIdentifier: text(body, "packageIdentifier", { required: true, max: 64 }),
      ...common,
    };
  }

  const architectures = body["applicableArchitectures"] ?? ["x64"];
  if (
    !Array.isArray(architectures) ||
    architectures.length === 0 ||
    !architectures.every((a) => (WIN32_ARCHITECTURES as readonly unknown[]).includes(a))
  ) {
    throw invalid(`applicableArchitectures must list: ${WIN32_ARCHITECTURES.join(", ")}`, "applicableArchitectures");
  }
  return {
    appType: "win32",
    packageId: text(body, "packageId", { required: true, max: 128 }),
    installCommandLine: text(body, "installCommandLine", { required: true }),
    uninstallCommandLine: text(body, "uninstallCommandLine", { required: true }),
    deviceRestartBehavior: oneOf(body, "deviceRestartBehavior", WIN32_RESTART, "basedOnReturnCode"),
    applicableArchitectures: [...new Set(architectures as Win32AppUploadRequest["applicableArchitectures"])],
    minimumSupportedWindowsRelease: text(body, "minimumSupportedWindowsRelease") || "1607",
    detectionRules: parseDetectionRules(body),
    ...common,
  };
}

/** The steps the worker runs for a request, in order (the preview plan). */
export function planAppUpload(request: AppUploadRequest, resumeAppId?: string | null): string[] {
  if (request.appType === "store") return ["createApp"];
  return [
    resumeAppId ? "reuseApp" : "createApp",
    "downloadPackage",
    "createContentVersion",
    "createContentFile",
    "uploadContent",
    "commitContentFile",
    "setCommittedContentVersion",
  ];
}

// ---------------------------------------------------------------------------
// Queue view helpers
// ---------------------------------------------------------------------------

function asSteps(value: unknown): AppUploadStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
    .map((s) => ({
      step: String(s["step"] ?? ""),
      status: (["succeeded", "failed", "skipped"].includes(String(s["status"]))
        ? String(s["status"])
        : "failed") as AppUploadStep["status"],
      ...(typeof s["error"] === "string" ? { error: s["error"] } : {}),
    }));
}

export function toQueueItem(deployment: AppDeployment): AppQueueItem {
  const results = deployment.results ?? {};
  return {
    deploymentId: deployment.id,
    appType: deployment.appType,
    displayName: String(deployment.payload["displayName"] ?? ""),
    state: deployment.state,
    rerunnable: deployment.state === "failed",
    appId: typeof results["appId"] === "string" ? results["appId"] : null,
    steps: asSteps(results["steps"]),
    error: typeof results["error"] === "string" ? results["error"] : null,
    createdBy: deployment.createdBy,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function requireCaller(options: IntuneAppsQueueRoutesOptions, ctx: RequestContext): AppUploadCaller {
  const caller = options.resolveCaller(ctx);
  if (caller === undefined) throw new AppError("request.unauthenticated", "authentication required", 401);
  return caller;
}

function defaultAuthorize(caller: AppUploadCaller, permission: string): boolean {
  const granted = caller.permissions ?? [];
  return granted.includes(permission) || granted.includes("*");
}

function authorizeWrite(options: IntuneAppsQueueRoutesOptions, caller: AppUploadCaller): void {
  const authorize = options.authorize ?? defaultAuthorize;
  if (!authorize(caller, INTUNE_APPS_WRITE_PERMISSION) && !authorize(caller, REMEDIATION_APPLY_PERMISSION)) {
    throw new AppError(
      RbacErrorCodes.forbidden,
      `forbidden: requires ${INTUNE_APPS_WRITE_PERMISSION} or ${REMEDIATION_APPLY_PERMISSION}`,
      403,
    );
  }
}

function authorizeRead(options: IntuneAppsQueueRoutesOptions, caller: AppUploadCaller): void {
  const authorize = options.authorize ?? defaultAuthorize;
  if (
    !authorize(caller, INTUNE_APPS_QUEUE_READ_PERMISSION) &&
    !authorize(caller, INTUNE_APPS_WRITE_PERMISSION)
  ) {
    throw new AppError(RbacErrorCodes.forbidden, `forbidden: missing ${INTUNE_APPS_QUEUE_READ_PERMISSION}`, 403);
  }
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name]?.trim();
  if (!value) throw invalid(`${name} is required`, name, "required");
  return value;
}

function actorOf(caller: AppUploadCaller): string {
  return caller.userId ?? "unknown";
}

async function audit(
  options: IntuneAppsQueueRoutesOptions,
  event: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const full = {
    id: (options.newId ?? randomUUID)(),
    timestamp: (options.now?.() ?? new Date()).toISOString(),
    ...event,
  };
  await options.recordAudit?.(full);
  return full;
}

function parseStateFilter(query: URLSearchParams): AppDeploymentState | undefined {
  const raw = query.get("state")?.trim();
  if (!raw) return undefined;
  if (!(APP_DEPLOYMENT_STATES as readonly string[]).includes(raw)) {
    throw invalid(`state must be one of: ${APP_DEPLOYMENT_STATES.join(", ")}`, "state");
  }
  return raw as AppDeploymentState;
}

export function createIntuneAppsQueueRoutes(options: IntuneAppsQueueRoutesOptions): Route[] {
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? (() => new Date());

  return [
    {
      method: "POST",
      path: INTUNE_APPS_UPLOAD_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options, ctx);
        const tenantId = requireParam(ctx, "tenantId");
        requireTenantInScope(caller, tenantId);
        authorizeWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const request = parseAppUploadRequest(body);
        let stored: StoredAppPackage | undefined;
        if (request.appType === "win32") {
          stored = await options.packages.getPackage(tenantId, request.packageId);
          if (!stored) {
            throw new AppError(AppUploadErrorCodes.packageNotFound, `app package '${request.packageId}' not found`, 404);
          }
        }
        const steps = planAppUpload(request);
        const preview = body["preview"] === true || ctx.query.get("preview") === "true";
        if (preview) {
          return {
            status: 200,
            body: {
              preview: true,
              tenantId,
              appType: request.appType,
              displayName: request.displayName,
              steps,
              ...(stored ? { package: { fileName: stored.fileName, size: stored.size, sha256: stored.sha256 } } : {}),
            },
          };
        }

        const deploymentId = newId();
        let deployment: AppDeployment;
        try {
          deployment = await options.repository.createDeployment({
            id: deploymentId,
            tenantId,
            appType: request.appType,
            payload: { ...request },
            createdBy: actorOf(caller),
            createdAt: now().toISOString(),
          });
        } catch (error) {
          if (error instanceof AppDeploymentValidationError) throw invalid(error.message, "body");
          throw error;
        }
        await audit(options, {
          tenantId,
          action: "intune.app.upload.queued",
          targetId: deploymentId,
          targetName: request.displayName,
          actor: actorOf(caller),
          to: "queued",
        });
        const jobId = await options.queue.enqueue({
          jobId: newId(),
          tenantId,
          deploymentId,
          correlationId: ctx.correlationId,
        });
        return { status: 202, body: { deploymentId, jobId, state: deployment.state, steps } };
      },
    },

    {
      method: "GET",
      path: INTUNE_APPS_QUEUE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options, ctx);
        const tenantId = requireParam(ctx, "tenantId");
        requireTenantInScope(caller, tenantId);
        authorizeRead(options, caller);
        const state = parseStateFilter(ctx.query);
        const deployments = await options.repository.listDeployments(tenantId, state ? { state } : {});
        const items = deployments.map(toQueueItem);
        return { status: 200, body: { tenantId, totalCount: items.length, items } };
      },
    },

    {
      method: "POST",
      path: INTUNE_APPS_QUEUE_RERUN_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options, ctx);
        const tenantId = requireParam(ctx, "tenantId");
        requireTenantInScope(caller, tenantId);
        authorizeWrite(options, caller);
        const deploymentId = requireParam(ctx, "deploymentId");

        const current = await options.repository.getDeployment(tenantId, deploymentId);
        if (!current) {
          throw new AppError(AppUploadErrorCodes.deploymentNotFound, `app deployment '${deploymentId}' not found`, 404);
        }
        if (current.state !== "failed") {
          throw new AppError(
            AppUploadErrorCodes.notRerunnable,
            `only failed uploads can be re-run; this one is '${current.state}'`,
            409,
          );
        }
        let requeued: AppDeployment | undefined;
        try {
          requeued = await options.repository.transitionDeployment(tenantId, deploymentId, "queued", now().toISOString());
        } catch (error) {
          if (error instanceof AppDeploymentValidationError) {
            throw new AppError(AppUploadErrorCodes.notRerunnable, error.message, 409);
          }
          throw error;
        }
        await audit(options, {
          tenantId,
          action: "intune.app.upload.rerun",
          targetId: deploymentId,
          targetName: String(current.payload["displayName"] ?? ""),
          actor: actorOf(caller),
          from: "failed",
          to: "queued",
        });
        const jobId = await options.queue.enqueue({
          jobId: newId(),
          tenantId,
          deploymentId,
          correlationId: ctx.correlationId,
        });
        return { status: 202, body: { deploymentId, jobId, state: requeued!.state } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------

/** What the worker prints (Queue-IntuneAppUpload.ps1). */
export interface AppUploadWorkerResult {
  readonly state: "succeeded" | "failed";
  readonly appId?: string | null;
  readonly contentVersionId?: string | null;
  readonly steps?: readonly AppUploadStep[];
  readonly error?: string | null;
  readonly auditEvents?: readonly Record<string, unknown>[];
}

/** Coarse progress for the Queued Applications page; carries ids and states only. */
export interface AppUploadProgress {
  readonly jobId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly correlationId: string;
  readonly at: string;
  readonly state: AppDeploymentState;
  readonly message?: string;
}

export interface RunAppUploadJobOptions {
  readonly repository: AppDeploymentRepository;
  readonly packages: AppUploadPackageStore;
  /** Absolute origin the worker reaches the BFF on, e.g. http://127.0.0.1:8080. */
  readonly packageBaseUrl: string;
  /** Runs the worker entrypoint with a job document and returns its parsed JSON. */
  readonly runWorker: (entrypoint: string, job: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  readonly onProgress?: (event: AppUploadProgress) => void;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly packageUrlTtlSeconds?: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly signal?: AbortSignal;
}

function asWorkerResult(value: unknown): AppUploadWorkerResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { state: "failed", error: "worker returned no result" };
  }
  const record = value as Record<string, unknown>;
  return {
    state: record["state"] === "succeeded" ? "succeeded" : "failed",
    appId: typeof record["appId"] === "string" ? record["appId"] : null,
    contentVersionId: typeof record["contentVersionId"] === "string" ? record["contentVersionId"] : null,
    steps: asSteps(record["steps"]),
    error: typeof record["error"] === "string" ? record["error"] : null,
    auditEvents: Array.isArray(record["auditEvents"])
      ? (record["auditEvents"] as unknown[]).filter(
          (e): e is Record<string, unknown> => e !== null && typeof e === "object" && !Array.isArray(e),
        )
      : [],
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one queued upload. The row must be `queued`; anything else (cancelled, already
 * running, gone) is left alone. Returns the final deployment row.
 */
export async function runAppUploadJob(
  job: AppUploadJob,
  options: RunAppUploadJobOptions,
): Promise<AppDeployment | undefined> {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const newId = options.newId ?? randomUUID;
  const { repository } = options;

  const move = async (
    state: AppDeploymentState,
    results?: Record<string, unknown> | null,
    message?: string,
  ): Promise<AppDeployment | undefined> => {
    const at = now();
    const before = await repository.getDeployment(job.tenantId, job.deploymentId);
    const after = await repository.transitionDeployment(job.tenantId, job.deploymentId, state, at, results);
    options.onProgress?.({
      jobId: job.jobId,
      tenantId: job.tenantId,
      deploymentId: job.deploymentId,
      correlationId: job.correlationId,
      at,
      state,
      ...(message ? { message } : {}),
    });
    await options.recordAudit?.({
      id: newId(),
      timestamp: at,
      tenantId: job.tenantId,
      action: `intune.app.upload.${state}`,
      targetId: job.deploymentId,
      targetName: String(after?.payload["displayName"] ?? ""),
      actor: "system",
      from: before?.state ?? null,
      to: state,
      jobId: job.jobId,
    });
    return after;
  };

  const deployment = await repository.getDeployment(job.tenantId, job.deploymentId);
  if (!deployment || deployment.state !== "queued") return deployment;

  // Keep the previous attempt's app id so a re-run reuses the Graph app.
  const resumeAppId =
    deployment.results && typeof deployment.results["appId"] === "string" ? deployment.results["appId"] : null;
  await move("uploading", deployment.results);

  const workerJob: Record<string, unknown> = {
    tenantId: job.tenantId,
    deploymentId: job.deploymentId,
    appType: deployment.appType,
    app: deployment.payload,
    actor: deployment.createdBy,
    resumeAppId,
  };

  let result: AppUploadWorkerResult;
  try {
    if (deployment.appType === "win32") {
      const packageId = String(deployment.payload["packageId"] ?? "");
      const stored = await options.packages.getPackage(job.tenantId, packageId);
      if (!stored) throw new Error(`app package '${packageId}' is no longer on the artifact tier`);
      const signed = await options.packages.createSignedUrl(job.tenantId, packageId, options.packageUrlTtlSeconds);
      workerJob["packageUrl"] = new URL(signed.url, options.packageBaseUrl).toString();
      workerJob["packageSize"] = stored.size;
      workerJob["packageSha256"] = stored.sha256;
    }
    result = asWorkerResult(await options.runWorker(APP_UPLOAD_ENTRYPOINT, workerJob, options.signal));
  } catch (error) {
    result = { state: "failed", appId: resumeAppId, steps: [], error: errorText(error), auditEvents: [] };
  }

  for (const event of result.auditEvents ?? []) await options.recordAudit?.(event);

  const results: Record<string, unknown> = {
    appId: result.appId ?? resumeAppId,
    contentVersionId: result.contentVersionId ?? null,
    steps: result.steps ?? [],
    error: result.error ?? null,
  };
  if (result.state === "failed") {
    return move("failed", results, result.error ?? "upload failed");
  }
  // The worker uploads and commits in one process, so `committing` is recorded when its
  // verified commit comes back; the row still passes through every queue state.
  await move("committing", results);
  return move("succeeded", results);
}
