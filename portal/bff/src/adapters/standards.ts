// EPIC-008 standards templates, alignment, and runs on real storage (T-0825).
//
// Templates, assignments, and compare rows persist through the db standards repository;
// a template's schedule is a row in the EPIC-007 schedule store. Running a standard
// now enqueues a `standards` job (T-0841): the queue augments the route's envelope
// with a `currentState` map built from the tenant's latest findings, the worker
// runs Invoke-Standard per setting, and the compare rows come back as an artifact
// the BFF ingests through upsertCompare. The catalog classifies standards against
// a tenant's licences only once tenant licence inventory exists (T-0828); until
// then a tenant-scoped catalog request is refused with 501.
import {
  toStandardCompareView,
  toStandardDefinitionView,
  type SqliteRepository,
  type SqliteScheduleRepository,
  type SqliteStandardsRepository,
} from "@m365-assess/db";
import { AppError } from "../errors.js";
import type { JobQueue } from "../jobs/queue.js";
import type { RunWorkerFn } from "../jobs/queue.js";
import type { LicensePreset, TenantLicenseSet } from "../domain/standards-license.js";
import type { AlignmentStore } from "../routes/standards-alignment.js";
import type { StandardsCatalogStore } from "../routes/standards-catalog.js";
import type { StandardsRunQueue, StandardsRunStore } from "../routes/standards-run.js";
import type { StandardsTemplateStore } from "../routes/standards-templates.js";
import type { TenantVariableStore } from "../routes/tenant-variables.js";
import type { VariableEntry, VariableScopes } from "../domain/variable-substitution.js";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TENANT_LICENSES_UNAVAILABLE = "standards.tenant_licenses_unavailable";

export const DEFAULT_CONTROLS_ROOT = fileURLToPath(
  new URL("../../../../src/M365-Assess/controls", import.meta.url),
);

export interface LicensingOverlay {
  readonly description?: string;
  readonly version?: string;
  readonly checks: Readonly<Record<string, readonly string[]>>;
}

export function resolveControlsRoot(controlsRoot?: string): string {
  return controlsRoot && controlsRoot.trim().length > 0
    ? path.resolve(controlsRoot)
    : DEFAULT_CONTROLS_ROOT;
}

function parseLicensingOverlay(raw: string): LicensingOverlay {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { checks: {} };
  }
  const record = parsed as Record<string, unknown>;
  const rawChecks = record["checks"];
  const checks: Record<string, readonly string[]> = {};
  if (typeof rawChecks === "object" && rawChecks !== null && !Array.isArray(rawChecks)) {
    for (const [check, plans] of Object.entries(rawChecks as Record<string, unknown>)) {
      if (Array.isArray(plans)) {
        checks[check] = plans.filter((plan): plan is string => typeof plan === "string");
      }
    }
  }
  return {
    ...(typeof record["description"] === "string" ? { description: record["description"] } : {}),
    ...(typeof record["version"] === "string" ? { version: record["version"] } : {}),
    checks,
  };
}

