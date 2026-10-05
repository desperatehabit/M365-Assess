// T-0860 — Purview worker-backed providers.
// Adapter tests: each provider calls its worker entrypoint with the tenant's
// credential block, forwards the list filters, maps single-item reads through
// the list, and maps Safe Links change results (plan for preview, result with
// audit event for apply). A failed worker surfaces as a 502.

import { describe, expect, it } from "vitest";
import type { CredentialStoreRow } from "../routes/credentials.js";
import { FeatureWorkerError } from "../jobs/feature-worker.js";
import { createPurviewProviders } from "./purview.js";

const TENANT = "tenant-a";

const credentials: CredentialStoreRow = {
  getCredential: async () => ({
    tenantId: TENANT,
    authMethod: "certificate-thumbprint",
    clientId: "client-1",
    secretRef: "",
    thumbprint: "thumb-1",
    environment: "commercial",
  }),
  upsertCredential: async () => {
    throw new Error("not implemented");
  },
  appendAuditEvent: async () => undefined,
};

interface Call {
  readonly entrypoint: string;
  readonly job: Record<string, unknown>;
}

function recordingRunner(handler: (job: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const run = async <T>(entrypoint: string, job: Record<string, unknown>): Promise<T> => {
    calls.push({ entrypoint, job });
    return handler(job) as T;
  };
  return { run, calls };
}

const DLP_PAGE = {
  tenantId: TENANT,
  items: [
    { id: "policy-1", name: "Finance DLP", state: "enabled", locations: ["Exchange"], rules: 2, lastModified: "2026-05-01T10:00:00Z" },
    { id: "policy-2", name: "Legal Hold DLP", state: "disabled", locations: ["Teams"], rules: 1, lastModified: "2026-06-02T11:00:00Z" },
  ],
  nextCursor: null,
  totalCount: 2,
  retrievedAt: "2026-09-29T00:00:00.000Z",
};

const LABEL_PAGE = {
  tenantId: TENANT,
  kind: "labels",
  items: [
    { id: "label-1", name: "Confidential", scope: ["File"], priority: 1, encryption: null, marking: [], state: "enabled", published: false, publishingPolicies: [] },
  ],
  nextCursor: null,
  totalCount: 1,
  retrievedAt: "2026-09-29T00:00:00.000Z",
};

const SIT_PAGE = {
  tenantId: TENANT,
  kind: "sits",
  items: [
    { id: "sit-1", name: "Credit Card Number", type: "builtin", patternConfidence: "High", basedOn: null },
  ],
  nextCursor: null,
  totalCount: 1,
  retrievedAt: "2026-09-29T00:00:00.000Z",
};

const RETENTION_PAGE = {
  tenantId: TENANT,
  items: [
    { id: "policy-1", name: "Retain 7 years", state: "enabled", locations: ["Exchange"], retentionPeriod: "P7Y", disposition: "keep", retrievedAt: "2026-09-29T00:00:00.000Z" },
  ],
  nextCursor: null,
  totalCount: 1,
  retrievedAt: "2026-09-29T00:00:00.000Z",
};

const SAFELINKS_PAGE = {
  tenantId: TENANT,
  items: [
    { id: "policy-1", name: "Executive protection", state: "enabled", urlRewriting: true, scanOnClick: true, detonation: true, lastModified: "2026-09-20T12:00:00Z" },
  ],
  nextCursor: null,
  totalCount: 1,
  retrievedAt: "2026-09-29T00:00:00.000Z",
};

function listRunner() {
  return recordingRunner((job) => {
    switch (job["entrypoint"] ?? "") {
      default:
        break;
    }
    if (job["kind"] === "labels") return LABEL_PAGE;
    if (job["kind"] === "sits") return SIT_PAGE;
    if (job["action"] === "list") return SAFELINKS_PAGE;
    if (job["area"] === "retention" || job["state"] !== undefined || job["search"] !== undefined) {
      // get-purview-retention.ps1 and get-purview-dlp.ps1 share the field shape.
    }
    return DLP_PAGE;
  });
}

describe("createPurviewProviders (T-0860)", () => {
  it("calls get-purview-dlp.ps1 with the credential block and list filters", async () => {
    const { run, calls } = recordingRunner(() => DLP_PAGE);
    const providers = createPurviewProviders(run, credentials);

    const page = await providers.dlp.listPolicies(TENANT, { search: "finance", state: "enabled", limit: 25, cursor: "opaque" });
    expect(page.items).toHaveLength(2);
    expect(page.totalCount).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.entrypoint).toBe("get-purview-dlp.ps1");
    expect(calls[0]!.job).toMatchObject({
      tenantId: TENANT,
      search: "finance",
      state: "enabled",
      top: 25,
      cursor: "opaque",
      credential: { credentialRef: `tenants/${TENANT}/credential` },
    });
  });

  it("finds one DLP policy through the list", async () => {
    const { run } = recordingRunner(() => DLP_PAGE);
    const providers = createPurviewProviders(run, credentials);
    const policy = await providers.dlpWrite.getPolicy(TENANT, "policy-2");
    expect(policy).toMatchObject({ id: "policy-2", name: "Legal Hold DLP", state: "disabled" });
    expect(await providers.dlpWrite.getPolicy(TENANT, "missing")).toBeUndefined();
  });

  it("calls get-purview-labels.ps1 for labels and SITs with the kind filter", async () => {
    const { run, calls } = listRunner();
    const providers = createPurviewProviders(run, credentials);

    const labels = await providers.labels.listLabels(TENANT, { search: "conf", state: "enabled" });
    expect(labels.items[0]).toMatchObject({ id: "label-1", name: "Confidential" });
    expect(calls.at(-1)!.job).toMatchObject({ kind: "labels", search: "conf", state: "enabled" });

    const sits = await providers.labels.listSits(TENANT, { type: "builtin" });
    expect(sits.items[0]).toMatchObject({ id: "sit-1", type: "builtin" });
    expect(calls.at(-1)!.job).toMatchObject({ kind: "sits", type: "builtin" });

    const label = await providers.labels.getLabel(TENANT, "label-1");
    expect(label).toMatchObject({ id: "label-1", priority: 1 });
    const sit = await providers.labels.getSit(TENANT, "sit-1");
    expect(sit).toMatchObject({ id: "sit-1", patternConfidence: "High" });
  });

  it("calls get-purview-retention.ps1 with the list filters", async () => {
    const { run, calls } = recordingRunner(() => RETENTION_PAGE);
    const providers = createPurviewProviders(run, credentials);

    const page = await providers.retention.listPolicies(TENANT, { state: "enabled" });
    expect(page.items[0]).toMatchObject({ id: "policy-1", retentionPeriod: "P7Y", disposition: "keep" });
    expect(calls[0]!.entrypoint).toBe("get-purview-retention.ps1");
    expect(calls[0]!.job).toMatchObject({ tenantId: TENANT, state: "enabled", credential: { credentialRef: `tenants/${TENANT}/credential` } });

    const policy = await providers.retention.getPolicy(TENANT, "policy-1");
    expect(policy).toMatchObject({ id: "policy-1", name: "Retain 7 years" });
  });

  it("lists Safe Links policies through get-safelinks.ps1", async () => {
    const { run, calls } = recordingRunner(() => SAFELINKS_PAGE);
    const providers = createPurviewProviders(run, credentials);

    const page = await providers.safelinks.listPolicies(TENANT, { search: "exec", state: "enabled", cursor: null, limit: 50 });
    expect(page.items[0]).toMatchObject({ id: "policy-1", detonation: true });
    expect(calls[0]!.entrypoint).toBe("get-safelinks.ps1");
    expect(calls[0]!.job).toMatchObject({ tenantId: TENANT, search: "exec", top: 50 });
  });

  it("previews a Safe Links create as a plan with no tenant write", async () => {
    const plan = {
      action: "create",
      policyId: "Executive protection",
      targetName: "Executive protection",
      before: null,
      after: { name: "Executive protection", state: "enabled" },
      diff: ["Create 'Executive protection'"],
      valid: true,
      dryRun: true,
      requiresConfirmation: false,
    };
    const { run, calls } = recordingRunner(() => plan);
    const providers = createPurviewProviders(run, credentials);

    const result = await providers.safelinks.createPolicy(TENANT, { name: "Executive protection", settings: { isEnabled: true } }, true);
    expect(result).toMatchObject({ dryRun: true, valid: true });
    expect(calls[0]!.job).toMatchObject({ action: "create", name: "Executive protection", dryRun: true, confirmed: false });
  });

  it("applies a Safe Links edit and maps the worker result with its audit event", async () => {
    const applyResult = {
      plan: {
        action: "disable",
        policyId: "policy-1",
        targetName: "Executive protection",
        before: { state: "enabled" },
        after: { state: "disabled" },
        diff: ["Disable 'Executive protection'"],
        valid: true,
        dryRun: false,
        requiresConfirmation: true,
      },
      result: { policyId: "policy-1", name: "Executive protection" },
      auditEvent: {
        id: "audit-1",
        tenantId: TENANT,
        action: "safelinks.policy.disable",
        targetId: "policy-1",
        targetName: "Executive protection",
        timestamp: "2026-09-29T00:00:00.000Z",
      },
      success: true,
    };
    const { run, calls } = recordingRunner(() => applyResult);
    const providers = createPurviewProviders(run, credentials);

    const result = await providers.safelinks.editPolicy(TENANT, "policy-1", { action: "disable" }, false);
    expect(result).toMatchObject({ success: true, plan: { dryRun: false } });
    expect("auditEvent" in result && result.auditEvent).toMatchObject({ action: "safelinks.policy.disable" });
    expect(calls[0]!.job).toMatchObject({ action: "disable", policyId: "policy-1", dryRun: false, confirmed: true });
  });

  it("deletes a Safe Links policy with the confirm name", async () => {
    const { run, calls } = recordingRunner(() => ({
      plan: { action: "delete", policyId: "policy-1", targetName: "Executive protection", before: null, after: null, diff: [], valid: true, dryRun: false, requiresConfirmation: true },
      result: { policyId: "policy-1" },
      auditEvent: { id: "audit-2", tenantId: TENANT, action: "safelinks.policy.delete", targetId: "policy-1" },
      success: true,
    }));
    const providers = createPurviewProviders(run, credentials);

    const result = await providers.safelinks.deletePolicy(TENANT, "policy-1", "Executive protection", false);
    expect(result).toMatchObject({ success: true });
    expect(calls[0]!.job).toMatchObject({ action: "delete", policyId: "policy-1", confirmName: "Executive protection", confirmed: true });
  });

  it("maps a failed worker to a 502", async () => {
    const { run } = recordingRunner(() => {
      throw new FeatureWorkerError("worker.failed", "worker exploded", 1, "boom");
    });
    const providers = createPurviewProviders(run, credentials);
    await expect(providers.dlp.listPolicies(TENANT)).rejects.toMatchObject({ status: 502 });
  });
});
