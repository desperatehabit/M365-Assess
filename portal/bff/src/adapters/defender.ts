// EPIC-019 Defender worker-backed providers (T-0849).
//
// The route factories were written against provider seams but never mounted, and
// no adapter bound them to the PowerShell workers. This module does that:
//
//   status         get-defender-status.ps1        (flat job fields)
//   deploy         deploy-defender-policies.ps1   (plan = dry run, apply = live)
//   vulnerabilities get-tvm-vulnerabilities.ps1   (CVE list and device drill-through)
//   mdeOnboarding  get-mde-onboarding.ps1
//
// Every call signs in through the tenant credential block (createTenantWorker) so
// the BFF never calls Graph itself. CVE exceptions and deployment templates are
// portal-local records and stay in their repositories.
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  DefenderDeployOptions,
  DefenderDeployPlan,
  DefenderDeployProvider,
  DefenderDeployResult,
  DefenderDeployAreaPlan,
  DefenderDeployAreaResult,
} from "../routes/defender-deploy.js";
import type {
  DefenderStatus,
  DefenderStatusProvider,
} from "../routes/defender-status.js";
import type {
  MdeOnboarding,
  MdeOnboardingProvider,
} from "../routes/defender-mde-onboarding.js";
import type {
  TvmVulnerabilitiesFilter,
  TvmVulnerabilitiesPage,
  TvmVulnerabilitiesProvider,
  TvmVulnerabilityDevicesPage,
} from "../routes/defender-vulnerabilities.js";
import {
  asArray,
  createTenantWorker,
  raiseWorkerError,
  type WorkerRunner,
} from "./workers.js";

export interface DefenderProviders {
  readonly status: DefenderStatusProvider;
  readonly deploy: DefenderDeployProvider;
  readonly vulnerabilities: TvmVulnerabilitiesProvider;
  readonly mdeOnboarding: MdeOnboardingProvider;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function deployFields(options: DefenderDeployOptions, dryRun: boolean): Record<string, unknown> {
  return {
    policyAreas: [...options.policyAreas],
    targetScope: options.targetScope,
    overwrite: options.overwrite,
    dryRun,
    saveAsTemplate: options.saveAsTemplate,
    ...(options.templateName ? { templateName: options.templateName } : {}),
  };
}

export function createDefenderProviders(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
): DefenderProviders {
  const call = createTenantWorker(run, credentials);

  return {
    status: {
      async getDefenderStatus(tenantId: string): Promise<DefenderStatus> {
        const result = await call<unknown>("get-defender-status.ps1", tenantId, {});
        raiseWorkerError(result);
        const record = asRecord(result);
        return {
          tenantId: typeof record["tenantId"] === "string" ? record["tenantId"] : tenantId,
          areas: asArray(record["areas"]) as DefenderStatus["areas"],
        };
      },
    },

    deploy: {
      async planDeploy(tenantId, options): Promise<DefenderDeployPlan> {
        const result = await call<unknown>(
          "deploy-defender-policies.ps1",
          tenantId,
          deployFields(options, true),
        );
        raiseWorkerError(result);
        const record = asRecord(result);
        return {
          tenantId,
          plans: asArray(record["plans"]) as readonly DefenderDeployAreaPlan[],
          allValid: record["allValid"] !== false,
          overwrite: options.overwrite,
        };
      },

      async executeDeploy(tenantId, options): Promise<DefenderDeployResult> {
        const result = await call<unknown>(
          "deploy-defender-policies.ps1",
          tenantId,
          deployFields(options, false),
        );
        raiseWorkerError(result);
        const record = asRecord(result);
        // The worker keeps the save-as-template draft (areas + policyJson) under
        // `templateDraft`; the route persists `policyJson` directly.
        const draft = asRecord(record["templateDraft"]);
        return {
          success: record["success"] !== false,
          state: (typeof record["state"] === "string"
            ? record["state"]
            : record["success"] === false
              ? "failed"
              : "succeeded") as DefenderDeployResult["state"],
          tenantId,
          plans: asArray(record["plans"]) as readonly DefenderDeployAreaPlan[],
          results: asArray(record["results"]) as readonly DefenderDeployAreaResult[],
          auditEvents: asArray(record["auditEvents"]) as readonly Record<string, unknown>[],
          ...(typeof record["policyJson"] === "object" && record["policyJson"] !== null
            ? { policyJson: record["policyJson"] as Record<string, unknown> }
            : draft["policyJson"] !== undefined
              ? { policyJson: asRecord(draft["policyJson"]) }
              : {}),
          ...(typeof record["error"] === "string" ? { error: record["error"] } : {}),
        };
      },
    },

    vulnerabilities: {
      async listVulnerabilities(
        tenantId: string,
        filter: TvmVulnerabilitiesFilter,
      ): Promise<TvmVulnerabilitiesPage> {
        const result = await call<unknown>("get-tvm-vulnerabilities.ps1", tenantId, {
          ...(filter.severity ? { severity: filter.severity } : {}),
          ...(filter.software ? { software: filter.software } : {}),
          ...(filter.device ? { device: filter.device } : {}),
          ...(filter.search ? { search: filter.search } : {}),
          top: filter.limit,
          ...(filter.cursor ? { cursor: filter.cursor } : {}),
        });
        raiseWorkerError(result);
        return asVulnerabilitiesPage(result, tenantId);
      },

      async listVulnerabilityDevices(
        tenantId: string,
        cveId: string,
        pagination: { readonly cursor: string | null; readonly limit: number },
      ): Promise<TvmVulnerabilityDevicesPage> {
        const result = await call<unknown>("get-tvm-vulnerabilities.ps1", tenantId, {
          cveId,
          top: pagination.limit,
          ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
        });
        raiseWorkerError(result);
        const record = asRecord(result);
        return {
          tenantId: typeof record["tenantId"] === "string" ? record["tenantId"] : tenantId,
          cve: typeof record["cve"] === "string" ? record["cve"] : cveId,
          totalCount:
            typeof record["totalCount"] === "number"
              ? record["totalCount"]
              : asArray(record["items"]).length,
          items: asArray(record["items"]) as TvmVulnerabilityDevicesPage["items"],
          nextCursor: typeof record["nextCursor"] === "string" ? record["nextCursor"] : null,
        };
      },
    },

    mdeOnboarding: {
      async getMdeOnboarding(tenantId: string): Promise<MdeOnboarding> {
        const result = await call<unknown>("get-mde-onboarding.ps1", tenantId, {});
        raiseWorkerError(result);
        const record = asRecord(result);
        return {
          ...(record as unknown as MdeOnboarding),
          tenantId: typeof record["tenantId"] === "string" ? record["tenantId"] : tenantId,
        };
      },
    },
  };
}

function asVulnerabilitiesPage(value: unknown, tenantId: string): TvmVulnerabilitiesPage {
  const record = asRecord(value);
  const items = asArray(record["items"]);
  return {
    tenantId: typeof record["tenantId"] === "string" ? record["tenantId"] : tenantId,
    totalCount: typeof record["totalCount"] === "number" ? record["totalCount"] : items.length,
    items: items as TvmVulnerabilitiesPage["items"],
    nextCursor: typeof record["nextCursor"] === "string" ? record["nextCursor"] : null,
  };
}
