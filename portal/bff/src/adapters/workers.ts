// Worker-backed runners and the tenant credential block (T-0822).
//
// Feature workers sign in to their tenant from a `credential` block in the job file
// (T-0826): the credential reference plus the non-secret credential row. The BFF never
// handles secret material; the worker resolves it in its own process. `credentialBlock`
// is shared by every worker-backed provider (T-0818..T-0820).
import { AppError } from "../errors.js";
import {
  FeatureWorkerError,
  runFeatureWorker,
  type FeatureJob,
  type RunFeatureWorkerOptions,
} from "../jobs/feature-worker.js";
import { DEFAULT_JOB_TIMEOUT_MS } from "../jobs/supervisor.js";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import type { GdapSyncResult, GdapSyncRunner } from "../routes/gdap.js";
import {
  parseOnboardProgressLine,
  type OnboardRunner,
  type OnboardWorkerResult,
} from "../routes/onboard.js";
import type { TestConnectionResult, TestConnectionRunner } from "../routes/test-connection.js";

export const NO_CREDENTIAL = "tenant.credential_missing";
export const NO_OPERATOR_CREDENTIAL = "tenant.operator_credential_missing";
export const WORKER_FAILED = "worker.failed";

/**
 * Which app registration a job signs in with (T-0917). Reads and assessments
 * keep the reader credential. Write workers request `operator`, provisioned
 * only by the opt-in onboarding step; they never fall back to the reader app.
 */
export type CredentialPurpose = "reader" | "operator";

export interface CredentialBlock {
  readonly credentialRef: string;
  readonly purpose: CredentialPurpose;
  /** The non-secret credential row fields Resolve-TenantCredential reads. */
  readonly record: Pick<
    CredentialRecord,
    "tenantId" | "authMethod" | "clientId" | "secretRef" | "thumbprint" | "environment"
  > & { readonly purpose?: CredentialPurpose };
}

export function credentialRefForPurpose(
  tenantId: string,
  purpose: CredentialPurpose = "reader",
): string {
  return purpose === "operator"
    ? `tenants/${tenantId}/operator-credential`
    : `tenants/${tenantId}/credential`;
}

export function toCredentialBlock(
  credential: CredentialRecord,
  purpose: CredentialPurpose = credential.purpose ?? "reader",
): CredentialBlock {
  return {
    credentialRef: credentialRefForPurpose(credential.tenantId, purpose),
    purpose,
    record: {
      tenantId: credential.tenantId,
      authMethod: credential.authMethod,
      clientId: credential.clientId,
      secretRef: credential.secretRef,
      thumbprint: credential.thumbprint,
      environment: credential.environment,
      purpose,
    },
  };
}

/** The credential block for `tenantId`, or a 409 when the purpose has no credential. */
export async function credentialBlock(
  credentials: CredentialStoreRow,
  tenantId: string,
  purpose: CredentialPurpose = "reader",
): Promise<CredentialBlock> {
  const row = await credentials.getCredential(tenantId, purpose);
  if (!row) {
    if (purpose === "operator") {
      throw new AppError(
        NO_OPERATOR_CREDENTIAL,
        `tenant '${tenantId}' has no operator credential; onboarding must grant write access before write work can run`,
        409,
      );
    }
    throw new AppError(NO_CREDENTIAL, `tenant '${tenantId}' has no credential; set one before running tenant work`, 409);
  }
  return toCredentialBlock(row, purpose);
}

/** Runs a worker entrypoint; injectable so providers are testable without pwsh. */
export type WorkerRunner = <T>(
  entrypoint: string,
  job: FeatureJob,
  options?: WorkerRunOptions,
) => Promise<T>;

/** Per-call worker options (progress lines, timeout overrides). */
export type WorkerRunOptions = Pick<RunFeatureWorkerOptions, "onProgressLine" | "timeoutMs">;

