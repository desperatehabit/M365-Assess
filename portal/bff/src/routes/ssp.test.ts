import type { SspDocumentView, SspPracticeResponse, SspSystemProfile } from "@m365-assess/contracts/ssp";
import { describe, expect, it } from "vitest";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Caller } from "../rbac/authorize.js";
import type { Route, RouteHandler, RouteResponse } from "../server.js";
import {
  SSP_DOCUMENT_PATH,
  SSP_PATH,
  SSP_PERMISSIONS,
  SSP_PRACTICE_NOT_FOUND,
  SSP_PRACTICE_PATH,
  SSP_PROFILE_PATH,
  createSspRoutes,
  type SspStore,
} from "./ssp.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const NOW = "2026-11-04T12:00:00.000Z";

class MemoryStore implements SspStore {
  profiles = new Map<string, SspSystemProfile>();
  responses = new Map<string, SspPracticeResponse>();
  async getProfile(tenantId: string) {
    return this.profiles.get(tenantId);
  }
  async upsertProfile(profile: SspSystemProfile) {
    this.profiles.set(profile.tenantId, profile);
    return profile;
  }
  async listPracticeResponses(tenantId: string) {
    return [...this.responses.values()].filter((entry) => entry.tenantId === tenantId);
  }
  async upsertPracticeResponse(response: SspPracticeResponse) {
    this.responses.set(`${response.tenantId}:${response.practiceId}`, response);
    return response;
  }
  async deletePracticeResponse(tenantId: string, practiceId: string) {
    return this.responses.delete(`${tenantId}:${practiceId}`);
  }
}

function harness(caller: Caller = { roles: ["admin"], tenantScope: ALL_TENANTS, userId: "consultant-1" }) {
  const store = new MemoryStore();
  const seenPermissions: string[] = [];
  const routes = createSspRoutes({
    store,
    findings: {
      latestRunId: async (tenantId) => (tenantId === TENANT_A ? "run-1" : null),
      listFindings: async () => [{ checkId: "AC-001.1", status: "Pass", controlName: "Access", currentValue: "ok" }],
    },
    practiceChecks: () => new Map([["3.1.1", ["AC-001"]]]),
    resolveCaller: () => caller,
    authorize: (_caller, permission) => {
      seenPermissions.push(permission);
    },
    now: () => NOW,
  });
  return { routes, store, seenPermissions };
}

function invoke(
  routes: readonly Route[],
  method: string,
  path: string,
  overrides: { params?: Record<string, string>; body?: unknown; query?: URLSearchParams } = {},
): Promise<RouteResponse> {
  const route = routes.find((entry) => entry.method === method && entry.path === path);
  if (!route) throw new Error(`no route ${method} ${path}`);
  const handler = route.handler as RouteHandler;
  return Promise.resolve(
    handler({
      correlationId: "corr-test",
      method,
      path,
      query: overrides.query ?? new URLSearchParams(),
      headers: {},
      params: overrides.params ?? {},
      body: overrides.body,
    } as unknown as Parameters<RouteHandler>[0]),
  );
}

const answer = {
  implementationStatus: "partially-implemented",
  responsibility: "shared",
  narrative: "Badge readers on the main entrance; side door pending.",
  evidence: ["Facility access policy v3"],
  owner: "Facilities",
  plannedCompletion: "2027-01-31",
};

