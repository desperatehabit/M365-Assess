// PIM schedule & role change requests (EPIC-013 SPEC §3.3, §4.3, §5, §11.1; T-0245).
// Exposes POST /v1/tenants/:tenantId/pim/requests with mandatory justification.
// When approval is configured, the request enters native 'pending' state; otherwise activates directly.
// Transitions are audited and persisted in role-requests-repository.
//
// T-0831 decision: approval authority is Entra. When a role policy requires approval, the
// roleAssignmentScheduleRequest goes to PendingApproval and Entra's approvers decide. The
// portal never records a decision Entra did not make: a decision transition reads the live
// request and mirrors its state, and a portal record is keyed by the Graph request id so the
// two can be correlated. A portal record with no provider to read Entra refuses the decision.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type {
  RoleChangeRequest,
  RoleChangeRequestAction,
  RoleChangeRequestInput,
  RoleChangeRequestState,
  RoleRequestsRepository,
} from "@m365-assess/db";

export const PIM_REQUESTS_PATH = "/v1/tenants/:tenantId/pim/requests";
export const PIM_REQUEST_ITEM_PATH = "/v1/tenants/:tenantId/pim/requests/:id";
export const PIM_REQUEST_TRANSITION_PATH = "/v1/tenants/:tenantId/pim/requests/:id/transition";

export const ROLES_READ_PERMISSION = "Identity.Role.Read";
export const ROLES_WRITE_PERMISSION = "Identity.Role.ReadWrite";
export const ROLES_PIM_PERMISSION = "Identity.Pim.ReadWrite";
export const PIM_REQUESTS_UNAUTHENTICATED = "request.unauthenticated";
export const PIM_JUSTIFICATION_REQUIRED = "roles.justification_required";
export const PIM_DECISION_IN_ENTRA = "roles.decision_in_entra";

/** Approval authority for PIM requests (T-0831): Entra decides, the portal mirrors. */
export const PIM_APPROVAL_AUTHORITY = "entra";

export interface PimRequestAuditEvent {
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly result: "success" | "failure";
  readonly before: unknown;
  readonly after: unknown;
  readonly callerId?: string;
  readonly reason?: string;
  readonly timestamp?: string;
}

export interface PimRequestStatus {
  readonly state: RoleChangeRequestState;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
}

export interface PimRequestSubmitProvider {
  submitRequest(
    tenantId: string,
    input: {
      principalId: string;
      roleId: string;
      action: RoleChangeRequestAction;
      justification: string;
      durationHours: number;
      approvalRequired: boolean;
      ticketNumber?: string;
      /** Exact new end for an extend; the worker counts from here, not from now. */
      newEndsAt?: string;
    },
  ): Promise<{
    id?: string;
    state: RoleChangeRequestState;
    startsAt?: string;
    endsAt?: string;
  }>;

  /** Reads the live Entra request so the portal can mirror its decision (T-0831). */
  getRequestStatus?(tenantId: string, requestId: string): Promise<PimRequestStatus>;
}