export function createWorkerRunner(options: RunFeatureWorkerOptions): WorkerRunner {
  return (entrypoint, job, overrides) =>
    runFeatureWorker(entrypoint, job, {
      ...options,
      ...(overrides?.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
      ...(overrides?.onProgressLine !== undefined
        ? { onProgressLine: overrides.onProgressLine }
        : {}),
    });
}

/** Per-call credential purpose; omitted means reader (assessment/read jobs). */
export interface TenantWorkerOptions {
  readonly purpose?: CredentialPurpose;
}

/** Calls entrypoints for one tenant's work with `(entrypoint, tenantId, fields, options)`. */
export type TenantWorkerCall = <T>(
  entrypoint: string,
  tenantId: string,
  fields: Record<string, unknown>,
  options?: TenantWorkerOptions,
) => Promise<T>;

/**
 * Runs entrypoints for one tenant, adding the tenant's credential block for
 * Connect-WorkerTenant (T-0826) and mapping a failed worker to a 502 carrying its first
 * diagnostic line; the worker has already scrubbed secrets from it. Write adapters
 * pass `{ purpose: "operator" }`; everything else keeps the reader credential.
 */
export function createTenantWorker(run: WorkerRunner, credentials: CredentialStoreRow): TenantWorkerCall {
  return async function call<T>(
    entrypoint: string,
    tenantId: string,
    fields: Record<string, unknown>,
    options?: TenantWorkerOptions,
  ): Promise<T> {
    const purpose = options?.purpose ?? "reader";
    const job = { tenantId, credential: await credentialBlock(credentials, tenantId, purpose), ...fields };
    try {
      return await run<T>(entrypoint, job);
    } catch (error) {
      if (error instanceof FeatureWorkerError) {
        const detail = error.diagnostics.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
        throw new AppError(WORKER_FAILED, detail ? `${error.message}: ${detail}` : error.message, 502);
      }
      throw error;
    }
  };
}

/** Calls T-0007 envelope workers with `(entrypoint, tenantId, payload, options)`. */
export type EnvelopeWorkerCall = <T>(
  entrypoint: string,
  tenantId: string,
  payload: Record<string, unknown>,
  options?: TenantWorkerOptions,
) => Promise<T>;

/**
 * The EPIC-011..013 workers read the T-0007 envelope: `schemaVersion`, `tenantId`, a
 * `correlationId`, and their inputs under `payload`. The credential block stays at the
 * top level, where Connect-WorkerTenant reads it. Write adapters pass
 * `{ purpose: "operator" }`; everything else keeps the reader credential.
 */
export function createEnvelopeWorker(run: WorkerRunner, credentials: CredentialStoreRow): EnvelopeWorkerCall {
  const call = createTenantWorker(run, credentials);
  return <T>(
    entrypoint: string,
    tenantId: string,
    payload: Record<string, unknown>,
    options?: TenantWorkerOptions,
  ) =>
    call<T>(
      entrypoint,
      tenantId,
      { schemaVersion: "v1", correlationId: globalThis.crypto.randomUUID(), payload },
      options,
    );
}

/**
 * Normalize a worker's list output. `$list | ConvertTo-Json` unrolls the pipeline, so a
 * one-item list arrives as a bare object and an empty one as no output at all.
 */
export function asArray<T>(value: T | readonly T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}

/** Some workers report failures as `{ error, message, statusCode }` rather than throwing. */
export function raiseWorkerError(result: unknown): void {
  if (typeof result === "object" && result !== null && "error" in result && "statusCode" in result) {
    const r = result as { error: string; message?: string; statusCode: number };
    throw new AppError(r.error, r.message ?? r.error, r.statusCode);
  }
}

export function createTestConnectionRunner(run: WorkerRunner): TestConnectionRunner {
  return async (tenantId, credential) => {
    if (!credential) {
      return {
        tenantId,
        success: false,
        testedAt: new Date().toISOString(),
        services: [{ service: "Graph", status: "fail", connected: false, error: "tenant has no credential" }],
      };
    }
    return run<TestConnectionResult>("test-tenant-connection.ps1", {
      tenantId,
      credential: toCredentialBlock(credential),
    });
  };
}

export function createOnboardRunner(run: WorkerRunner): OnboardRunner {
  return (tenantId, input, progress) =>
    run<OnboardWorkerResult>(
      "onboard-tenant.ps1",
      {
        tenantId,
        confirmed: input.confirmed === true,
        createNew: input.createNew === true,
        ...(input.adminUpn ? { adminUpn: input.adminUpn } : {}),
        ...(input.appDisplayName ? { appDisplayName: input.appDisplayName } : {}),
        ...(input.clientId ? { clientId: input.clientId } : {}),
        ...(input.certificateThumbprint
          ? { certificateThumbprint: input.certificateThumbprint }
          : {}),
        ...(input.includeWritePermissions
          ? {
              includeWritePermissions: true,
              writePermissionGroups: [...(input.writePermissionGroups ?? [])],
              ...(input.confirmDangerous ? { confirmDangerous: true } : {}),
              ...(input.replaceWriteGroups ? { replaceWriteGroups: true } : {}),
            }
          : {}),
      },
      {
        // Onboarding waits for up to three admin sign-ins; keep the 30-minute ceiling
        // the job supervisor uses rather than the 5-minute feature-worker default.
        timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
        ...(progress
          ? {
              onProgressLine: (line: string) => {
                const event = parseOnboardProgressLine(line);
                if (event) {
                  progress(event);
                }
              },
            }
          : {}),
      },
    );
}

/** GDAP discovery runs as the partner (MSP) tenant, using that tenant's own credential. */
export function createGdapSyncRunner(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
  partnerTenantId: string,
): GdapSyncRunner {
  return async () =>
    run<GdapSyncResult>("sync-gdap-tenants.ps1", {
      tenantId: partnerTenantId,
      credential: await credentialBlock(credentials, partnerTenantId),
    });
}
