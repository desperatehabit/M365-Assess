// Composition root (T-0817).
//
// Builds everything the HTTP server serves: one SQLite database, the shared
// authorizer, the authenticators, and the route list. Route modules stay free of
// wiring; this file is the only place that knows which store backs which route.
//
// Storage: the @m365-assess/db migrations run once on the shared connection, then the
// db repositories and the BFF's own repositories share it. Worker-backed runners call
// PowerShell entrypoints through runFeatureWorker (T-0815). Areas whose route stores
// had no implementation were mounted by T-0818..T-0825.
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_STANDARDS_REGISTRY_PATH,
  SqliteBaselinesRepository,
  SqliteBecFindingRepository,
  SqliteCustomScriptRepository,
  SqliteDashboardLayoutRepository,
  SqliteDashboardRepository,
  SqliteDriftRepository,
  SqliteJitRepository,
  SqliteJitTemplatesRepository,
  SqliteOffboardingRepository,
  SqlitePimSettingsRepository,
  SqliteRbacRepository,
  SqliteRemediationRepository,
  SqliteReportRepository,
  SqliteReportTemplateRepository,
  SqliteRepository,
  SqliteRoleRequestsRepository,
  SqliteScheduleRepository,
  SqliteStandardsRepository,
  SqliteTapRecordRepository,
  SqliteUserTemplateRepository,
  loadMigrations,
  runMigrations,
} from "@m365-assess/db";
import type { JobType } from "@m365-assess/contracts";
import { parseReportTemplate } from "@m365-assess/contracts/reports";
import Database from "better-sqlite3";
import {
  createCredentialRowStore,
  createGdapRelationshipStore,
  createTenantGroupStore,
  createTenantStore,
  createTenantVariableStore,
} from "./adapters/tenants.js";
import { createAuditSink, type RecordAudit } from "./adapters/audit.js";
import {
  createJobBackedRemediationIdempotencyStore,
  createRemediationStore,
  createScheduleHistoryStore,
  createRemediationQueue,
  createRemediationWorkerRunner,
  withRemediationApplyIngestion,
  createRunnerValidatingScheduleStore,
  createScheduleJobStateStore,
  createScheduleRunQueue,
  createScriptSandbox,
  createTickScheduleStore,
  withRemediationPlanIngestion,
  withRemediationVerifyIngestion,
} from "./adapters/automation.js";
import {
  createBaselineAdvanceStore,
  createBaselineAlignmentStore,
  createBaselineEvaluationRunner,
  createBaselineHistory,
  createBaselinesFleetStore,
  createBaselinesMigrateStore,
  createBaselinesStore,
} from "./adapters/baselines.js";
import { createCaProviders } from "./adapters/conditional-access.js";
import {
  createDriftDeletionPort,
  createDriftRefresh,
  createDriftStore,
  createDriftTriageStore,
  withDriftIngestion,
} from "./adapters/drift.js";
import { createGroupProviders } from "./adapters/groups.js";
import { createIntuneProviders } from "./adapters/intune.js";
import {
  APP_UPLOAD_JOB_TYPE,
  createAppUploadQueue,
  createAppUploadRunner,
  createIntuneAppProviders,
  createTemplateVariableReader,
  unconfiguredPackageStore,
} from "./adapters/intune-apps.js";
import { SqliteAppDeploymentRepository } from "./repository/app-deployments.js";
import { SqliteApplicationTemplateRepository } from "./repository/application-templates.js";
import { SqliteAutopilotProfileTemplateRepository } from "./repository/autopilot-profiles.js";
import { SqliteEnrollmentProfileTemplateRepository } from "./repository/enrollment-profile-templates.js";
import { createAppPackageRoutes } from "./routes/app-packages.js";
import { createApplicationTemplateRoutes } from "./routes/application-templates.js";
import { createAutopilotRoutes } from "./routes/autopilot.js";
import { createAutopilotProfileWriteRoutes } from "./routes/autopilot-profiles-write.js";
import { createEnrollmentProfileRoutes } from "./routes/enrollment-profiles.js";
import { createIntuneAppStatusRoutes } from "./routes/intune-app-status.js";
import { createIntuneAppsRoutes } from "./routes/intune-apps.js";
import { createIntuneAppAssignRoute } from "./routes/intune-apps-assign.js";
import { createIntuneAppCrudRoutes } from "./routes/intune-apps-crud.js";
import { createIntuneAppsQueueRoutes } from "./routes/intune-apps-queue.js";
import { AppPackageStore } from "./storage/app-packages.js";
import {
  createApiClientStore,
  createPortalUserStore,
  createRolesStore,
} from "./adapters/rbac.js";
import {
  createGeneratedReportStore,
  createReportRunReader,
  createRenderQueue,
  createReportWorkerRunner,
  createTemplateRender,
  withReportCompletion,
} from "./adapters/reports.js";
import { createActiveGrantsResolver, createRoleProviders } from "./adapters/roles.js";
import {
  createStandardsAlignmentStore,
  createStandardsCatalogStore,
  createStandardsRunQueue,
  createStandardsRunStore,
  createStandardsTemplateStore,
  createStandardsVariableResolver,
  unavailableTenantLicenses,
  withStandardsIngestion,
} from "./adapters/standards.js";
import {
  createJobPersistence,
  createRunGroupResolver,
  createRunQueue,
  createRunStore,
  withFindingsIngestion,
} from "./adapters/runs.js";
import {
  createAuthMethodsPolicyProvider,
  createMfaProviders,
  createRegistrationCampaignProvider,
  createTapRecordStore,
} from "./adapters/mfa.js";
import {
  createBecFindingStore,
  createBecProviders,
  createOffboardingRunner,
  createOffboardingStore,
  createUserProviders,
  createUserTemplateStore,
  type OffboardingRunner,
} from "./adapters/users.js";
import {
  createGdapSyncRunner,
  createOnboardRunner,
  createEnvelopeWorker,
  createTenantWorker,
  createTestConnectionRunner,
  createWorkerRunner,
  type WorkerRunner,
} from "./adapters/workers.js";
import { createDevIdentityAuthenticator, ensureDevUser } from "./auth/dev-identity.js";
import type { BffConfig } from "./config.js";
import { createOsKeystoreCredentialStore, type CredentialStore } from "./credentials/store.js";
import { AppError } from "./errors.js";
import { createJobDispatcher } from "./jobs/dispatch.js";
import { JobQueue, type RunWorkerFn } from "./jobs/queue.js";
import { buildJobFileArgs, createSupervisorRunner } from "./jobs/supervisor.js";
import { createScheduler, type Scheduler } from "./scheduler/scheduler.js";
import type { BaseRoleId } from "./rbac/base-roles.js";
import { PermissionRegistry } from "./rbac/permissions.js";
import { RbacErrorCodes, requireTenantInScope, type Caller } from "./rbac/authorize.js";
import { isTenantAllowed } from "./rbac/scope.js";
import { testPortalAccess } from "./rbac/test-portal-access.js";
import { SqliteCaTemplateRepository } from "./repository/ca-templates.js";
import { SqliteGroupTemplateRepository } from "./repository/group-templates.js";
import { SqliteDeviceActionRepository } from "./repository/device-actions.js";
import { SqliteDeviceActionPolicyRepository } from "./repository/device-action-policies.js";
import { SqliteIntuneTemplateRepository } from "./repository/intune-templates.js";
import { SqliteKeyAccessAuditRepository } from "./repository/key-access-audit.js";
import { SqliteReusableSettingTemplateRepository } from "./repository/reusable-setting-templates.js";
import { createAuthMethodsPolicyRoutes } from "./routes/auth-methods-policy.js";
import { createBaselinesAdvanceRoutes } from "./routes/baselines-advance.js";
import { createBaselinesAlignmentRoutes } from "./routes/baselines-alignment.js";
import { createBaselinesCatalogRoutes } from "./routes/baselines-catalog.js";
import { createBaselinesFleetRoutes } from "./routes/baselines-fleet.js";
import { createBaselinesMigrateRoutes } from "./routes/baselines-migrate.js";
import { createBaselinesRoutes } from "./routes/baselines.js";
import { createBecRoutes } from "./routes/bec.js";
import { createCaCoverageRoutes } from "./routes/ca-coverage.js";
import { createCaNamedLocationsRoutes } from "./routes/ca-named-locations.js";
import { createCaPoliciesCrudRoutes } from "./routes/ca-policies-crud.js";
import { createCaPoliciesRoute } from "./routes/ca-policies.js";
import { createCaReportOnlyRoutes } from "./routes/ca-report-only.js";
import { createCaTemplateDeployRoute } from "./routes/ca-templates-deploy.js";
import { createCaTemplateRoutes } from "./routes/ca-templates.js";
import { createCredentialRoutes } from "./routes/credentials.js";
import { createDashboardLayoutRoutes } from "./routes/dashboard-layout.js";
import { createDashboardRoutes, type DashboardRoutesStore } from "./routes/dashboard.js";
import { DEVICE_ACTIONS_HISTORY_OPENAPI, createDeviceActionsHistoryRoute } from "./routes/device-actions-history.js";
import { DEVICE_ACTIONS_PERMISSION, createDeviceActionsRoute } from "./routes/device-actions.js";
import { DEVICE_DESTRUCTIVE_ACTIONS_PERMISSION, createDestructiveActionsRoute } from "./routes/device-actions-destructive.js";
import { DEVICE_BITLOCKER_PERMISSION, createDeviceBitLockerRoute } from "./routes/device-bitlocker.js";
import { DEVICE_DETAIL_READ_PERMISSION, createDeviceDetailRoute } from "./routes/device-detail.js";
import { DEVICE_LAPS_PERMISSION, createDeviceLapsRoute } from "./routes/device-laps.js";
import { DEVICES_READ_PERMISSION, createDevicesListRoute } from "./routes/devices.js";
import { DRIFT_BULK_PERMISSIONS, createDriftBulkRoutes } from "./routes/drift-bulk.js";
import { DRIFT_DENY_PERMISSIONS, createDriftDenyRoutes } from "./routes/drift-deny.js";
import { createDriftReportRoutes } from "./routes/drift-report.js";
import { createDriftTriageRoutes } from "./routes/drift-triage.js";
import { createDriftRoutes } from "./routes/drift.js";
import {
  SqliteAssignmentFilterTemplateRepository,
  createAssignmentFilterRoutes,
} from "./routes/intune-assignment-filters.js";
import { createIntuneCompareRoute } from "./routes/intune-compare.js";
import { createJitGrantsRoutes } from "./routes/jit-grants.js";
import { createJitTemplatesRoutes } from "./routes/jit-templates.js";
import { createIntuneCrudRoutes } from "./routes/intune-policies-crud.js";
import { createIntunePoliciesRoutes } from "./routes/intune-policies.js";
import { createReusableSettingsRoutes } from "./routes/intune-reusable-settings.js";
import { createIntuneTemplateDeployRoute } from "./routes/intune-templates-deploy.js";
import { createGdapRoutes } from "./routes/gdap.js";
import { createMfaRoutes } from "./routes/mfa.js";
import { createOffboardingRoutes } from "./routes/offboarding.js";
import { createOnboardRoutes } from "./routes/onboard.js";
import { createPimRequestsRoutes } from "./routes/pim-requests.js";
import { createPimSettingsTemplatesRoutes } from "./routes/pim-settings-templates.js";
import { createPimAssignmentsRoute } from "./routes/pim.js";
import { createRegistrationCampaignRoute } from "./routes/registration-campaign.js";
import { createAccessRoutes } from "./routes/access.js";
import { createApiClientRoutes } from "./routes/api-clients.js";
import { createMeRoutes } from "./routes/me.js";
import { createOpenApiRoutes } from "./routes/openapi.js";
import { createRemediationRoutes } from "./routes/remediation.js";
import { createReportTemplateRoutes } from "./routes/report-templates.js";
import { createReportsRoutes, type ReportsAuthorizer } from "./routes/reports.js";
import { createRoleAssignmentsRoute, createRolesRoutes } from "./routes/roles.js";
import { createRunsActionsRoutes } from "./routes/runs-actions.js";
import { createRunsArtifactsRoutes } from "./routes/runs-artifacts.js";
import { createRunsCreateRoute } from "./routes/runs-create.js";
import { createRunsDetailRoutes } from "./routes/runs-detail.js";
import { createRunsEventsRoute } from "./routes/runs-events.js";
import { createRunsListRoute } from "./routes/runs-list.js";
import { createScheduleRoutes } from "./routes/schedules.js";
import { createScriptRoutes } from "./routes/scripts.js";
import { createStandardsAlignmentRoutes } from "./routes/standards-alignment.js";
import { createStandardsCatalogRoutes } from "./routes/standards-catalog.js";
import { createStandardsRunRoutes } from "./routes/standards-run.js";
import { createStandardsTemplateRoutes } from "./routes/standards-templates.js";
import { createTenantGroupRoutes } from "./routes/tenant-groups.js";
import { createTenantVariableRoutes } from "./routes/tenant-variables.js";
import { createTenantRoutes } from "./routes/tenants.js";
import { createTestConnectionRoutes } from "./routes/test-connection.js";
import { createUserTemplateRoutes } from "./routes/user-templates.js";
import { createPortalUsersRoute, createTenantUsersRoute } from "./routes/users.js";
import { createGroupTemplatesDeployRoute } from "./routes/group-templates-deploy.js";
import { createGroupTemplatesRoutes } from "./routes/group-templates.js";
import { createGroupCrudRoutes } from "./routes/groups-crud.js";
import { createGroupGalDeliveryRoutes } from "./routes/groups-gal.js";
import { createGroupsListRoute } from "./routes/groups-list.js";
import { createGroupMembersRoutes } from "./routes/groups-members.js";
import { createGroupUsageRoutes } from "./routes/groups-usage.js";
import { createHealthRoutes } from "./routes/health.js";
import { createIntuneTemplateRoutes } from "./routes/intune-templates.js";
import type { RequestAuthenticator, RequestCaller, RequestContext, Route } from "./server.js";
import { ProgressEventHub } from "./sse/hub.js";

