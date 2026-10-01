// The run queue must accept client-secret and certificate-pfx credentials (T-0827):
// it writes only a reference-only `Credential` block into context.json and lets the
// child resolve the material. `@m365-assess/db` is mocked because these cases never
// touch the database beyond a stubbed update.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobEnvelope } from "@m365-assess/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@m365-assess/db", () => ({ findingsFromAssessmentExport: vi.fn() }));

import { buildRunEnvelope } from "../../src/domain/runs/run-lifecycle.js";
import type { CredentialRecord, CredentialStoreRow } from "../../src/routes/credentials.js";
import type { TenantStore } from "../../src/routes/tenants.js";
import type { SqliteRepository } from "@m365-assess/db";
import { createRunQueue } from "../../src/adapters/runs.js";

const SECRET_MATERIAL = "super-secret-client-value-never-on-disk";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function credential(overrides: Partial<CredentialRecord>): CredentialRecord {
  return {
    id: "cred-1",
    tenantId: "t-a",
    authMethod: "certificate-thumbprint",
    clientId: "app-1",
    secretRef: "",
    thumbprint: "ABC",
    environment: "commercial",
    expiresOn: null,
    lastValidated: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function setup(record: CredentialRecord) {
  const root = mkdtempSync(path.join(tmpdir(), "m365-run-queue-"));
  dirs.push(root);
  const enqueued: JobEnvelope[] = [];
  const credentials = {
    getCredential: async () => record,
    upsertCredential: async () => record,
    appendAuditEvent: async () => ({}),
  } as unknown as CredentialStoreRow;
  const tenants = {
    getTenant: async () => ({ displayName: "Tenant t-a", defaultDomain: null, initialDomain: null }),
  } as unknown as TenantStore;
  const repo = {
    updateRun: async () => undefined,
    getRunById: async () => undefined,
    listRunsByParentId: async () => [],
  } as unknown as SqliteRepository;
  const queue = {
    enqueue: async (envelope: JobEnvelope) => (enqueued.push(envelope), envelope.jobId),
    cancel: async () => true,
  };
  const runQueue = createRunQueue({ queue, storageRoot: root, tenants, credentials, repo });
  return { root, enqueued, runQueue };
}

function envelope(sections: string[]): JobEnvelope {
  return buildRunEnvelope({
    tenantId: "t-a",
    runId: "r-1",
    jobId: "job-r-1",
    requestId: "req-r-1",
    correlationId: "corr",
    sections,
    createdAt: "2026-09-26T00:00:00.000Z",
  });
}

function contextOf(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, "runs/t-a/r-1/context.json"), "utf8"));
}

describe("run queue credential handling (T-0827)", () => {
  it("enqueues a Graph-only client-secret run with a reference-only credential block", async () => {
    const { root, enqueued, runQueue } = setup(
      credential({ authMethod: "client-secret", thumbprint: null, secretRef: "ref://tenants/t-a/credential/secret" }),
    );
    await runQueue.enqueue(envelope(["Identity", "Tenant"]));

    expect(enqueued).toHaveLength(1);
    const raw = readFileSync(path.join(root, "runs/t-a/r-1/context.json"), "utf8");
    expect(raw).not.toContain(SECRET_MATERIAL);
    const context = contextOf(root);
    expect(context.Auth).toEqual({ Method: "ClientSecret", ClientId: "app-1", M365Environment: "commercial" });
    expect(context.Credential).toEqual({
      credentialRef: "tenants/t-a/credential",
      record: expect.objectContaining({ authMethod: "client-secret", secretRef: "ref://tenants/t-a/credential/secret" }),
    });
  });

  it("enqueues a certificate-pfx run with a reference-only credential block", async () => {
    const { root, enqueued, runQueue } = setup(
      credential({ authMethod: "certificate-pfx", thumbprint: null, secretRef: "ref://tenants/t-a/credential/pfx" }),
    );
    await runQueue.enqueue(envelope(["Identity"]));

    expect(enqueued).toHaveLength(1);
    const context = contextOf(root);
    expect(context.Auth).toEqual({ Method: "Certificate", ClientId: "app-1", M365Environment: "commercial" });
    expect(context.Credential).toEqual(
      expect.objectContaining({ record: expect.objectContaining({ authMethod: "certificate-pfx" }) }),
    );
  });

  it("still refuses a client secret for Exchange Online sections up front", async () => {
    const { enqueued, runQueue } = setup(
      credential({ authMethod: "client-secret", thumbprint: null, secretRef: "ref://tenants/t-a/credential/secret" }),
    );
    await runQueue.enqueue(envelope(["Identity", "Email"]));
    expect(enqueued).toEqual([]);
  });

  it("keeps the thumbprint context free of any credential block", async () => {
    const { root, runQueue } = setup(credential({}));
    await runQueue.enqueue(envelope(["Identity"]));
    const context = contextOf(root);
    expect(context.Auth).toEqual({
      Method: "Certificate",
      ClientId: "app-1",
      CertificateThumbprint: "ABC",
      M365Environment: "commercial",
    });
    expect(context).not.toHaveProperty("Credential");
  });
});
