// Audit search coverage API (EPIC-032 SPEC.md §3.3, §4.2, §5, §6, §7, §8, §11.3; T-0624).
// Exposes GET /v1/tenants/:tenantId/audit/coverage. Coverage is computed live
// (SPEC §11.3): the route reads the tenant's search history and the latest
// run-results finding, dispatches the get-audit-coverage worker for the live
// tenant audit configuration, and caches the result through the T-0621
// AuditCoverage repository. Gaps reference the COMPLIANCE-AUDIT-001 finding
// from the run results and link to the EPIC-006 audit-enablement remediation
// (prose). Coverage view is read-only: it requires audit.read intersected
// with the caller tenant scope and writes no tenant configuration.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type {
  AuditCoverage,
  AuditCoverageInput,
  AuditSearch,
  Finding,
  Run,
} from "@m365-assess/db";

export const AUDIT_COVERAGE_PATH = "/v1/tenants/:tenantId/audit/coverage";
export const AUDIT_COVERAGE_PERMISSION = "audit.read";
export const AUDIT_COVERAGE_UNAUTHENTICATED = "request.unauthenticated";
export const AUDIT_COVERAGE_CHECK_ID = "COMPLIANCE-AUDIT-001";

export interface AuditCoverageFindingRef {
  readonly id: string;
  readonly runId: string;
  readonly checkId: string;
}

export interface AuditCoverageGap {
  readonly checkId: string;
  readonly title: string;
  readonly description: string;
  readonly remediation: string;
  readonly findingId: string | null;
  readonly runId: string | null;
}

export interface AuditCoverageWorkerReport {
  readonly tenantId: string;
  readonly auditEnabled: boolean;
  readonly lastSearchAt: string | null;
  readonly gaps: readonly AuditCoverageGap[];
}

export interface AuditCoverageJobInput {
  readonly lastSearchAt: string | null;
  readonly finding: AuditCoverageFindingRef | null;
}

// Worker-backed seam for the live coverage computation: the production wiring
// dispatches the get-audit-coverage worker per call. Depending on the seam
// keeps Purview and process code out of the BFF.
export interface AuditCoverageProvider {
  getAuditCoverage(tenantId: string, input: AuditCoverageJobInput): Promise<AuditCoverageWorkerReport>;
}

// Structural seam over the T-0621 AuditRepository coverage surface. The real
// repository satisfies this shape; depending on the seam keeps SQL out of the
// BFF. The repository writes the AuditEvent for every mutation (ADR-0015).
export interface AuditCoverageStore {
  listAuditSearches(tenantId: string): Promise<AuditSearch[]>;
  upsertAuditCoverage(input: AuditCoverageInput): Promise<AuditCoverage>;
  getAuditCoverage(tenantId: string): Promise<AuditCoverage | undefined>;
}

// Structural seam over the run-results findings (T-0046): the latest run
// carrying a check's finding, so coverage gaps can reference it.
export interface AuditCoverageFindings {
  listRuns(tenantId: string): Promise<Run[]>;
  listFindings(tenantId: string, runId: string): Promise<Finding[]>;
}

export interface AuditCoverageCaller extends Caller {
  readonly userId?: string;
}

export type AuditCoverageAuthorizer = (
  caller: AuditCoverageCaller,
  permission: string,
) => void | Promise<void>;

