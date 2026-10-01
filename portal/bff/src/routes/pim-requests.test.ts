import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import type { RoleRequestsRepository } from "../../../db/src/role-requests-repository.js";
import type {
  RoleChangeRequest,
  RoleChangeRequestInput,
  RoleChangeRequestState,
  RoleChangeRequestUpdate,
} from "../../../db/src/repository.js";
import {
  PIM_APPROVAL_AUTHORITY,
  PIM_DECISION_IN_ENTRA,
  PIM_JUSTIFICATION_REQUIRED,
  PIM_REQUESTS_PATH,
  ROLES_READ_PERMISSION,
  ROLES_WRITE_PERMISSION,
  createPimRequestsRoutes,
  type PimRequestAuditEvent,
  type PimRequestSubmitProvider,
} from "./pim-requests.js";

const TENANT = "tenant-a";

class InMemoryRoleRequestsRepository implements RoleRequestsRepository {
  readonly schemaVersion = 73;
  private readonly store = new Map<string, RoleChangeRequest>();

  close(): void {}

  async createRequest(input: RoleChangeRequestInput): Promise<RoleChangeRequest> {
    const now = new Date().toISOString();
    const item: RoleChangeRequest = {
      id: input.id,
      tenantId: input.tenantId,
      principalId: input.principalId,
      roleId: input.roleId,
      action: input.action,
      state: input.state,
      justification: input.justification,
      durationHours: input.durationHours ?? 8,
      ticketNumber: input.ticketNumber ?? null,
      approverId: input.approverId ?? null,
      rejectionReason: input.rejectionReason ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
    };
    this.store.set(`${input.tenantId}|${input.id}`, item);
    return item;
  }

  async getRequest(tenantId: string, id: string): Promise<RoleChangeRequest | undefined> {
    return this.store.get(`${tenantId}|${id}`);
  }

  async listRequests(
    tenantId: string,
    filter?: { principalId?: string; state?: RoleChangeRequestState },
  ): Promise<RoleChangeRequest[]> {
    return Array.from(this.store.values()).filter((item) => {
      if (item.tenantId !== tenantId) return false;
      if (filter?.principalId && item.principalId !== filter.principalId) return false;
      if (filter?.state && item.state !== filter.state) return false;
      return true;
    });
  }

