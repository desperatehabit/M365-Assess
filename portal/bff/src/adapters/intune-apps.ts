// EPIC-017 worker-backed providers and the app upload queue (T-0844).
//
// Each provider turns a route's typed call into a feature-worker job (tenant id, the tenant's
// credential block, and the worker's own fields), runs the entrypoint, and returns the
// worker's JSON. Workers that report `{ error, message, statusCode }` either have it raised
// here (reads the route does not inspect) or passed through (writes whose routes map it).
//
// App uploads run on their own JobQueue under the `app-upload` job type: the upload route
// enqueues a reference-only envelope, and the runner drives runAppUploadJob, which records
// every state on the AppDeployment row. The queue does not feed the assessment-run progress
// hub; the Queued Applications page reads the deployment rows.
import type { JobEnvelope, ResultEnvelope } from "@m365-assess/contracts";
import { AppError } from "../errors.js";
import type { RunWorkerFn } from "../jobs/queue.js";
import type { AppDeploymentRepository } from "../repository/app-deployments.js";
import type { AppPackageStore } from "../storage/app-packages.js";
import type { IntuneAppsFilter, IntuneAppsPage, IntuneAppsProvider } from "../routes/intune-apps.js";
import type { IntuneAppCrudProvider } from "../routes/intune-apps-crud.js";
import type { AppAssignmentProvider, AppAssignmentWorkerResult } from "../routes/intune-apps-assign.js";
import { runAppUploadJob, type AppUploadJob, type AppUploadQueue } from "../routes/intune-apps-queue.js";
import type { TemplatePreflightProvider, TemplatePreflightResult, TemplateVariableScopes } from "../routes/application-templates.js";
import type { AutopilotProvider } from "../routes/autopilot.js";
import type { AutopilotProfileWriteProvider } from "../routes/autopilot-profiles-write.js";
import type { EnrollmentProfileProvider, EnrollmentProfilesList } from "../routes/enrollment-profiles.js";
import type { AppStatusProvider, RawAppDeviceStatus, RawEnrollmentDeviceStatus } from "../routes/intune-app-status.js";
import type { TenantVariableStore } from "../routes/tenant-variables.js";
import { asArray, raiseWorkerError, type TenantWorkerCall } from "./workers.js";

export const APP_UPLOAD_JOB_TYPE = "app-upload" as const;
export const APP_PACKAGES_UNCONFIGURED = "app-package.unconfigured";

export interface IntuneAppProviders {
  readonly apps: IntuneAppsProvider;
  readonly crud: IntuneAppCrudProvider;
  readonly assign: AppAssignmentProvider;
  readonly templatePreflight: TemplatePreflightProvider;
  readonly autopilot: AutopilotProvider;
  readonly autopilotWrite: AutopilotProfileWriteProvider;
  readonly enrollment: EnrollmentProfileProvider;
  readonly status: AppStatusProvider;
}