export interface AuditCoverageRouteOptions {
  readonly provider: AuditCoverageProvider;
  readonly store: AuditCoverageStore;
  readonly findings: AuditCoverageFindings;
  readonly resolveCaller: (ctx: RequestContext) => AuditCoverageCaller | undefined;
  readonly authorize?: AuditCoverageAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(AUDIT_COVERAGE_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => AuditCoverageCaller | undefined,
  ctx: RequestContext,
): AuditCoverageCaller {
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

async function requireAuditReadPermission(
  options: AuditCoverageRouteOptions,
  caller: AuditCoverageCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, AUDIT_COVERAGE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(AUDIT_COVERAGE_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${AUDIT_COVERAGE_PERMISSION}`, 403);
  }
}

/** Newest saved-search run instant across the tenant's search history, or null. */
export function lastSearchAtOf(searches: readonly AuditSearch[]): string | null {
  let latest: string | null = null;
  for (const search of searches) {
    if (search.lastRunAt && (latest === null || search.lastRunAt > latest)) {
      latest = search.lastRunAt;
    }
  }
  return latest;
}

/** The latest run-results finding for a check, searching finished runs newest first. */
export async function latestAuditFinding(
  findings: AuditCoverageFindings,
  tenantId: string,
  checkId: string,
): Promise<AuditCoverageFindingRef | undefined> {
  const runs = (await findings.listRuns(tenantId))
    .filter((run) => run.status === "succeeded" || run.status === "partial")
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  for (const run of runs) {
    const match = (await findings.listFindings(tenantId, run.id)).find(
      (finding) => finding.checkId === checkId,
    );
    if (match) {
      return { id: match.id, runId: run.id, checkId: match.checkId };
    }
  }
  return undefined;
}

/**
 * The reporting-cache seam: the single place the route persists a computed
 * coverage report. The T-0621 AuditCoverage row stores gaps as check-id
 * strings; the reporting-DB cache can replace this function later without
 * changing the route contract.
 */
export async function cacheAuditCoverage(
  store: AuditCoverageStore,
  tenantId: string,
  live: AuditCoverageWorkerReport,
): Promise<AuditCoverage> {
  return store.upsertAuditCoverage({
    tenantId,
    auditEnabled: live.auditEnabled,
    lastSearchAt: live.lastSearchAt,
    gaps: live.gaps.map((gap) => gap.checkId),
  });
}

export function createAuditCoverageRoutes(options: AuditCoverageRouteOptions): Route[] {
  return [
    // GET /v1/tenants/:tenantId/audit/coverage
    {
      method: "GET",
      path: AUDIT_COVERAGE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireAuditReadPermission(options, caller);

        const lastSearchAt = lastSearchAtOf(await options.store.listAuditSearches(tenantId));
        const finding = await latestAuditFinding(options.findings, tenantId, AUDIT_COVERAGE_CHECK_ID);
        const live = await options.provider.getAuditCoverage(tenantId, {
          lastSearchAt,
          finding: finding ?? null,
        });
        await cacheAuditCoverage(options.store, tenantId, live);
        return {
          status: 200,
          body: live,
        };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); the T-0751 publication ticket merges this fragment into the
// served document.
export const AUDIT_COVERAGE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/audit/coverage": {
      get: {
        operationId: "getAuditCoverage",
        summary: "Report a tenant's audit search coverage",
        description:
          "Computes coverage live (SPEC §11.3): the worker reads the tenant's audit " +
          "configuration at request time and the route caches the result through the " +
          "T-0621 AuditCoverage repository. Gaps reference the COMPLIANCE-AUDIT-001 " +
          "finding from the run results and link to the EPIC-006 remediation.",
        permission: AUDIT_COVERAGE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "The tenant's audit coverage.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AuditCoverage" },
              },
            },
          },
          "401": { description: "Authentication required." },
          "403": {
            description: "The caller lacks audit.read or the tenant is out of scope.",
          },
        },
      },
    },
  },
  schemas: {
    AuditCoverage: {
      type: "object",
      additionalProperties: false,
      required: ["tenantId", "auditEnabled", "lastSearchAt", "gaps"],
      properties: {
        tenantId: { type: "string" },
        auditEnabled: {
          type: "boolean",
          description: "Whether unified audit log ingestion is enabled for the tenant.",
        },
        lastSearchAt: {
          type: ["string", "null"],
          description:
            "Newest saved-search run instant, or null when the tenant has no search history.",
        },
        gaps: {
          type: "array",
          items: { $ref: "#/components/schemas/AuditCoverageGap" },
        },
      },
    },
    AuditCoverageGap: {
      type: "object",
      additionalProperties: false,
      required: ["checkId", "title", "description", "remediation", "findingId", "runId"],
      properties: {
        checkId: {
          type: "string",
          description: "The check the gap ties to, e.g. COMPLIANCE-AUDIT-001.",
        },
        title: { type: "string" },
        description: { type: "string" },
        remediation: {
          type: "string",
          description: "EPIC-006 audit-enablement remediation prose.",
        },
        findingId: {
          type: ["string", "null"],
          description: "The run-results finding the gap references, when one exists.",
        },
        runId: {
          type: ["string", "null"],
          description: "The run that produced the finding.",
        },
      },
    },
  },
} as const;
