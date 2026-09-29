// Mailbox reports read (EPIC-020 SPEC.md §3.7, §5, §6; T-0381).
// Exposes GET /v1/tenants/:tenantId/mailbox-reports serving the §3.7 report
// set — mailbox statistics/activity, mailbox permissions, calendar
// permissions, forwarding, and mail-flow statistics — through one `?report=`
// selector. Each report reuses the module collectors (`Get-MailboxSummary`,
// `Get-MailboxPermissionReport`, `Get-MailFlowReport`) via the injected
// provider, which is backed by the worker queue (T-0010) running read-only
// EXO jobs live; mailbox objects are never mirrored, this module holds no
// M365 SDK call, and it issues no tenant write. Reads require
// `mailboxes.read` (SPEC §7) intersected with the caller tenant scope.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { MAILBOXES_READ_PERMISSION } from "./mailboxes.js";

export const MAILBOX_REPORTS_PATH = "/v1/tenants/:tenantId/mailbox-reports";
export const MAILBOX_REPORTS_UNAUTHENTICATED = "request.unauthenticated";

export const MAILBOX_REPORT_NAMES = [
  "statistics",
  "activity",
  "permissions",
  "calendarPermissions",
  "forwarding",
  "mailflow",
] as const;

export type MailboxReportName = (typeof MAILBOX_REPORT_NAMES)[number];

export interface MailboxReportFilter {
  readonly report: MailboxReportName;
  readonly mailboxId?: string;
  readonly search?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface MailboxReportPage {
  readonly tenantId: string;
  readonly report: MailboxReportName;
  readonly rows: readonly Record<string, unknown>[];
  readonly nextCursor: string | null;
  readonly retrievedAt: string;
}

// Queue-backed seam for the report reads: the production wiring enqueues a
// worker job per report — statistics/activity from the Get-MailboxSummary
// collector, permissions/calendarPermissions from
// Get-MailboxPermissionReport, forwarding from the mailbox forwarding
// projection, mailflow from Get-MailFlowReport — and serves the worker page.
// Depending on the seam keeps EXO and process code out of the BFF.
export interface MailboxReportsProvider {
  getMailboxReport(
    tenantId: string,
    filter: MailboxReportFilter,
  ): Promise<{ rows: readonly Record<string, unknown>[]; nextCursor: string | null; retrievedAt: string }>;
}

export interface MailboxReportsCaller extends Caller {
  readonly userId?: string;
}

export type MailboxReportsAuthorizer = (
  caller: MailboxReportsCaller,
  permission: string,
) => void | Promise<void>;

export interface MailboxReportsRouteOptions {
  readonly provider: MailboxReportsProvider;
  readonly resolveCaller: (ctx: RequestContext) => MailboxReportsCaller | undefined;
  readonly authorize?: MailboxReportsAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(MAILBOX_REPORTS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => MailboxReportsCaller | undefined,
  ctx: RequestContext,
): MailboxReportsCaller {
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

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

export function parseMailboxReportFilter(query: URLSearchParams): MailboxReportFilter {
  const pagination = parsePagination(query);
  const report = optionalText(query, "report");
  if (report === undefined || !(MAILBOX_REPORT_NAMES as readonly string[]).includes(report)) {
    throw validationError(
      `report must be one of: ${MAILBOX_REPORT_NAMES.join(", ")}`,
      "report",
    );
  }
  const mailboxId = optionalText(query, "mailboxId");
  const search = optionalText(query, "search");
  return {
    report: report as MailboxReportName,
    mailboxId,
    search,
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export async function getMailboxReport(
  provider: MailboxReportsProvider,
  tenantId: string,
  filter: MailboxReportFilter,
): Promise<{ status: number; body: MailboxReportPage }> {
  if (tenantId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  const page = await provider.getMailboxReport(tenantId, filter);
  return {
    status: 200,
    body: {
      tenantId,
      report: filter.report,
      rows: [...page.rows],
      nextCursor: page.nextCursor,
      retrievedAt: page.retrievedAt,
    },
  };
}

export function createMailboxReportsRoute(options: MailboxReportsRouteOptions): Route {
  return {
    method: "GET",
    path: MAILBOX_REPORTS_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);

      if (options.authorize) {
        await options.authorize(caller, MAILBOXES_READ_PERMISSION);
      } else {
        const permissions = caller.permissions ?? [];
        if (!permissions.includes(MAILBOXES_READ_PERMISSION) && !permissions.includes("*")) {
          throw new AppError(ErrorCodes.forbidden, "forbidden: missing mailboxes.read", 403);
        }
      }

      const filter = parseMailboxReportFilter(ctx.query);
      const result = await getMailboxReport(options.provider, tenantId, filter);

      return {
        status: result.status,
        headers: { "content-type": "application/json" },
        body: result.body,
      };
    },
  };
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const MAILBOX_REPORTS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/mailbox-reports": {
      get: {
        operationId: "getMailboxReport",
        summary: "Mailbox reports (statistics/activity/permissions/calendarPermissions/forwarding/mailflow) from the module collectors",
        permission: MAILBOXES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "report",
            in: "query",
            required: true,
            schema: {
              type: "string",
              enum: ["statistics", "activity", "permissions", "calendarPermissions", "forwarding", "mailflow"],
            },
          },
          { name: "mailboxId", in: "query", required: false, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated report rows from the module collectors." },
          "400": { description: "An unknown report name was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailboxes.read or the tenant is out of scope." },
        },
      },
    },
  },
} as const;