export const DATABASE_FILE = "portal.db";
export const RUN_WORKER = "run-tenant.ps1";
export const STANDARDS_WORKER = "run-standards.ps1";
export const DRIFT_WORKER = "run-drift.ps1";
export const UNAUTHENTICATED = "auth.unauthenticated";

// ---- Authorization ---------------------------------------------------------

/**
 * EPIC-001 roles (rbac/roles.ts) mapped onto the EPIC-038 base roles, so portal users
 * and API clients are authorized one way. `operator` held only runs.read.
 */
export const LEGACY_ROLE_BASE_ROLES: Readonly<Record<string, BaseRoleId>> = {
  admin: "admin",
  operator: "readonly",
};

/** EPIC-001 run permissions under their EPIC-038 taxonomy names. */
export const LEGACY_PERMISSIONS: Readonly<Record<string, string>> = {
  "runs.read": "Tenant.Runs.Read",
  "runs.create": "Tenant.Runs.ReadWrite",
  "runs.cancel": "Tenant.Runs.ReadWrite",
  "runs.retry": "Tenant.Runs.ReadWrite",
  admin: "CIPP.Admin.Diagnostics",
};

const BASE_ROLE_IDS: ReadonlySet<string> = new Set(["readonly", "editor", "admin", "superadmin"]);