export function createIntuneAppProviders(call: TenantWorkerCall): IntuneAppProviders {
  return {
    apps: {
      async listApps(tenantId, filter: IntuneAppsFilter) {
        const page = await call<IntuneAppsPage>("get-intune-apps.ps1", tenantId, {
          view: filter.view,
          ...(filter.appType ? { appType: filter.appType } : {}),
          ...(filter.assigned !== undefined ? { assigned: filter.assigned } : {}),
          ...(filter.search ? { search: filter.search } : {}),
          top: filter.limit,
          ...(filter.cursor ? { cursor: filter.cursor } : {}),
        });
        raiseWorkerError(page);
        // A one-item list arrives unrolled from PowerShell; normalise both arrays.
        const items = asArray<unknown>(page.items as unknown[]);
        return { ...page, items, ...("unsupported" in page ? { unsupported: asArray(page.unsupported) } : {}) } as IntuneAppsPage;
      },
    },

    crud: {
      getApp: (tenantId, appId) => call("set-intune-app.ps1", tenantId, { action: "get", appId }),
      changeApp: (tenantId, appId, request) =>
        call("set-intune-app.ps1", tenantId, {
          action: request.action,
          appId,
          ...(request.changes ? { changes: request.changes } : {}),
          ...(request.confirmName !== undefined ? { confirmName: request.confirmName } : {}),
          preview: request.preview,
          actor: request.actor,
        }),
    },

    assign: {
      assign: (tenantId, appId, request) =>
        call<AppAssignmentWorkerResult>("set-intune-app-assignment.ps1", tenantId, {
          appId,
          assignments: request.assignments,
          mode: request.mode,
          preview: request.preview,
          ...(request.confirmPlan ? { confirmPlan: request.confirmPlan } : {}),
          actor: request.actor,
        }),
    },

    templatePreflight: {
      preflight: (tenantId, config, values) =>
        call<TemplatePreflightResult>("deploy-application-template.ps1", tenantId, { config, values }),
    },

    autopilot: {
      async listDevices(tenantId, filter) {
        const page = await call<{ totalCount: number; items: unknown; nextCursor: string | null }>("import-autopilot-devices.ps1", tenantId, {
          action: "list-devices",
          ...(filter.search ? { search: filter.search } : {}),
          ...(filter.groupTag ? { groupTag: filter.groupTag } : {}),
          ...(filter.enrollmentState ? { enrollmentState: filter.enrollmentState } : {}),
          top: filter.limit,
          ...(filter.cursor ? { cursor: filter.cursor } : {}),
        });
        raiseWorkerError(page);
        return { totalCount: page.totalCount, items: asArray(page.items as never), nextCursor: page.nextCursor };
      },
      getDevice: (tenantId, deviceId) => call("import-autopilot-devices.ps1", tenantId, { action: "get-device", deviceId }),
      async listProfiles(tenantId) {
        const page = await call<{ totalCount: number; items: unknown }>("import-autopilot-devices.ps1", tenantId, { action: "list-profiles" });
        raiseWorkerError(page);
        return { totalCount: page.totalCount, items: asArray(page.items as never) };
      },
      importDevices: (tenantId, request) =>
        call("import-autopilot-devices.ps1", tenantId, {
          action: "import",
          source: request.source,
          ...(request.rows ? { rows: request.rows } : {}),
          ...(request.csv !== undefined ? { csv: request.csv } : {}),
          preview: request.preview,
          actor: request.actor,
        }),
    },

    autopilotWrite: {
      write: (tenantId, request) =>
        call("set-autopilot-profile.ps1", tenantId, {
          action: request.action,
          ...(request.profileId ? { profileId: request.profileId } : {}),
          ...(request.profile ? { profile: request.profile } : {}),
          ...(request.addGroupIds ? { addGroupIds: request.addGroupIds } : {}),
          ...(request.removeGroupIds ? { removeGroupIds: request.removeGroupIds } : {}),
          ...(request.confirmName !== undefined ? { confirmName: request.confirmName } : {}),
          preview: request.preview,
          actor: request.actor,
        }),
    },

    enrollment: {
      async list(tenantId) {
        const list = await call<EnrollmentProfilesList>("set-enrollment-profile.ps1", tenantId, { action: "list" });
        raiseWorkerError(list);
        return { profiles: asArray(list.profiles), tokens: asArray(list.tokens) };
      },
      write: (tenantId, request) =>
        call("set-enrollment-profile.ps1", tenantId, {
          action: request.action,
          platform: request.platform,
          ...(request.depOnboardingSettingId ? { depOnboardingSettingId: request.depOnboardingSettingId } : {}),
          ...(request.profileId ? { profileId: request.profileId } : {}),
          ...(request.profile ? { profile: request.profile } : {}),
          ...(request.serialNumbers ? { serialNumbers: request.serialNumbers } : {}),
          ...(request.confirmName !== undefined ? { confirmName: request.confirmName } : {}),
          preview: request.preview,
          actor: request.actor,
        }),
    },

    status: {
      async appDeviceStatuses(tenantId) {
        const result = await call<{ items: unknown }>("get-intune-app-status.ps1", tenantId, { action: "apps" });
        raiseWorkerError(result);
        return asArray(result.items as RawAppDeviceStatus[]);
      },
      async enrollmentStatuses(tenantId) {
        const result = await call<{ items: unknown }>("get-intune-app-status.ps1", tenantId, { action: "enrollment" });
        raiseWorkerError(result);
        return asArray(result.items as RawEnrollmentDeviceStatus[]);
      },
    },
  };
}

