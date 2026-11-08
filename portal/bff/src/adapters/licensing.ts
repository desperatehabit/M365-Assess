// EPIC-033 Licensing worker-backed providers (T-0863).
//
// The route factories were written against provider seams but never mounted, and
// no adapter bound them to the PowerShell workers, so every §6 endpoint 404'd.
// Two of the entrypoints the routes name were also missing from portal/workers/
// and are added by this ticket:
//
//   get-license-report.ps1         (existing)  consumption + pricing
//   get-license-optimization.ps1   (new)       raw assignments/activity/expiries
//   update-user-license.ps1        (existing)  per-user assign/remove
//   get-license-gates.ps1          (new)       licensing-overlay resolution
//
// Every call signs in through the tenant credential block (createTenantWorker) so
// the BFF never calls Graph itself. Pricing and LicenseChange rows persist through
// the licensing repository; the rest stays live.
import {
  createLicenseChangeProvider,
  type LicenseChangeProvider,
} from "../routes/license-assign.js";
import type {
  LicenseGateFeature,
  LicenseGatesProvider,
  LicenseGatesResponse,
} from "../routes/license-gates.js";
import {
  createLicenseOptimizationProvider,
  type LicenseOptimizationProvider,
} from "../routes/licenses-optimization.js";
import {
  createLicensesProvider,
  type LicensesProvider,
  type LicensesPricingSource,
} from "../routes/licenses.js";
import type { CredentialStoreRow } from "../routes/credentials.js";
import {
  asArray,
  createTenantWorker,
  raiseWorkerError,
  type WorkerRunner,
} from "./workers.js";

export const LICENSE_GATES_WORKER = "get-license-gates.ps1";

export interface LicensingProviders {
  readonly licenses: LicensesProvider;
  readonly licenseChanges: LicenseChangeProvider;
  readonly optimization: LicenseOptimizationProvider;
  readonly gates: LicenseGatesProvider;
}

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
}

function asPlanList(value: unknown): string[] {
  return asArray(value).map((entry) => String(entry));
}

/** Maps the worker's overlay resolution onto the route's gate response. */
export function mapLicenseGates(value: unknown, tenantId: string): LicenseGatesResponse {
  const row = asRecord(value);
  const rawGates = asRecord(row["gates"]);
  const gates: Record<string, LicenseGateFeature> = {};
  for (const [feature, raw] of Object.entries(rawGates)) {
    const entry = asRecord(raw);
    gates[feature] = {
      status: entry["status"] === "gated" ? "gated" : "available",
      requiredPlans: asPlanList(entry["requiredPlans"]),
      missingPlans: asPlanList(entry["missingPlans"]),
    };
  }
  return { tenantId: asString(row["tenantId"], tenantId), gates };
}

export function createLicensingProviders(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
  pricing: LicensesPricingSource,
): LicensingProviders {
  const call = createTenantWorker(run, credentials);

  const gates: LicenseGatesProvider = {
    async getLicenseGates(tenantId: string): Promise<LicenseGatesResponse> {
      const result = await call<unknown>(LICENSE_GATES_WORKER, tenantId, {});
      raiseWorkerError(result);
      return mapLicenseGates(result, tenantId);
    },
  };

  return {
    licenses: createLicensesProvider(run, credentials, pricing),
    licenseChanges: createLicenseChangeProvider(run, credentials),
    optimization: createLicenseOptimizationProvider(run, credentials),
    gates,
  };
}
