// Repository contract — the boundary every feature depends on (ADR-0015).
// This file names no storage engine and contains no SQL.

export type TenantSource = "direct" | "gdap";
export type TenantStatus = "active" | "excluded" | "error";
export type RunTrigger = "manual" | "schedule" | "api";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type JobState = "queued" | "running" | "done" | "failed";
export type FindingStatus = "Pass" | "Fail" | "Warning" | "Review" | "Info" | "Skipped";
export type Severity = "Critical" | "High" | "Medium" | "Low" | "Info";
export type RemediationMode = "manual" | "automated";
export type AuditActorType = "user" | "apiClient" | "system";
export type AuditSource = "request" | "schedule" | "remediation";
export type AuditResult = "success" | "failure";

export interface Tenant {
  id: string;
  displayName: string | null;
  defaultDomain: string | null;
  initialDomain: string | null;
  source: TenantSource;
  status: TenantStatus;
  excluded: boolean;
  lastRunAt: string | null;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface TenantCredential {
  id: string;
  tenantId: string;
  authMethod: string;
  clientId: string;
  secretRef: string;
  thumbprint: string | null;
  environment: string;
  expiresOn: string | null;
  lastValidated: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  tenantId: string;
  trigger: RunTrigger;
  sections: string[];
  startedAt: string | null;
  finishedAt: string | null;
  status: RunStatus;
  artifactPath: string | null;
  summaryCounts: Record<string, unknown> | null;
  provenance: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunSection {
  id: string;
  runId: string;
  tenantId: string;
  section: string;
  collector: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Finding {
  id: string;
  runId: string;
  tenantId: string;
  checkId: string;
  controlName: string | null;
  category: string | null;
  collector: string | null;
  status: FindingStatus;
  severity: Severity | null;
  currentValue: string | null;
  recommendedValue: string | null;
  evidence: Record<string, unknown> | null;
  frameworkRefs: string[];
  remediationMode: RemediationMode | null;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  type: string;
  tenantId: string | null;
  payload: Record<string, unknown> | null;
  state: JobState;
  attempts: number;
  progress: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actorUserId: string | null;
  actorType: AuditActorType;
  tenantId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  result: AuditResult;
  error: string | null;
  source: AuditSource;
  correlationId: string | null;
  createdAt: string;
}

export type TenantInput = Omit<Tenant, "createdAt" | "updatedAt" | "deletedAt"> &
  Partial<Pick<Tenant, "createdAt" | "updatedAt" | "deletedAt">>;
export type TenantCredentialInput = Omit<TenantCredential, "createdAt" | "updatedAt"> &
  Partial<Pick<TenantCredential, "createdAt" | "updatedAt">>;
export type RunInput = Omit<Run, "createdAt" | "updatedAt"> &
  Partial<Pick<Run, "createdAt" | "updatedAt">>;
export type RunSectionInput = Omit<RunSection, "createdAt" | "updatedAt"> &
  Partial<Pick<RunSection, "createdAt" | "updatedAt">>;
export type FindingInput = Omit<Finding, "createdAt" | "updatedAt"> &
  Partial<Pick<Finding, "createdAt" | "updatedAt">>;
export type JobInput = Omit<Job, "createdAt" | "updatedAt"> &
  Partial<Pick<Job, "createdAt" | "updatedAt">>;
export type AuditEventInput = Omit<AuditEvent, "createdAt"> &
  Partial<Pick<AuditEvent, "createdAt">>;

export interface ListOptions {
  includeDeleted?: boolean;
}

export interface JobStateUpdate {
  progress?: Record<string, unknown> | null;
  attempts?: number;
}

/**
 * The only surface feature code may depend on. Tenant-scoped reads require the
 * tenant id, rows with `deletedAt` set are hidden unless explicitly requested,
 * and audit events can only be appended (ADR-0015).
 */
export interface Repository {
  readonly schemaVersion: number;

  close(): void;

  getTenant(tenantId: string, options?: ListOptions): Promise<Tenant | undefined>;
  listTenants(options?: ListOptions): Promise<Tenant[]>;
  upsertTenant(input: TenantInput): Promise<Tenant>;
  softDeleteTenant(tenantId: string, options?: { now?: string }): Promise<boolean>;

  getTenantCredential(tenantId: string): Promise<TenantCredential | undefined>;
  listTenantCredentials(tenantId: string): Promise<TenantCredential[]>;
  upsertTenantCredential(input: TenantCredentialInput): Promise<TenantCredential>;

  createRun(input: RunInput): Promise<Run>;
  getRun(tenantId: string, runId: string): Promise<Run | undefined>;
  listRuns(tenantId: string): Promise<Run[]>;

  createRunSection(input: RunSectionInput): Promise<RunSection>;
  listRunSections(tenantId: string, runId: string): Promise<RunSection[]>;

  createFinding(input: FindingInput): Promise<Finding>;
  listFindings(tenantId: string, runId: string): Promise<Finding[]>;

  createJob(input: JobInput): Promise<Job>;
  getJob(jobId: string): Promise<Job | undefined>;
  listJobs(tenantId: string): Promise<Job[]>;
  updateJobState(jobId: string, state: JobState, update?: JobStateUpdate): Promise<Job | undefined>;

  appendAuditEvent(input: AuditEventInput): Promise<AuditEvent>;
  listAuditEvents(tenantId?: string): Promise<AuditEvent[]>;
}

export class SchemaVersionError extends Error {
  readonly code = "db.unsupported_schema_version";
  readonly current: number;
  readonly expected: number;

  constructor(current: number, expected: number) {
    super(
      `database schema version ${current} is not supported by this build (expected ${expected})`,
    );
    this.name = "SchemaVersionError";
    this.current = current;
    this.expected = expected;
  }
}