/** Global and tenant variables for a tenant, from the EPIC-002 tenant-variable store. */
export function createTemplateVariableReader(store: Pick<TenantVariableStore, "listVariables">) {
  return async (tenantId: string): Promise<TemplateVariableScopes> => {
    const rows = await store.listVariables();
    const pick = (predicate: (row: (typeof rows)[number]) => boolean) =>
      rows.filter(predicate).map((row) => ({ name: row.name, value: row.value, isSecret: row.isSecret }));
    return { global: pick((row) => row.tenantId === null), tenant: pick((row) => row.tenantId === tenantId) };
  };
}

type PackageStoreSurface = Pick<AppPackageStore, "storePackage" | "verifySignedUrl" | "openPackage" | "getPackage" | "createSignedUrl" | "maxBytes">;

/**
 * Stands in for the package store when no signing secret is configured, so every package
 * operation explains itself with a 503 instead of a missing route or a silent 404.
 */
export function unconfiguredPackageStore(maxBytes: number): PackageStoreSurface {
  const refuse = (): never => {
    throw new AppError(APP_PACKAGES_UNCONFIGURED, "app packages are not configured: set M365_BFF_APP_PACKAGE_SECRET", 503);
  };
  return {
    maxBytes,
    storePackage: async () => refuse(),
    openPackage: async () => refuse(),
    getPackage: async () => refuse(),
    createSignedUrl: async () => refuse(),
    verifySignedUrl: () => refuse(),
  };
}

/** Enqueues upload jobs on `queue` as reference-only `app-upload` envelopes. */
export function createAppUploadQueue(queue: { enqueue(envelope: unknown): Promise<string> }, now: () => Date = () => new Date()): AppUploadQueue {
  return {
    enqueue: (job: AppUploadJob) =>
      queue.enqueue({
        schemaVersion: "v1",
        jobId: job.jobId,
        jobType: APP_UPLOAD_JOB_TYPE,
        tenantId: job.tenantId,
        runId: job.deploymentId,
        requestId: job.jobId,
        correlationId: job.correlationId,
        createdAt: now().toISOString(),
        payload: {
          contextRef: `app-deployments/${job.deploymentId}`,
          outputRef: `app-deployments/${job.deploymentId}`,
          credentialRef: `tenants/${job.tenantId}/credential`,
          sectionRefs: [],
          artifactRefs: [],
        },
      }),
  };
}

export interface AppUploadRunnerOptions {
  readonly call: TenantWorkerCall;
  readonly repository: AppDeploymentRepository;
  readonly packages: Pick<AppPackageStore, "getPackage" | "createSignedUrl">;
  readonly packageBaseUrl: string;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly now?: () => Date;
}

/** The queue runner for `app-upload` jobs: one runAppUploadJob per envelope. */
export function createAppUploadRunner(options: AppUploadRunnerOptions): RunWorkerFn {
  const now = options.now ?? (() => new Date());
  return async (envelope: JobEnvelope, signal: AbortSignal): Promise<ResultEnvelope> => {
    const startedAt = now().toISOString();
    const deploymentId = envelope.payload.contextRef.replace(/^app-deployments\//, "");
    const final = await runAppUploadJob(
      { jobId: envelope.jobId, tenantId: envelope.tenantId, deploymentId, correlationId: envelope.correlationId },
      {
        repository: options.repository,
        packages: options.packages,
        packageBaseUrl: options.packageBaseUrl,
        runWorker: (entrypoint, job) => {
          const { tenantId: _tenant, ...fields } = job;
          return options.call(entrypoint, envelope.tenantId, fields);
        },
        ...(options.recordAudit ? { recordAudit: options.recordAudit } : {}),
        signal,
      },
    );
    const succeeded = final?.state === "succeeded";
    const error = final?.results?.["error"];
    return {
      schemaVersion: "v1",
      jobId: envelope.jobId,
      jobType: envelope.jobType,
      tenantId: envelope.tenantId,
      runId: envelope.runId,
      requestId: envelope.requestId,
      correlationId: envelope.correlationId,
      status: succeeded ? "succeeded" : "failed",
      startedAt,
      finishedAt: now().toISOString(),
      exitCode: succeeded ? 0 : 1,
      artifactRefs: [],
      ...(succeeded
        ? {}
        : {
            error: {
              code: "app-upload.failed",
              message: typeof error === "string" ? error : `deployment is ${final?.state ?? "missing"}`,
              retryable: final?.state === "failed",
            },
          }),
    };
  };
}