  async updateRequest(
    tenantId: string,
    id: string,
    update: RoleChangeRequestUpdate,
  ): Promise<RoleChangeRequest | undefined> {
    const existing = await this.getRequest(tenantId, id);
    if (!existing) return undefined;
    const updated: RoleChangeRequest = {
      ...existing,
      state: update.state ?? existing.state,
      approverId: update.approverId !== undefined ? update.approverId : existing.approverId,
      rejectionReason:
        update.rejectionReason !== undefined ? update.rejectionReason : existing.rejectionReason,
      startsAt: update.startsAt !== undefined ? update.startsAt : existing.startsAt,
      endsAt: update.endsAt !== undefined ? update.endsAt : existing.endsAt,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(`${tenantId}|${id}`, updated);
    return updated;
  }
}

describe("Role change requests with native pending-approval state (T-0245)", () => {
  it("records Entra as the approval authority (T-0831)", () => {
    expect(PIM_APPROVAL_AUTHORITY).toBe("entra");
  });

  it("rejects a request without justification", async () => {
    const repo = new InMemoryRoleRequestsRepository();
    const routes = createPimRequestsRoutes({
      repository: repo,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [ROLES_WRITE_PERMISSION],
      }),
    });

    const submitRoute = routes.find((r) => r.method === "POST" && r.path === PIM_REQUESTS_PATH)!;

    await expect(
      submitRoute.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/pim/requests`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: {
          principalId: "user-1",
          roleId: "role-ga",
          action: "activate",
          justification: "", // empty
        },
      }),
    ).rejects.toMatchObject({
      code: PIM_JUSTIFICATION_REQUIRED,
      status: 400,
    });
  });

  it("submits valid request and activates directly when approval is not required", async () => {
    const repo = new InMemoryRoleRequestsRepository();
    const audits: PimRequestAuditEvent[] = [];
    const routes = createPimRequestsRoutes({
      repository: repo,
      recordAudit: async (ev) => {
        audits.push(ev);
      },
      resolveCaller: () => ({
        userId: "user-1",
        tenantScope: tenantScope([TENANT]),
        permissions: [ROLES_WRITE_PERMISSION],
      }),
    });

    const submitRoute = routes.find((r) => r.method === "POST" && r.path === PIM_REQUESTS_PATH)!;

    const resp = await submitRoute.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/pim/requests`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: {
        principalId: "user-1",
        roleId: "role-ga",
        action: "activate",
        justification: "On-call incident INC-9999",
        durationHours: 4,
        approvalRequired: false,
      },
    });

    expect(resp.status).toBe(201);
    const body = resp.body as RoleChangeRequest;
    expect(body.state).toBe("active");
    expect(body.startsAt).not.toBeNull();
    expect(body.endsAt).not.toBeNull();
    expect(body.justification).toBe("On-call incident INC-9999");

    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("pim.requestSubmit");
    expect(audits[0]?.result).toBe("success");
  });

  function approverRoutes(
    repo: InMemoryRoleRequestsRepository,
    audits: PimRequestAuditEvent[],
    submitProvider?: PimRequestSubmitProvider,
  ) {
    return createPimRequestsRoutes({
      repository: repo,
      ...(submitProvider ? { submitProvider } : {}),
      recordAudit: async (ev) => {
        audits.push(ev);
      },
      resolveCaller: () => ({
        userId: "approver-admin",
        tenantScope: tenantScope([TENANT]),
        permissions: [ROLES_READ_PERMISSION, ROLES_WRITE_PERMISSION],
      }),
    });
  }

  async function submitPending(
    routes: ReturnType<typeof createPimRequestsRoutes>,
  ): Promise<RoleChangeRequest> {
    const submitRoute = routes.find((r) => r.method === "POST" && r.path === PIM_REQUESTS_PATH)!;
    const resp = await submitRoute.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/pim/requests`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: {
        principalId: "user-2",
        roleId: "role-ga",
        action: "activate",
        justification: "Annual audit compliance check",
        approvalRequired: true,
      },
    });
    return resp.body as RoleChangeRequest;
  }

  function transition(
    routes: ReturnType<typeof createPimRequestsRoutes>,
    id: string,
    state: RoleChangeRequestState,
  ) {
    const transitionRoute = routes.find(
      (r) => r.method === "POST" && r.path === "/v1/tenants/:tenantId/pim/requests/:id/transition",
    )!;
    return transitionRoute.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/pim/requests/${id}/transition`,
      params: { tenantId: TENANT, id },
      query: new URLSearchParams(),
      headers: {},
      body: { state },
    });
  }

  it("mirrors the Entra decision instead of recording the portal caller's decision", async () => {
    const repo = new InMemoryRoleRequestsRepository();
    const audits: PimRequestAuditEvent[] = [];
    const provider: PimRequestSubmitProvider = {
      async submitRequest() {
        return { id: "graph-req-1", state: "pending" };
      },
      async getRequestStatus(_tenantId, requestId) {
        expect(requestId).toBe("graph-req-1");
        return {
          state: "active",
          startsAt: "2026-09-26T12:00:00.000Z",
          endsAt: "2026-09-26T20:00:00.000Z",
        };
      },
    };
    const routes = approverRoutes(repo, audits, provider);

    const created = await submitPending(routes);
    expect(created.state).toBe("pending");
    expect(created.startsAt).toBeNull();
    // The record is keyed by the Graph request id so the portal can read Entra back.
    expect(created.id).toBe("graph-req-1");

    const resp = await transition(routes, created.id, "approved");

    expect(resp.status).toBe(200);
    const mirrored = resp.body as RoleChangeRequest;
    expect(mirrored.state).toBe("active");
    expect(mirrored.startsAt).toBe("2026-09-26T12:00:00.000Z");
    expect(mirrored.endsAt).toBe("2026-09-26T20:00:00.000Z");
    expect(audits.some((a) => a.action === "pim.requestTransition.active")).toBe(true);
  });

  it("refuses to record a decision while Entra still reports pending", async () => {
    const repo = new InMemoryRoleRequestsRepository();
    const provider: PimRequestSubmitProvider = {
      async submitRequest() {
        return { id: "graph-req-2", state: "pending" };
      },
      async getRequestStatus() {
        return { state: "pending" };
      },
    };
    const routes = approverRoutes(repo, [], provider);
    const created = await submitPending(routes);

    await expect(transition(routes, created.id, "approved")).rejects.toMatchObject({
      code: PIM_DECISION_IN_ENTRA,
      status: 409,
    });
    expect((await repo.getRequest(TENANT, created.id))?.state).toBe("pending");
  });

  it("refuses to record a decision when no Entra mirroring provider is configured", async () => {
    const repo = new InMemoryRoleRequestsRepository();
    const routes = approverRoutes(repo, []);
    const created = await submitPending(routes);

    await expect(transition(routes, created.id, "rejected")).rejects.toMatchObject({
      code: PIM_DECISION_IN_ENTRA,
      status: 409,
    });
    expect((await repo.getRequest(TENANT, created.id))?.state).toBe("pending");
  });
});