export interface PimRequestsRouteOptions {
  readonly repository: RoleRequestsRepository;
  readonly submitProvider?: PimRequestSubmitProvider;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly recordAudit?: (event: PimRequestAuditEvent) => Promise<void>;
  readonly idGenerator?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(PIM_REQUESTS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => Caller | undefined,
  ctx: RequestContext,
): Caller {
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

export function createPimRequestsRoutes(options: PimRequestsRouteOptions): Route[] {
  const repo = options.repository;
  const generateId = options.idGenerator ?? (() => `pim-req-${Date.now()}`);

  const checkPerm = async (caller: Caller, perm: string) => {
    if (options.authorize) {
      await options.authorize(caller, perm);
    } else {
      const perms = caller.permissions ?? [];
      if (!perms.includes(perm) && !perms.includes(ROLES_PIM_PERMISSION) && !perms.includes("*")) {
        throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${perm}`, 403);
      }
    }
  };

  // 1. Submit a schedule / role change request
  const submitRoute: Route = {
    method: "POST",
    path: PIM_REQUESTS_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);
      requireTenantInScope(caller, tenantId);
      await checkPerm(caller, ROLES_WRITE_PERMISSION);

      const body = (ctx.body ?? {}) as {
        principalId?: string;
        roleId?: string;
        action?: RoleChangeRequestAction;
        justification?: string;
        durationHours?: number;
        approvalRequired?: boolean;
        ticketNumber?: string;
        newEndsAt?: string;
      };

      if (!body.principalId || typeof body.principalId !== "string" || body.principalId.trim().length === 0) {
        throw validationError("principalId is required", "principalId");
      }
      if (!body.roleId || typeof body.roleId !== "string" || body.roleId.trim().length === 0) {
        throw validationError("roleId is required", "roleId");
      }
      if (!body.justification || typeof body.justification !== "string" || body.justification.trim().length === 0) {
        throw new AppError(
          PIM_JUSTIFICATION_REQUIRED,
          "justification is mandatory for PIM schedule requests",
          400,
          [{ field: "justification", reason: "required" }],
        );
      }

      const action = body.action ?? "activate";
      const durationHours = body.durationHours ?? 8;
      const approvalRequired = body.approvalRequired === true;
      const justification = body.justification.trim();
      const newEndsAt =
        typeof body.newEndsAt === "string" && body.newEndsAt.trim().length > 0
          ? body.newEndsAt.trim()
          : undefined;

      let state: RoleChangeRequestState = approvalRequired ? "pending" : "active";
      let startsAt: string | null = null;
      let endsAt: string | null = null;
      let id = generateId();

      if (options.submitProvider) {
        const outcome = await options.submitProvider.submitRequest(tenantId, {
          principalId: body.principalId.trim(),
          roleId: body.roleId.trim(),
          action,
          justification,
          durationHours,
          approvalRequired,
          ticketNumber: body.ticketNumber,
          ...(newEndsAt ? { newEndsAt } : {}),
        });
        // Key the portal record by the Graph request id so the portal can read the
        // live request back and mirror Entra's decision (T-0831).
        if (outcome.id) id = outcome.id;
        state = outcome.state;
        startsAt = outcome.startsAt ?? null;
        endsAt = outcome.endsAt ?? null;
      } else if (state === "active") {
        const now = new Date();
        startsAt = now.toISOString();
        endsAt = new Date(now.getTime() + durationHours * 3600 * 1000).toISOString();
      }

      const request = await repo.createRequest({
        id,
        tenantId,
        principalId: body.principalId.trim(),
        roleId: body.roleId.trim(),
        action,
        state,
        justification,
        durationHours,
        ticketNumber: body.ticketNumber ?? null,
        startsAt,
        endsAt,
      });

      if (options.recordAudit) {
        await options.recordAudit({
          tenantId,
          action: "pim.requestSubmit",
          targetId: body.roleId.trim(),
          result: "success",
          before: null,
          after: request,
          callerId: (caller as { userId?: string }).userId,
          reason: justification,
          timestamp: new Date().toISOString(),
        });
      }

      return {
        status: 201,
        headers: { "content-type": "application/json" },
        body: request,
      };
    },
  };

  // 2. List requests
  const listRoute: Route = {
    method: "GET",
    path: PIM_REQUESTS_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);
      requireTenantInScope(caller, tenantId);
      await checkPerm(caller, ROLES_READ_PERMISSION);

      const principalId = ctx.query.get("principalId") ?? undefined;
      const state = (ctx.query.get("state") as RoleChangeRequestState) ?? undefined;

      const items = await repo.listRequests(tenantId, { principalId, state });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { tenantId, items },
      };
    },
  };

  // 3. Get single request
  const getRoute: Route = {
    method: "GET",
    path: PIM_REQUEST_ITEM_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);
      requireTenantInScope(caller, tenantId);
      await checkPerm(caller, ROLES_READ_PERMISSION);

      const id = ctx.params["id"];
      if (!id) throw validationError("id is required", "id");

      const item = await repo.getRequest(tenantId, id);
      if (!item) {
        throw new AppError(ErrorCodes.notFound, `request '${id}' not found`, 404);
      }

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: item,
      };
    },
  };

  // 4. Transition request state (approve, reject, cancel)
  const transitionRoute: Route = {
    method: "POST",
    path: PIM_REQUEST_TRANSITION_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);
      requireTenantInScope(caller, tenantId);
      await checkPerm(caller, ROLES_WRITE_PERMISSION);

      const id = ctx.params["id"];
      if (!id) throw validationError("id is required", "id");

      const existing = await repo.getRequest(tenantId, id);
      if (!existing) {
        throw new AppError(ErrorCodes.notFound, `request '${id}' not found`, 404);
      }

      const body = (ctx.body ?? {}) as {
        state?: RoleChangeRequestState;
        rejectionReason?: string;
      };

      if (!body.state) {
        throw validationError("state is required for transition", "state");
      }

      const decisionStates: RoleChangeRequestState[] = ["approved", "active", "rejected"];
      const isDecision = decisionStates.includes(body.state);
      const callerId = (caller as { userId?: string }).userId ?? null;

      let state: RoleChangeRequestState = body.state;
      let startsAt: string | null | undefined = existing.startsAt;
      let endsAt: string | null | undefined = existing.endsAt;

      if (isDecision) {
        // Approval authority is Entra (T-0831): the portal never records a decision
        // Entra did not make. Read the live request and mirror its state instead of
        // trusting the caller's requested state.
        const readStatus = options.submitProvider?.getRequestStatus;
        if (!readStatus) {
          throw new AppError(
            PIM_DECISION_IN_ENTRA,
            "PIM approval decisions are made in Entra; the portal cannot record one",
            409,
          );
        }
        const live = await readStatus(tenantId, id);
        if (live.state === "pending") {
          throw new AppError(
            PIM_DECISION_IN_ENTRA,
            "request is still awaiting approval in Entra",
            409,
          );
        }
        state = live.state;
        startsAt = live.startsAt ?? startsAt;
        endsAt = live.endsAt ?? endsAt;
      }

      const now = new Date();
      if ((state === "approved" || state === "active") && !startsAt) {
        startsAt = now.toISOString();
        endsAt = new Date(now.getTime() + existing.durationHours * 3600 * 1000).toISOString();
      }

      const updated = await repo.updateRequest(tenantId, id, {
        state,
        approverId: isDecision ? (existing.approverId ?? null) : callerId,
        rejectionReason: body.rejectionReason ?? null,
        startsAt,
        endsAt,
      });

      if (options.recordAudit) {
        await options.recordAudit({
          tenantId,
          action: `pim.requestTransition.${state}`,
          targetId: existing.roleId,
          result: "success",
          before: existing,
          after: updated,
          callerId: callerId ?? undefined,
          reason: body.rejectionReason ?? undefined,
          timestamp: new Date().toISOString(),
        });
      }

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: updated,
      };
    },
  };

  return [submitRoute, listRoute, getRoute, transitionRoute];
}