describe("SSP routes", () => {
  it("returns the merged view with automated evidence under the read permission", async () => {
    const value = harness();
    const response = await invoke(value.routes, "GET", SSP_PATH, { params: { tenantId: TENANT_A } });
    const body = response.body as SspDocumentView;
    expect(response.status).toBe(200);
    expect(body.practices).toHaveLength(110);
    expect(body.practices.find((entry) => entry.practice.id === "3.1.1")).toMatchObject({
      effectiveStatus: "implemented",
      statusSource: "automated",
    });
    expect(value.seenPermissions).toEqual([SSP_PERMISSIONS.read]);
  });

  it("saves a practice answer and the profile under the write permission", async () => {
    const value = harness();
    const saved = await invoke(value.routes, "PUT", SSP_PRACTICE_PATH, {
      params: { tenantId: TENANT_A, practiceId: "3.10.1" },
      body: answer,
    });
    expect(saved.status).toBe(200);
    expect(value.store.responses.get(`${TENANT_A}:3.10.1`)).toMatchObject({ ...answer, updatedBy: "consultant-1", updatedAt: NOW });

    await invoke(value.routes, "PUT", SSP_PROFILE_PATH, {
      params: { tenantId: TENANT_A },
      body: { systemName: "CUI enclave", boundary: "Tenant and laptops" },
    });
    expect(value.store.profiles.get(TENANT_A)).toMatchObject({ systemName: "CUI enclave", boundary: "Tenant and laptops", description: "" });
    expect(value.seenPermissions).toEqual([SSP_PERMISSIONS.write, SSP_PERMISSIONS.write]);

    const view = (await invoke(value.routes, "GET", SSP_PATH, { params: { tenantId: TENANT_A } })).body as SspDocumentView;
    expect(view.practices.find((entry) => entry.practice.id === "3.10.1")).toMatchObject({
      effectiveStatus: "partially-implemented",
      statusSource: "response",
    });
  });

  it("rejects unknown practices and invalid answers", async () => {
    const value = harness();
    await expect(
      invoke(value.routes, "PUT", SSP_PRACTICE_PATH, { params: { tenantId: TENANT_A, practiceId: "3.99.1" }, body: answer }),
    ).rejects.toMatchObject({ status: 404, code: SSP_PRACTICE_NOT_FOUND });
    for (const bad of [
      { ...answer, implementationStatus: "done" },
      { ...answer, responsibility: "vendor" },
      { ...answer, plannedCompletion: "next month" },
      { ...answer, evidence: "a string" },
    ]) {
      await expect(
        invoke(value.routes, "PUT", SSP_PRACTICE_PATH, { params: { tenantId: TENANT_A, practiceId: "3.10.1" }, body: bad }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(value.store.responses.size).toBe(0);
  });

  it("clears an answer", async () => {
    const value = harness();
    const params = { tenantId: TENANT_A, practiceId: "3.10.1" };
    await invoke(value.routes, "PUT", SSP_PRACTICE_PATH, { params, body: answer });
    expect((await invoke(value.routes, "DELETE", SSP_PRACTICE_PATH, { params })).status).toBe(204);
    expect((await invoke(value.routes, "DELETE", SSP_PRACTICE_PATH, { params })).status).toBe(404);
  });

  it("refuses a tenant outside the caller's scope", async () => {
    const value = harness({ roles: ["operator"], tenantScope: tenantScope([TENANT_A]), userId: "consultant-2" });
    await expect(invoke(value.routes, "GET", SSP_PATH, { params: { tenantId: TENANT_B } })).rejects.toMatchObject({ status: 403 });
    await expect(
      invoke(value.routes, "PUT", SSP_PRACTICE_PATH, { params: { tenantId: TENANT_B, practiceId: "3.10.1" }, body: answer }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("generates the SSP as Word by default and HTML on request", async () => {
    const value = harness();
    const docx = await invoke(value.routes, "GET", SSP_DOCUMENT_PATH, { params: { tenantId: TENANT_A } });
    expect(docx.contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect((docx.raw as Buffer).subarray(0, 2).toString("latin1")).toBe("PK");
    expect(docx.headers?.["Content-Disposition"]).toContain(".docx");

    const html = await invoke(value.routes, "GET", SSP_DOCUMENT_PATH, {
      params: { tenantId: TENANT_A },
      query: new URLSearchParams({ format: "html" }),
    });
    expect(html.contentType).toBe("text/html; charset=utf-8");
    expect(String(html.raw)).toContain("System Security Plan");

    await expect(
      invoke(value.routes, "GET", SSP_DOCUMENT_PATH, { params: { tenantId: TENANT_A }, query: new URLSearchParams({ format: "pdf" }) }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