function baseRolesOf(caller: RequestCaller): BaseRoleId[] {
  const roles = new Set<BaseRoleId>();
  for (const role of caller.roles) {
    const base = LEGACY_ROLE_BASE_ROLES[role] ?? (BASE_ROLE_IDS.has(role) ? (role as BaseRoleId) : undefined);
    if (base) roles.add(base);
  }
  return [...roles];
}

/** Whether `caller` holds `permission` (EPIC-001 names are translated first). */
export function canAccess(caller: RequestCaller | null | undefined, permission: string): boolean {
  if (!caller) return false;
  return testPortalAccess({
    permission: LEGACY_PERMISSIONS[permission] ?? permission,
    roles: baseRolesOf(caller),
  }).allowed;
}

function unauthenticated(): AppError {
  return new AppError(UNAUTHENTICATED, "authentication required", 401);
}

function forbidden(permission: string): AppError {
  return new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${permission}`, 403);
}

/** Authorizer for routes that take `(caller, permission) => void`. */
export function authorizeCaller(caller: RequestCaller | null | undefined, permission: string): void {
  if (!caller) throw unauthenticated();
  if (!canAccess(caller, permission)) throw forbidden(permission);
}

/**
 * Authorizer for routes that take `(ctx, permission) => boolean` and raise their own 403.
 * An anonymous request is a 401 here rather than a 403 from the route.
 */
export function authorizeContext(ctx: RequestContext, permission: string): boolean {
  if (!ctx.caller) throw unauthenticated();
  return canAccess(ctx.caller, permission);
}

/**
 * `resolveCaller` for routes: the server-resolved caller, or undefined when anonymous.
 * Portal users carry `id`; routes that stamp a creator read `userId`, so it is added.
 */
export function resolveCaller(ctx: RequestContext): (Caller & { userId?: string }) | undefined {
  // Route modules type the caller as the EPIC-001 Caller; RequestCaller has the same
  // fields with base-role ids allowed, which the authorizer above understands.
  if (!ctx.caller) return undefined;
  const id = (ctx.caller as { id?: unknown }).id;
  return (typeof id === "string" ? { ...ctx.caller, userId: id } : ctx.caller) as Caller & { userId?: string };
}

/**
 * Wrap a route whose module does no authorization of its own: require `permission`
 * and, when the path names a tenant, that the tenant is in the caller's scope.
 */
export function guardRoute(route: Route, permission: string): Route {
  return {
    ...route,
    handler: (ctx) => {
      authorizeCaller(ctx.caller, permission);
      const tenantId = ctx.params["tenantId"];
      if (tenantId) requireTenantInScope(ctx.caller as Caller, tenantId);
      return route.handler(ctx);
    },
  };
}

/** Whether the request's caller may act on `tenantId` (false when anonymous). */
function callerCanAccessTenant(ctx: RequestContext, tenantId: string): boolean {
  return ctx.caller ? isTenantAllowed(ctx.caller.tenantScope, tenantId) : false;
}

/** The reports module's per-request authorizer; anonymous requests are a 401. */
function reportsAuthorizer(ctx: RequestContext): ReportsAuthorizer {
  if (!ctx.caller) throw unauthenticated();
  const caller = ctx.caller;
  return {
    hasPermission: (permission) => canAccess(caller, permission),
    actorUserId: () => actorOf(ctx),
    canAccessTenant: (tenantId) => isTenantAllowed(caller.tenantScope, tenantId),
  };
}

/** The signed-in user's id for audit records. */
function actorOf(ctx: RequestContext): string {
  const caller = ctx.caller as { id?: unknown } | null | undefined;
  return typeof caller?.id === "string" ? caller.id : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Record the audit events a worker-backed write returns in its response body
 * (`auditEvent`, or `auditEvents` for bulk and multi-tenant writes), stamped with the
 * signed-in actor. Used for routes whose modules hand events back instead of taking
 * an audit sink. Previews return plans and carry no events.
 */
export function recordResponseAudit(route: Route, recordAudit: RecordAudit): Route {
  return {
    ...route,
    handler: async (ctx) => {
      const response = await route.handler(ctx);
      const body: unknown = response.body;
      if (isRecord(body)) {
        const events = [
          ...(isRecord(body["auditEvent"]) ? [body["auditEvent"]] : []),
          ...(Array.isArray(body["auditEvents"]) ? body["auditEvents"].filter(isRecord) : []),
        ];
        for (const event of events) {
          await recordAudit({ actor: actorOf(ctx), ...event });
        }
      }
      return response;
    },
  };
}

// ---- Composition -----------------------------------------------------------

export interface App {
  readonly routes: readonly Route[];
  readonly authenticators: readonly RequestAuthenticator[];
  /** Assessment run jobs; `drain()` waits for the ones in flight. */
  readonly runs: JobQueue;
  /** Background offboarding runs; `idle()` waits for the ones in flight. */
  readonly offboarding: OffboardingRunner;
  /** The scheduler tick; started with the app, stopped by `close()`. */
  readonly scheduler: Scheduler;
  close(): void;
}

export interface CreateAppOptions {
  /** Use this database instead of opening `<storagePath>/portal.db` (tests pass ":memory:"). */
  readonly db?: Database.Database;
  /** Run worker entrypoints with this instead of pwsh (tests pass a fake). */
  readonly workerRunner?: WorkerRunner;
  /** Backend for client-secret and PFX material instead of the owner-only file store (tests pass in-memory). */
  readonly credentialStore?: CredentialStore;
  /** Run assessment jobs with this instead of supervising run-tenant.ps1 (tests pass a fake). */
  readonly runWorker?: ConstructorParameters<typeof JobQueue>[0]["runWorker"];
  /** How often the scheduler tick runs; tests pass a long interval. */
  readonly schedulerIntervalMs?: number;
  readonly version?: string;
}

function openDatabase(config: BffConfig): Database.Database {
  mkdirSync(config.storagePath, { recursive: true });
  const db = new Database(path.join(config.storagePath, DATABASE_FILE));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function createApp(config: BffConfig, options: CreateAppOptions = {}): App {
  const db = options.db ?? openDatabase(config);

  const authenticators: RequestAuthenticator[] = [];
  if (config.devIdentityRole) {
    authenticators.push(createDevIdentityAuthenticator(config.devIdentityRole));
  }

  const schemaVersion = runMigrations(db, loadMigrations());
  if (config.devIdentityRole) ensureDevUser(db, config.devIdentityRole);
  const journalMode = String(db.pragma("journal_mode", { simple: true }) ?? "memory");
  const repo = new SqliteRepository(db, schemaVersion, journalMode);
  const run = options.workerRunner ?? createWorkerRunner({ workersDir: config.workersDir });

  const tenantStore = createTenantStore(repo);
  const recordAudit = createAuditSink(repo);
  const intuneTemplates = new SqliteIntuneTemplateRepository(db);
  const credentialRows = createCredentialRowStore(repo);
  // Client-secret and PFX material lives here (owner-only files the worker child reads, T-0827).
  const credentialSecrets = options.credentialStore ?? createOsKeystoreCredentialStore();
  const intune = createIntuneProviders(run, credentialRows);
  const keyAudit = new SqliteKeyAccessAuditRepository(db, schemaVersion);
  const caller = { resolveCaller, authorize: authorizeCaller };
  const groups = createGroupProviders(run, credentialRows);
  const ca = createCaProviders(run, credentialRows, db);
  const caTemplates = new SqliteCaTemplateRepository(db);
  const groupTemplates = new SqliteGroupTemplateRepository(db);
  const audited = (route: Route) => recordResponseAudit(route, recordAudit);
  // Route modules type their audit events as interfaces; the sink takes any record.
  const routeAudit = (event: object) => recordAudit({ ...event });
  const envelope = createEnvelopeWorker(run, credentialRows);
  const users = createUserProviders(envelope);
  const bec = createBecProviders(envelope);
  const offboardingRepo = new SqliteOffboardingRepository(db, schemaVersion);
  const offboarding = createOffboardingRunner(envelope, offboardingRepo);
  const tenantWorker = createTenantWorker(run, credentialRows);
  const mfa = createMfaProviders(envelope);
  const roles = createRoleProviders(tenantWorker);
  const jitRepo = new SqliteJitRepository(db, schemaVersion);

  // EPIC-017 Intune apps, Autopilot, and enrollment (T-0844). App uploads run on their own
  // queue so their lifecycle events stay out of the assessment-run progress hub; the Queued
  // Applications page reads the AppDeployment rows instead. Package routes answer 503 until
  // M365_BFF_APP_PACKAGE_SECRET is set.
  const intuneApps = createIntuneAppProviders(tenantWorker);
  const allows = (c: unknown, permission: string) => canAccess(c as RequestCaller, permission);
  const appDeployments = new SqliteAppDeploymentRepository(db, schemaVersion);
  const appPackages = config.appPackageSecret
    ? new AppPackageStore({
        artifactRoot: config.artifactPath,
        signingSecret: config.appPackageSecret,
        maxBytes: config.appPackageMaxBytes,
      })
    : unconfiguredPackageStore(config.appPackageMaxBytes);
  const appUploadJobs = new JobQueue({
    persistence: createJobPersistence(repo),
    poolSize: 1,
    runWorker: createJobDispatcher({
      [APP_UPLOAD_JOB_TYPE]: createAppUploadRunner({
        call: tenantWorker,
        repository: appDeployments,
        packages: appPackages,
        packageBaseUrl: config.workerBaseUrl,
        recordAudit,
      }),
    }),
  });
  const appUploadQueue = createAppUploadQueue(appUploadJobs);
  const autopilotTemplates = new SqliteAutopilotProfileTemplateRepository(db, schemaVersion);

  // EPIC-001/003 runs: the job queue supervises run-tenant.ps1 under the artifact root,
  // and every queue and worker progress event goes through the hub, which records run
  // and section state and serves the progress stream. A finished run's findings are
  // stored before the queue reports it finished.
  const remediationRepo = new SqliteRemediationRepository(db, schemaVersion);
  const runStore = createRunStore(repo, db);
  const hub = new ProgressEventHub({ store: runStore });
  const publish = (event: unknown) => void hub.publish(event as Record<string, unknown>);
  const generatedReports = createGeneratedReportStore(
    new SqliteReportRepository(db, schemaVersion, repo),
    repo,
    db,
  );
  const scheduleRepo = new SqliteScheduleRepository(db, schemaVersion);
  const standardsRepo = new SqliteStandardsRepository(db, schemaVersion, DEFAULT_STANDARDS_REGISTRY_PATH);
  const driftRepo = new SqliteDriftRepository(db, schemaVersion, DEFAULT_STANDARDS_REGISTRY_PATH);
  const baselinesRepo = new SqliteBaselinesRepository(db, schemaVersion);
  const reportRuns = createReportRunReader(repo, config.artifactPath);

  const workerRunners: Partial<Record<JobType, RunWorkerFn>> = {
    assessment: createSupervisorRunner({
      workerScriptPath: path.join(config.workersDir, RUN_WORKER),
      storageRoot: config.artifactPath,
      onProgress: publish,
    }),
    standards: createSupervisorRunner({
      workerScriptPath: path.join(config.workersDir, STANDARDS_WORKER),
      storageRoot: config.artifactPath,
      onProgress: publish,
      buildArgs: buildJobFileArgs,
    }),
    drift: createSupervisorRunner({
      workerScriptPath: path.join(config.workersDir, DRIFT_WORKER),
      storageRoot: config.artifactPath,
      onProgress: publish,
      buildArgs: buildJobFileArgs,
    }),
    baseline: createBaselineEvaluationRunner({
      workersDir: config.workersDir,
      storageRoot: config.artifactPath,
      baselines: baselinesRepo,
      tenants: tenantStore,
      findings: repo,
      latestRunId: reportRuns.latestRunId,
    }),
    remediation: createRemediationWorkerRunner({
      workersDir: config.workersDir,
      storageRoot: config.artifactPath,
    }),
    report: createReportWorkerRunner({
      workersDir: config.workersDir,
      storageRoot: config.artifactPath,
    }),
  };
  const runJobs = new JobQueue({
    persistence: createJobPersistence(repo),
    poolSize: config.workerPoolSize,
    runWorker: withReportCompletion(
      withRemediationPlanIngestion(
        withRemediationApplyIngestion(
          withRemediationVerifyIngestion(
            withDriftIngestion(
              withStandardsIngestion(
                withFindingsIngestion(
                  options.runWorker ?? createJobDispatcher(workerRunners),
                  { repo, storageRoot: config.artifactPath },
                ),
                { standards: standardsRepo, storageRoot: config.artifactPath },
              ),
              { drift: driftRepo, storageRoot: config.artifactPath },
            ),
            { remediation: remediationRepo, storageRoot: config.artifactPath },
          ),
          { remediation: remediationRepo, storageRoot: config.artifactPath },
        ),
        { remediation: remediationRepo, storageRoot: config.artifactPath },
      ),
      { store: generatedReports },
    ),
    onProgress: publish,
  });
  const runQueue = createRunQueue({
    queue: runJobs,
    storageRoot: config.artifactPath,
    tenants: tenantStore,
    credentials: credentialRows,
    repo,
  });
  const reportRenderQueue = createRenderQueue({
    store: generatedReports,
    jobs: runJobs,
    storageRoot: config.artifactPath,
  });
  // EPIC-007 scheduled runs (T-0840): only job types with a runner on the dispatcher can be
  // saved or run. Assessment jobs enqueue through the job queue with a run record and a
  // context.json; the tick starts and stops with the app and records outcomes.
  const runnableJobTypes = new Set<JobType>(Object.keys(workerRunners) as JobType[]);
  const scheduleQueue = createScheduleRunQueue({
    jobs: runJobs,
    repo,
    storageRoot: config.artifactPath,
    tenants: tenantStore,
    credentials: credentialRows,
    runnableTypes: runnableJobTypes,
  });
  const scheduleStore = createRunnerValidatingScheduleStore(scheduleRepo, runnableJobTypes);
  const scheduleJobState = createScheduleJobStateStore(db);
  const scheduler = createScheduler({
    queue: scheduleQueue,
    schedules: createTickScheduleStore(scheduleRepo),
    isRunning: (scheduleId) => scheduleJobState.isRunning(scheduleId),
    lastFinishedJob: (scheduleId) => scheduleJobState.lastFinishedJob(scheduleId),
    ...(options.schedulerIntervalMs !== undefined ? { intervalMs: options.schedulerIntervalMs } : {}),
  });
  scheduler.start();
  const driftTriage = createDriftTriageStore(driftRepo);

  // EPIC-038 RBAC & API clients (T-0868): portal users, custom roles, and API
  // clients persist through the shared SQLite connection rather than a test-only
  // in-memory store.
  const rbacRepo = new SqliteRbacRepository(db, schemaVersion);
  const portalUserStore = createPortalUserStore(rbacRepo);
  const rbacRolesStore = createRolesStore(rbacRepo);
  const apiClientStore = createApiClientStore(rbacRepo);

  // These routes read the raw body themselves; the server has already parsed it.
  const readBody = async (ctx: RequestContext) => (ctx.body === undefined ? "" : JSON.stringify(ctx.body));

  const routes: Route[] = [
    ...createHealthRoutes({
      ...(options.version !== undefined ? { version: options.version } : {}),
      storage: {
        checkReachability: () => {
          try {
            db.prepare("SELECT 1").get();
            return true;
          } catch {
            return false;
          }
        },
      },
    }),
    ...createBaselinesCatalogRoutes({ resolveCaller, authorize: authorizeCaller }),
    ...createCaTemplateRoutes(caTemplates, { authorize: authorizeContext }),
    ...createIntuneTemplateRoutes(intuneTemplates, { authorize: authorizeContext }),
    ...createGroupTemplatesRoutes({
      repository: groupTemplates,
      resolveCaller,
      authorize: authorizeCaller,
    }),
    // EPIC-001/003 runs (T-0821). runs.ts, the EPIC-001 version of these routes, is
    // superseded by the EPIC-003 modules on every path and is not mounted.
    createRunsListRoute({ store: runStore, ...caller }),
    createRunsCreateRoute({
      store: runStore,
      queue: runQueue,
      groupResolver: createRunGroupResolver(createTenantGroupStore(repo)),
      readBody,
      ...caller,
    }),
    ...createRunsDetailRoutes({ store: runStore, ...caller }),
    ...createRunsActionsRoutes({ store: runStore, queue: runQueue, eventHub: hub, readBody, ...caller }),
    ...createRunsArtifactsRoutes({ store: runStore, artifactRoot: config.artifactPath, ...caller }),
    createRunsEventsRoute({ hub, store: runStore, ...caller }),

    // EPIC-004 dashboards (T-0823). The layout routes come first: /v1/dashboard/:tenantId
    // would otherwise capture /v1/dashboard/layout.
    ...createDashboardLayoutRoutes({
      store: new SqliteDashboardLayoutRepository(db, schemaVersion),
      resolveCaller: (ctx) => {
        const userId = resolveCaller(ctx)?.userId;
        return userId ? { userId } : undefined;
      },
    }),
    ...createDashboardRoutes({
      // The repository returns the route's payload; its widgets are typed as interfaces
      // where the route declares plain records, which TypeScript will not relate.
      store: new SqliteDashboardRepository(db, schemaVersion) as unknown as DashboardRoutesStore,
      hasPermission: (c, permission) => canAccess(c as RequestCaller, permission),
      ...caller,
    }),

    // EPIC-005 reports (T-0823, T-0835). Generation composes the HTML, enqueues a render
    // job, and moves the report to succeeded with its PDF when the job settles.
    ...(createReportTemplateRoutes({
      store: new SqliteReportTemplateRepository(db, schemaVersion),
      contract: { parse: (input) => parseReportTemplate(input) },
      render: createTemplateRender({ store: generatedReports, render: reportRenderQueue }),
      authorize: { requirePermission: (ctx, permission) => authorizeCaller(ctx.caller, permission) },
      resolveActor: (ctx) => (ctx.caller ? actorOf(ctx) : null),
      tenantAccess: callerCanAccessTenant,
    }) as Route[]),
    ...(createReportsRoutes({
      store: generatedReports,
      queue: reportRenderQueue,
      runs: reportRuns,
      audit: {
        record: (event) =>
          recordAudit({
            action: event.action,
            tenantId: event.tenantId,
            actorUserId: event.actorUserId,
            targetType: "report",
            targetId: event.resourceId,
            correlationId: event.correlationId,
          }),
      },
      authorizer: reportsAuthorizer,
      artifactRoot: config.artifactPath,
    }) as Route[]),

    // Caller identity and the permission preflight the UI's PermissionGate reads. Without
    // them every gated control stays hidden (it fails closed).
    ...createMeRoutes({ resolveCaller }),
    ...createAccessRoutes({ resolveCaller, recordAccess: recordAudit }),

    // EPIC-038 RBAC, portal users, and API clients (T-0868). The SPEC §6 surface was
    // implemented but never mounted; the stores bind to the SQLite rbac repository.
    ...createPortalUsersRoute({
      store: portalUserStore,
      resolveCaller,
      authorize: authorizeCaller,
      recordAudit: routeAudit,
    }),
    ...createRolesRoutes({
      store: rbacRolesStore,
      permissionRegistry: PermissionRegistry,
      resolveCaller,
      authorize: authorizeCaller,
      recordAudit: routeAudit,
    }),
    ...createApiClientRoutes(apiClientStore),
    // GET /openapi.json and /v1/openapi.json serve the generated OpenAPI 3.1 document
    // (SPEC §3.5/§6); the server keeps serving /v1/openapi.yaml.
    ...createOpenApiRoutes(),

    // EPIC-006 remediation and EPIC-007 schedules and scripts (T-0824). Plans, schedules,
    // and scripts persist. Scheduled assessment jobs run through the job queue (T-0840).
    // Custom scripts run in the T-0126 sandbox through run-custom-script.ps1 (T-0837).
    ...createRemediationRoutes({
      store: createRemediationStore(remediationRepo),
      queue: createRemediationQueue({ jobs: runJobs, repo, credentials: credentialRows, storageRoot: config.artifactPath }),
      latestRunId: (tenantId) => reportRuns.latestRunId(tenantId),
      idempotency: createJobBackedRemediationIdempotencyStore(db),
      ...caller,
    }),
    ...createScheduleRoutes({
      store: scheduleStore,
      history: createScheduleHistoryStore(db),
      queue: scheduleQueue,
      ...caller,
    }),
    ...createScriptRoutes({
      store: new SqliteCustomScriptRepository(db, schemaVersion),
      sandbox: createScriptSandbox({ run }),
      audit: {
        record: (event) =>
          recordAudit({
            action: event.action,
            tenantId: event.tenantId ?? null,
            actorUserId: event.actorUserId,
            targetType: "script",
            targetId: event.resourceId,
            correlationId: event.correlationId,
          }),
      },
      ...caller,
    }),

    // EPIC-008 standards (T-0825). Run-now enqueues a `standards` job (T-0841);
    // classifying the catalog for a tenant is still refused with 501 (T-0828).
    ...createStandardsCatalogRoutes({
      catalog: createStandardsCatalogStore(standardsRepo),
      resolveTenantLicense: unavailableTenantLicenses,
      ...caller,
    }),
    ...createStandardsTemplateRoutes({ store: createStandardsTemplateStore(standardsRepo), ...caller }),
    ...createStandardsRunRoutes({
      store: createStandardsRunStore(standardsRepo, scheduleRepo),
      queue: createStandardsRunQueue({
        jobs: runJobs,
        findings: repo,
        latestRunId: reportRuns.latestRunId,
        storageRoot: config.artifactPath,
      }),
      resolveVariables: createStandardsVariableResolver(createTenantVariableStore(repo)),
      audit: { record: routeAudit },
      ...caller,
    }),
    ...createStandardsAlignmentRoutes({ store: createStandardsAlignmentStore(standardsRepo), ...caller }),

    // EPIC-009 drift (T-0825). Refresh enqueues a `drift` job and a deny that
    // deletes queues the delete as a remediation apply job (T-0841; the apply
    // worker itself lands with T-0838).
    ...createDriftRoutes({
      store: createDriftStore(driftRepo),
      refresh: createDriftRefresh({
        jobs: runJobs,
        drift: driftRepo,
        findings: repo,
        latestRunId: reportRuns.latestRunId,
        storageRoot: config.artifactPath,
      }),
      ...caller,
    }),
    ...createDriftReportRoutes({ store: createDriftStore(driftRepo), ...caller }),
    ...createDriftTriageRoutes({ store: driftTriage, audit: { record: routeAudit }, ...caller }),
    ...createDriftDenyRoutes({
      store: driftTriage,
      remediation: createDriftDeletionPort({ jobs: runJobs }),
      audit: { record: routeAudit },
      ...caller,
    }),
    ...createDriftBulkRoutes({
      store: driftTriage,
      remediation: createDriftDeletionPort({ jobs: runJobs }),
      audit: { record: routeAudit },
      ...caller,
    }),

    // EPIC-010 baselines (T-0825). /baselines/fleet is mounted before the
    // /baselines/:baselineId routes so the id pattern cannot capture it.
    ...createBaselinesFleetRoutes({ store: createBaselinesFleetStore(baselinesRepo, driftRepo), ...caller }),
    ...createBaselinesRoutes({ store: createBaselinesStore(baselinesRepo), ...caller }),
    ...createBaselinesAdvanceRoutes({
      store: createBaselineAdvanceStore(baselinesRepo),
      history: createBaselineHistory(baselinesRepo),
      audit: { record: routeAudit },
      ...caller,
    }),
    ...createBaselinesAlignmentRoutes({ store: createBaselineAlignmentStore(baselinesRepo), ...caller }),
    ...createBaselinesMigrateRoutes({ store: createBaselinesMigrateStore(standardsRepo, baselinesRepo), ...caller }),

    // EPIC-002 tenants and onboarding (T-0822).
    ...createTenantRoutes({ store: tenantStore, ...caller }),
    ...createTenantGroupRoutes({ store: createTenantGroupStore(repo), ...caller }),
    ...createTenantVariableRoutes({ store: createTenantVariableStore(repo), ...caller }),
    ...createCredentialRoutes({
      records: credentialRows,
      secrets: credentialSecrets,
      ...caller,
    }),
    ...createGdapRoutes({
      enabled: config.gdapPartnerTenantId !== null,
      tenantStore,
      relationshipStore: createGdapRelationshipStore(repo),
      ...(config.gdapPartnerTenantId
        ? { runner: createGdapSyncRunner(run, credentialRows, config.gdapPartnerTenantId) }
        : {}),
      ...caller,
    }),
    ...createOnboardRoutes({ tenantStore, credentialStore: credentialRows, secrets: credentialSecrets, runner: createOnboardRunner(run), ...caller }),
    ...createTestConnectionRoutes({
      tenantStore,
      credentialStore: credentialRows,
      runner: createTestConnectionRunner(run),
      ...caller,
    }),

    // EPIC-016 Intune (T-0820). Order matters: the server takes the first match, and the
    // generic /intune/:kind policy routes would otherwise capture compare,
    // reusable-settings, and assignment-filters.
    createIntuneCompareRoute({ provider: intune.compare, templates: intuneTemplates, resolveCaller, authorize: authorizeContext }),
    ...createReusableSettingsRoutes({
      repository: new SqliteReusableSettingTemplateRepository(db),
      provider: intune.reusableSettings,
      resolveCaller,
      authorize: authorizeContext,
      recordAudit,
    }),
    ...createAssignmentFilterRoutes({
      repository: new SqliteAssignmentFilterTemplateRepository(db),
      provider: intune.assignmentFilters,
      resolveCaller,
      authorize: authorizeContext,
      recordAudit,
    }),
    createIntuneTemplateDeployRoute({
      repository: intuneTemplates,
      provider: intune.deploy,
      resolveCaller,
      authorize: authorizeContext,
      recordAudit,
    }),
    ...createIntunePoliciesRoutes({ provider: intune.policies, ...caller }),
    ...createIntuneCrudRoutes({ provider: intune.crud, ...caller }),

    // EPIC-017 apps (T-0844). Fixed /apps/* paths come before /apps/:appId, which would
    // otherwise capture them.
    ...createAppPackageRoutes({ packages: appPackages, resolveCaller, authorize: allows, recordAudit }),
    ...createIntuneAppsQueueRoutes({
      repository: appDeployments,
      packages: appPackages,
      queue: appUploadQueue,
      resolveCaller,
      authorize: allows,
      recordAudit,
    }),
    ...createIntuneAppStatusRoutes({ provider: intuneApps.status, resolveCaller, authorize: allows }),
    ...createIntuneAppsRoutes({ provider: intuneApps.apps, ...caller }),
    createIntuneAppAssignRoute({ provider: intuneApps.assign, resolveCaller, authorize: allows, recordAudit }),
    ...createIntuneAppCrudRoutes({ provider: intuneApps.crud, resolveCaller, authorize: allows, recordAudit }),
    ...createApplicationTemplateRoutes({
      templates: new SqliteApplicationTemplateRepository(db, schemaVersion),
      deployments: appDeployments,
      packages: appPackages,
      queue: appUploadQueue,
      preflight: intuneApps.templatePreflight,
      variables: createTemplateVariableReader(createTenantVariableStore(repo)),
      resolveCaller,
      authorize: allows,
      recordAudit,
    }),
    // EPIC-017 Autopilot and enrollment (T-0844).
    ...createAutopilotRoutes({ provider: intuneApps.autopilot, templates: autopilotTemplates, resolveCaller, authorize: allows, recordAudit }),
    ...createAutopilotProfileWriteRoutes({
      provider: intuneApps.autopilotWrite,
      templates: autopilotTemplates,
      resolveCaller,
      authorize: allows,
      recordAudit,
    }),
    ...createEnrollmentProfileRoutes({
      provider: intuneApps.enrollment,
      templates: new SqliteEnrollmentProfileTemplateRepository(db, schemaVersion),
      resolveCaller,
      authorize: allows,
      recordAudit,
    }),

    // EPIC-011 users, offboarding, BEC, and user templates (T-0818).
    ...createTenantUsersRoute({
      provider: users.list,
      create: users.create,
      execute: users.execute,
      patch: users.patch,
      recordAudit: routeAudit,
      ...caller,
    }),
    ...createBecRoutes({
      provider: bec.check,
      remediate: bec.remediate,
      store: createBecFindingStore(new SqliteBecFindingRepository(db, schemaVersion)),
      recordAudit: routeAudit,
      ...caller,
    }),
    ...createOffboardingRoutes({
      store: createOffboardingStore(offboardingRepo),
      queue: offboarding,
      recordAudit: routeAudit,
      ...caller,
    }),
    ...createUserTemplateRoutes({
      store: createUserTemplateStore(new SqliteUserTemplateRepository(db, schemaVersion)),
      recordAudit: routeAudit,
      ...caller,
    }),

    // EPIC-012 MFA, authentication methods, and the registration campaign (T-0818).
    ...createMfaRoutes({
      report: mfa.report,
      reset: mfa.reset,
      tap: mfa.tap,
      tapRecords: createTapRecordStore(new SqliteTapRecordRepository(db)),
      actions: mfa.actions,
      recordAudit: routeAudit,
      ...caller,
    }),
    ...createAuthMethodsPolicyRoutes({
      provider: createAuthMethodsPolicyProvider(tenantWorker),
      recordAudit: routeAudit,
      ...caller,
    }),
    ...createRegistrationCampaignRoute({
      provider: createRegistrationCampaignProvider(tenantWorker),
      recordAudit: routeAudit,
      ...caller,
    }),

    // EPIC-013 roles, PIM, and JIT (T-0818).
    createRoleAssignmentsRoute({ provider: roles.roles, ...caller }),
    createPimAssignmentsRoute({ provider: roles.pim, ...caller }),
    ...createPimRequestsRoutes({
      repository: new SqliteRoleRequestsRepository(db, schemaVersion),
      submitProvider: roles.pimRequests,
      recordAudit: routeAudit,
      ...caller,
    }),
    ...createPimSettingsTemplatesRoutes({
      repository: new SqlitePimSettingsRepository(db, schemaVersion),
      liveSettingsProvider: roles.liveSettings,
      applyProvider: roles.applySettings,
      recordAudit: routeAudit,
      ...caller,
    }),
    ...createJitGrantsRoutes({ repository: jitRepo, executionProvider: roles.jit, recordAudit: routeAudit, ...caller }),
    ...createJitTemplatesRoutes({
      repository: new SqliteJitTemplatesRepository(db, schemaVersion),
      activeGrantsResolver: createActiveGrantsResolver(db, jitRepo),
      ...caller,
    }),

    // EPIC-014 groups (T-0819). /groups/usage is mounted before the /groups/:groupId
    // routes so the id pattern cannot capture it.
    ...createGroupUsageRoutes({ provider: groups.usage, ...caller }),
    createGroupsListRoute({ provider: groups.list, ...caller }),
    ...createGroupCrudRoutes({ provider: groups.crud, ...caller }).map(audited),
    ...createGroupGalDeliveryRoutes({ provider: groups.gal, ...caller }).map(audited),
    ...createGroupMembersRoutes({ provider: groups.members, ...caller }).map(audited),
    audited(createGroupTemplatesDeployRoute({ repository: groupTemplates, provider: groups.templateDeploy, ...caller })),

    // EPIC-015 Conditional Access (T-0819).
    createCaPoliciesRoute({ provider: ca.policies, ...caller }),
    ...createCaPoliciesCrudRoutes({ provider: ca.crud, ...caller }).map(audited),
    ...createCaCoverageRoutes({ provider: ca.coverage, ...caller }),
    ...createCaReportOnlyRoutes({ provider: ca.reportOnly, ...caller }),
    ...createCaNamedLocationsRoutes({ provider: ca.namedLocations, ...caller }).map(audited),
    audited(createCaTemplateDeployRoute({ repository: caTemplates, provider: ca.templateDeploy, ...caller })),

    // EPIC-018 devices (T-0820). These modules check permissions but not tenant scope,
    // and the history route checks neither, so each is guarded here.
    guardRoute(createDevicesListRoute({ provider: intune.devices, resolveCaller, authorize: authorizeCaller }), DEVICES_READ_PERMISSION),
    ...createDeviceDetailRoute({ provider: intune.deviceDetail, resolveCaller, authorize: authorizeCaller }).map((r) =>
      guardRoute(r, DEVICE_DETAIL_READ_PERMISSION),
    ),
    ...createDeviceActionsHistoryRoute({ store: new SqliteDeviceActionRepository(db, schemaVersion) }).map((r) =>
      guardRoute(r, DEVICE_ACTIONS_HISTORY_OPENAPI.paths["/tenants/{tenantId}/devices/{deviceId}/actions"].get.permission),
    ),
    ...createDeviceActionsRoute({
      provider: intune.deviceActions,
      store: new SqliteDeviceActionRepository(db, schemaVersion),
      resolveCaller,
      authorize: authorizeCaller,
    }).map((r) => guardRoute(r, DEVICE_ACTIONS_PERMISSION)),
    ...createDestructiveActionsRoute({
      provider: intune.destructiveActions,
      store: new SqliteDeviceActionRepository(db, schemaVersion),
      policyStore: new SqliteDeviceActionPolicyRepository(db, schemaVersion),
      resolveCaller,
      authorize: authorizeCaller,
    }).map((r) => guardRoute(r, DEVICE_DESTRUCTIVE_ACTIONS_PERMISSION)),
    ...createDeviceBitLockerRoute({ keys: intune.bitlocker, audit: keyAudit, authorize: authorizeContext, actor: actorOf }).map(
      (r) => guardRoute(r, DEVICE_BITLOCKER_PERMISSION),
    ),
    ...createDeviceLapsRoute({ credentials: intune.laps, audit: keyAudit, authorize: authorizeContext, actor: actorOf }).map(
      (r) => guardRoute(r, DEVICE_LAPS_PERMISSION),
    ),
  ];

  return {
    routes,
    authenticators,
    offboarding,
    runs: runJobs,
    scheduler,
    close: () => {
      scheduler.stop();
      if (!options.db) db.close();
    },
  };
}