export async function loadLicensingOverlay(controlsRoot?: string): Promise<LicensingOverlay> {
  const overlayPath = path.join(resolveControlsRoot(controlsRoot), "licensing-overlay.json");
  try {
    return parseLicensingOverlay(await readFile(overlayPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { checks: {} };
    }
    throw error;
  }
}

export function loadLicensingOverlaySync(controlsRoot?: string): LicensingOverlay {
  const overlayPath = path.join(resolveControlsRoot(controlsRoot), "licensing-overlay.json");
  try {
    return parseLicensingOverlay(readFileSync(overlayPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { checks: {} };
    }
    throw error;
  }
}

export const E5_SERVICE_PLANS: readonly string[] = [
  "AAD_PREMIUM_P2",
  "ATP_ENTERPRISE",
  "LOCKBOX_ENTERPRISE",
  "INFORMATION_PROTECTION_COMPLIANCE",
  "COMMUNICATIONS_DLP",
  "AIP_PREMIUM_P2",
  "RMS_S_PREMIUM2",
  "MIP_S_CLP2",
  "COMMUNICATIONS_COMPLIANCE",
  "MICROSOFT_COMMUNICATION_COMPLIANCE",
];

const E5_SUITE_SKUS = new Set([
  "SPE_E5",
  "ENTERPRISEPREMIUM",
  "M365_E5",
  "DEVELOPERPACK_E5",
  "A5",
  "G5",
]);

const E3_SUITE_SKUS = new Set([
  "SPE_E3",
  "ENTERPRISEPACK",
  "M365_E3",
  "SPB",
  "O365_BUSINESS_PREMIUM",
]);

const ADDON_SKU_SERVICE_PLANS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["AAD_PREMIUM_P2", ["AAD_PREMIUM_P2"]],
  ["IDENTITY_GOVERNANCE", ["AAD_PREMIUM_P2"]],
  ["EMSPREMIUM", ["AAD_PREMIUM_P2", "AIP_PREMIUM_P2", "RMS_S_PREMIUM2", "MIP_S_CLP2"]],
  ["EMS_E5", ["AAD_PREMIUM_P2", "AIP_PREMIUM_P2", "RMS_S_PREMIUM2", "MIP_S_CLP2"]],
  ["ATP_ENTERPRISE", ["ATP_ENTERPRISE"]],
  ["THREAT_INTELLIGENCE", ["ATP_ENTERPRISE"]],
  ["LOCKBOX_ENTERPRISE", ["LOCKBOX_ENTERPRISE"]],
  [
    "INFORMATION_PROTECTION_COMPLIANCE",
    [
      "INFORMATION_PROTECTION_COMPLIANCE",
      "COMMUNICATIONS_DLP",
      "AIP_PREMIUM_P2",
      "RMS_S_PREMIUM2",
      "MIP_S_CLP2",
      "COMMUNICATIONS_COMPLIANCE",
      "MICROSOFT_COMMUNICATION_COMPLIANCE",
    ],
  ],
  ["COMMUNICATIONS_DLP", ["COMMUNICATIONS_DLP"]],
  ["AIP_PREMIUM_P2", ["AIP_PREMIUM_P2", "RMS_S_PREMIUM2", "MIP_S_CLP2"]],
  ["RMS_S_PREMIUM2", ["RMS_S_PREMIUM2"]],
  ["MIP_S_CLP2", ["MIP_S_CLP2"]],
  [
    "COMMUNICATIONS_COMPLIANCE",
    ["COMMUNICATIONS_COMPLIANCE", "MICROSOFT_COMMUNICATION_COMPLIANCE"],
  ],
  [
    "MICROSOFT_COMMUNICATION_COMPLIANCE",
    ["COMMUNICATIONS_COMPLIANCE", "MICROSOFT_COMMUNICATION_COMPLIANCE"],
  ],
  ["M365_E5_SECURITY", ["AAD_PREMIUM_P2", "ATP_ENTERPRISE"]],
  [
    "M365_E5_COMPLIANCE",
    [
      "INFORMATION_PROTECTION_COMPLIANCE",
      "COMMUNICATIONS_DLP",
      "AIP_PREMIUM_P2",
      "RMS_S_PREMIUM2",
      "MIP_S_CLP2",
      "COMMUNICATIONS_COMPLIANCE",
      "MICROSOFT_COMMUNICATION_COMPLIANCE",
    ],
  ],
];

function resolveAddonServicePlans(skuKey: string): readonly string[] | undefined {
  for (const [token, plans] of ADDON_SKU_SERVICE_PLANS) {
    if (skuKey === token || skuKey.startsWith(`${token}_`)) {
      return plans;
    }
  }
  return undefined;
}

function isE5SuiteSku(skuKey: string): boolean {
  if (E5_SUITE_SKUS.has(skuKey)) return true;
  if (resolveAddonServicePlans(skuKey) !== undefined) return false;
  return (
    skuKey.includes("E5") ||
    skuKey.includes("ENTERPRISEPREMIUM") ||
    /(?:^|_)([AG]5)(?:_|$)/.test(skuKey)
  );
}

function isE3SuiteSku(skuKey: string): boolean {
  if (E3_SUITE_SKUS.has(skuKey)) return true;
  return skuKey.includes("E3") || skuKey.includes("ENTERPRISEPACK");
}

/**
 * Resolves a tenant's active license inventory rows into the coarse E3/E5 preset
 * and service plans consumed by the standards catalog classifier.
 */
export function createTenantLicenseResolver(
  repo: Pick<SqliteRepository, "listTenantLicenseInventory">,
): (tenantId: string) => Promise<TenantLicenseSet> {
  return async (tenantId: string): Promise<TenantLicenseSet> => {
    const rows = await repo.listTenantLicenseInventory(tenantId);
    let preset: LicensePreset | null = null;
    const servicePlans = new Set<string>();

    for (const row of rows) {
      const units = row.enabledUnits as number | null | undefined;
      if (units !== null && units !== undefined && units <= 0) {
        continue;
      }
      const part = (row.skuPartNumber ?? "").trim().toUpperCase();
      const skuKey = part || row.skuId.trim().toUpperCase();
      if (!skuKey) continue;

      if (part.length > 0) {
        servicePlans.add(part);
      }

      const addonPlans = resolveAddonServicePlans(skuKey);
      if (addonPlans) {
        for (const plan of addonPlans) servicePlans.add(plan);
      }

      if (isE5SuiteSku(skuKey)) {
        preset = "E5";
        for (const plan of E5_SERVICE_PLANS) servicePlans.add(plan);
      } else if (isE3SuiteSku(skuKey) && preset !== "E5") {
        preset = "E3";
      }
    }

    return { preset, servicePlans: [...servicePlans] };
  };
}

/** Registry definitions, curated overrides applied, with the check reference renamed. */
export function createStandardsCatalogStore(repo: SqliteStandardsRepository): StandardsCatalogStore {
  return {
    listDefinitions: async () => (await repo.listDefinitions()).map(toStandardDefinitionView),
  };
}

export async function unavailableTenantLicenses(): Promise<TenantLicenseSet> {
  throw new AppError(
    TENANT_LICENSES_UNAVAILABLE,
    "tenant licence inventory is not available yet: the catalog cannot be classified for a tenant",
    501,
  );
}

export function createStandardsTemplateStore(repo: SqliteStandardsRepository): StandardsTemplateStore {
  return {
    listStandardTemplates: () => repo.listStandardTemplates(),
    getStandardTemplate: (templateId) => repo.getStandardTemplate(templateId),
    createStandardTemplate: ({ settings, ...input }) =>
      repo.createStandardTemplate({ ...input, ...(settings ? { settings: [...settings] } : {}) }),
    updateStandardTemplate: (templateId, patch) => repo.updateStandardTemplate(templateId, patch),
    deleteStandardTemplate: (templateId) => repo.deleteStandardTemplate(templateId),
    listTemplateAssignments: () => repo.listTemplateAssignments(),
    upsertTemplateAssignment: (input) => repo.upsertTemplateAssignment(input),
  };
}

/** Compare rows with the check reference renamed for the routes. */
export function createStandardsAlignmentStore(repo: SqliteStandardsRepository): AlignmentStore {
  return {
    listCompare: async (tenantId) => (await repo.listCompare(tenantId)).map(toStandardCompareView),
  };
}

export function createStandardsRunStore(
  standards: SqliteStandardsRepository,
  schedules: SqliteScheduleRepository,
): StandardsRunStore {
  return {
    getStandardTemplate: (templateId) => standards.getStandardTemplate(templateId),
    updateStandardTemplate: (templateId, patch) => standards.updateStandardTemplate(templateId, patch),
    createSchedule: (input) => schedules.createSchedule({ ...input, targetScope: { ...input.targetScope } }),
    softDeleteSchedule: (scheduleId) => schedules.softDeleteSchedule(scheduleId),
  };
}

/** The run-now queue: enqueues the route's envelope as a `standards` job. */
export function createStandardsRunQueue(options: {
  jobs: Pick<JobQueue, "enqueue">;
  findings: Pick<SqliteRepository, "listFindings">;
  latestRunId: (tenantId: string) => Promise<string | null>;
  storageRoot: string;
}): StandardsRunQueue {
  const { jobs, findings, latestRunId, storageRoot } = options;
  return {
    async enqueue(envelope) {
      const tenantId = (envelope as { tenantId?: string }).tenantId ?? "";
      const runId = await latestRunId(tenantId);
      const rows = runId ? await findings.listFindings(tenantId, runId) : [];
      const currentState = rows.map((row) => ({ key: row.checkId, value: parseCurrentValue(row.currentValue) }));
      const augmented = {
        ...(envelope as Record<string, unknown>),
        payload: { ...((envelope as { payload?: Record<string, unknown> }).payload ?? {}), currentState },
      };
      const contextRef = (augmented.payload as Record<string, unknown>)["contextRef"];
      if (typeof contextRef === "string" && contextRef) {
        const contextPath = path.resolve(storageRoot, contextRef);
        await mkdir(path.dirname(contextPath), { recursive: true, mode: 0o700 });
        await writeFile(contextPath, JSON.stringify(augmented), { mode: 0o600 });
      }
      return jobs.enqueue(augmented);
    },
  };
}

function parseCurrentValue(value: string | null): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Resolves a tenant's variables (global + tenant) for run-now substitution (SPEC §4.5). */
export function createStandardsVariableResolver(
  variables: Pick<TenantVariableStore, "listVariables">,
): (tenantId: string) => Promise<VariableScopes> {
  return async (tenantId) => {
    const rows = await variables.listVariables();
    const toEntry = (row: (typeof rows)[number]): VariableEntry => ({ name: row.name, value: row.value });
    return {
      global: rows.filter((row) => row.tenantId === null).map(toEntry),
      tenant: rows.filter((row) => row.tenantId === tenantId).map(toEntry),
    };
  };
}

export const STANDARDS_COMPARE_ARTIFACT = "compare-rows.json";

export interface StandardsIngestionOptions {
  readonly standards: Pick<SqliteStandardsRepository, "upsertCompare">;
  readonly storageRoot: string;
}

/**
 * Stores a succeeded standards run's compare rows before the queue reports the
 * job finished, so the alignment views show the run only once its rows are
 * readable. A missing artifact is not an error: a report-only run with no
 * settings writes no rows.
 */
export function withStandardsIngestion(runWorker: RunWorkerFn, options: StandardsIngestionOptions): RunWorkerFn {
  const { standards, storageRoot } = options;
  return async (envelope, signal) => {
    const result = await runWorker(envelope, signal);
    if (envelope.jobType !== "standards" || result.status !== "succeeded") {
      return result;
    }
    const payload = envelope.payload as unknown as Record<string, unknown>;
    const outputRef = typeof payload["outputRef"] === "string" ? payload["outputRef"] : "";
    if (!outputRef) return result;
    try {
      const raw = await readFile(path.resolve(storageRoot, outputRef, STANDARDS_COMPARE_ARTIFACT), "utf8");
      const rows = JSON.parse(raw) as ReadonlyArray<{
        tenantId: string;
        checkId: string;
        current: unknown;
        expected: unknown;
        state: string;
        lastRunAt: string | null;
      }>;
      if (rows.length > 0) {
        await standards.upsertCompare(
          rows.map((row) => ({
            tenantId: row.tenantId,
            checkId: row.checkId,
            current: row.current,
            expected: row.expected,
            state: row.state as never,
            lastRunAt: row.lastRunAt,
          })),
        );
      }
      return result;
    } catch (error) {
      const message = `standards compare output unreadable: ${error instanceof Error ? error.message : String(error)}`;
      return { ...result, status: "failed", error: { code: "standards.output_unreadable", message, retryable: false } };
    }
  };
}
