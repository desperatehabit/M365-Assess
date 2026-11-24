import { describe, expect, it } from "vitest";
import type { JobEnvelope } from "@m365-assess/contracts";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import { createSpamQuarantineAdapters } from "./spam-quarantine.js";
import type { WorkerRunner } from "./workers.js";
import { FeatureWorkerError } from "../jobs/feature-worker.js";

const CREDENTIAL: CredentialRecord = {
  id: "c-1",
  tenantId: "t-a",
  authMethod: "certificate-thumbprint",
  clientId: "app-1",
  secretRef: "thumbprint://ABC",
  thumbprint: "ABC",
  environment: "commercial",
  expiresOn: null,
  lastValidated: null,
  createdAt: "",
  updatedAt: "",
};

const credentials: CredentialStoreRow = {
  getCredential: async (tenantId) => (tenantId === "t-a" ? CREDENTIAL : undefined),
  listCredentials: async () => [],
  deleteCredential: async () => false,
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

interface Call {
  readonly entrypoint: string;
  readonly job: Record<string, unknown>;
}

function harness(handler: (entrypoint: string, job: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const run: WorkerRunner = async <T>(entrypoint: string, job: Record<string, unknown>): Promise<T> => {
    calls.push({ entrypoint, job });
    return handler(entrypoint, job) as T;
  };
  return { calls, adapters: createSpamQuarantineAdapters(run, credentials) };
}

function envelope(payload: Record<string, unknown>): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId: "job-1",
    jobType: "remediation",
    tenantId: "t-a",
    runId: "",
    requestId: "req-1",
    correlationId: "corr-1",
    createdAt: "2026-11-10T00:00:00.000Z",
    payload,
  } as JobEnvelope;
}

describe("Spam, Quarantine & Allow/Block adapters (T-0852)", () => {
  it("lists quarantined messages through the get-quarantine.ps1 T-0007 envelope", async () => {
    const { calls, adapters } = harness(() => ({
      tenantId: "t-a",
      tab: "email",
      items: [
        {
          messageId: "msg-1",
          tab: "email",
          received: "2026-09-28T09:00:00Z",
          subject: "Invoice overdue",
          sender: "sender@example.invalid",
          recipient: "user@example.invalid",
          reason: "Spam",
          policy: "Default",
          expires: "2026-10-28T09:00:00Z",
          state: "Quarantined",
          direction: "Inbound",
          policyType: "HostedContentFilterPolicy",
          size: 1200,
        },
      ],
      totalCount: 1,
      nextCursor: "",
      retrievedAt: "2026-09-28T10:00:00Z",
    }));

    const page = await adapters.quarantine.listMessages("t-a", {
      tab: "email",
      reason: "Spam",
      direction: "Inbound",
      recipient: "user@example.invalid",
      state: "Quarantined",
      dateFrom: "2026-09-01T00:00:00Z",
      dateTo: "2026-09-30T00:00:00Z",
      cursor: "NTA",
      limit: 50,
    });

    expect(page).toEqual({
      tenantId: "t-a",
      tab: "email",
      items: [
        {
          messageId: "msg-1",
          tab: "email",
          received: "2026-09-28T09:00:00Z",
          subject: "Invoice overdue",
          sender: "sender@example.invalid",
          recipient: "user@example.invalid",
          reason: "Spam",
          policy: "Default",
          expires: "2026-10-28T09:00:00Z",
          state: "Quarantined",
          direction: "Inbound",
        },
      ],
      totalCount: 1,
      nextCursor: null,
      retrievedAt: "2026-09-28T10:00:00Z",
    });

    expect(calls[0]!.entrypoint).toBe("get-quarantine.ps1");
    expect(calls[0]!.job["schemaVersion"]).toBe("v1");
    expect(calls[0]!.job["credential"]).toMatchObject({ record: { tenantId: "t-a" } });
    expect(calls[0]!.job["payload"]).toMatchObject({
      tab: "email",
      reason: "Spam",
      direction: "Inbound",
      recipient: "user@example.invalid",
      state: "Quarantined",
      dateFrom: "2026-09-01T00:00:00Z",
      dateTo: "2026-09-30T00:00:00Z",
      cursor: "NTA",
      limit: 50,
    });
  });

  it("gets a single quarantined message detail and maps null or NotFound to undefined", async () => {
    const { calls, adapters } = harness((_entrypoint, job) => {
      const payload = job["payload"] as Record<string, unknown>;
      if (payload["messageId"] === "missing") return null;
      return {
        messageId: "msg-1",
        tab: "email",
        received: "2026-09-28T09:00:00Z",
        subject: "Invoice overdue",
        sender: "sender@example.invalid",
        recipient: "user@example.invalid",
        reason: "Spam",
        policy: "Default",
        expires: null,
        state: "Quarantined",
        direction: "Inbound",
        preview: { source: "exo", available: true, body: "<p>Hello</p>" },
      };
    });

    const detail = await adapters.quarantine.getMessage("t-a", "msg-1");
    expect(detail).toMatchObject({
      messageId: "msg-1",
      preview: { source: "exo", available: true, body: "<p>Hello</p>" },
    });
    expect(calls[0]!.job["payload"]).toEqual({ messageId: "msg-1" });

    expect(await adapters.quarantine.getMessage("t-a", "missing")).toBeUndefined();
  });

  it("submits quarantine review through queue and refreshes live status via submitProvider", async () => {
    const { calls, adapters } = harness((entrypoint, job) => {
      const payload = job["payload"] as Record<string, unknown>;
      if (entrypoint === "submit-quarantine-review.ps1" && payload["refresh"] === true) {
        return {
          success: true,
          action: "submit",
          messageId: payload["messageId"],
          submissionId: payload["submissionId"],
          status: "released",
          refreshed: true,
          refreshedAt: "2026-11-10T01:00:00.000Z",
        };
      }
      return {
        success: true,
        action: "submit",
        messageId: payload["messageId"],
        submissionId: "graph-sub-99",
        status: "pending",
        submittedAt: "2026-11-10T00:05:00.000Z",
      };
    });

    const jobId = await adapters.queue.enqueue(
      envelope({
        area: "quarantine",
        action: "submit",
        messageId: "msg-1",
        recipient: "user@example.invalid",
        submissionId: "local-sub-1",
        actor: "operator-1",
      }),
    );

    expect(jobId).toBe("job-1");
    expect(calls[0]!.entrypoint).toBe("submit-quarantine-review.ps1");
    expect(calls[0]!.job["payload"]).toMatchObject({
      messageId: "msg-1",
      recipient: "user@example.invalid",
      category: "spam",
      refresh: false,
      submissionId: "local-sub-1",
      actor: "operator-1",
    });

    const status = await adapters.submitProvider.getSubmissionStatus("t-a", "msg-1");
    expect(status).toEqual({
      submissionId: "graph-sub-99",
      messageId: "msg-1",
      status: "released",
      submittedAt: "2026-11-10T00:05:00.000Z",
      updatedAt: "2026-11-10T01:00:00.000Z",
    });
    expect(calls[1]!.entrypoint).toBe("submit-quarantine-review.ps1");
    expect(calls[1]!.job["payload"]).toMatchObject({
      messageId: "msg-1",
      refresh: true,
      submissionId: "graph-sub-99",
    });
  });

  it("maps quarantine NotFound errors on submit refresh to undefined", async () => {
    const run: WorkerRunner = async () => {
      throw new FeatureWorkerError("worker.failed", "failed", 1, "NotFound: submission not found");
    };
    const adapters = createSpamQuarantineAdapters(run, credentials);

    expect(await adapters.submitProvider.getSubmissionStatus("t-a", "msg-missing")).toBeUndefined();
  });

  it("lists and fetches quarantine policies via get-quarantine-policies.ps1", async () => {
    const { calls, adapters } = harness(() => ({
      tenantId: "t-a",
      items: [
        {
          name: "Default notification policy",
          policyType: "notification",
          esnEnabled: true,
          quarantineRetentionPeriod: 15,
          addressForMessages: "q@example.invalid",
          lastModified: "2026-09-20T12:00:00Z",
        },
      ],
      totalCount: 1,
      retrievedAt: "2026-09-28T00:00:00Z",
    }));

    const page = await adapters.quarantinePolicies.listPolicies("t-a");
    expect(page.items[0]).toMatchObject({
      name: "Default notification policy",
      policyType: "notification",
      esnEnabled: true,
      quarantineRetentionPeriod: 15,
    });
    expect(calls[0]!.entrypoint).toBe("get-quarantine-policies.ps1");
    expect(calls[0]!.job["schemaVersion"]).toBe("v1");

    const state = await adapters.quarantinePolicies.getPolicy(
      "t-a",
      "notification",
      "Default notification policy",
    );
    expect(state).toEqual({
      name: "Default notification policy",
      policyType: "notification",
      settings: {
        esnEnabled: true,
        quarantineRetentionPeriod: 15,
        addressForMessages: "q@example.invalid",
      },
    });
    expect(calls[1]!.job["payload"]).toEqual({
      policyType: "notification",
      policyName: "Default notification policy",
    });
    expect(
      await adapters.quarantinePolicies.getPolicy("t-a", "notification", "Missing"),
    ).toBeUndefined();
  });

  it("lists and fetches allow/block entries via get-allow-block.ps1", async () => {
    const { calls, adapters } = harness(() => ({
      tenantId: "t-a",
      items: [
        {
          type: "domain",
          value: "bad.example",
          action: "block",
          expiresOn: null,
          notes: "phishing",
        },
      ],
      totalCount: 1,
      retrievedAt: "2026-09-28T00:00:00Z",
    }));

    const page = await adapters.allowBlock.listEntries("t-a");
    expect(page.totalCount).toBe(1);
    expect(page.items[0]).toEqual({
      type: "domain",
      value: "bad.example",
      action: "block",
      expiresOn: null,
      notes: "phishing",
    });
    expect(calls[0]!.entrypoint).toBe("get-allow-block.ps1");
    expect(calls[0]!.job["schemaVersion"]).toBe("v1");

    const entry = await adapters.allowBlock.getEntry("t-a", "domain", "BAD.example", "block");
    expect(entry?.value).toBe("bad.example");
    expect(calls[1]!.job["payload"]).toEqual({
      type: "domain",
      value: "BAD.example",
      action: "block",
    });
    expect(
      await adapters.allowBlock.getEntry("t-a", "domain", "bad.example", "allow"),
    ).toBeUndefined();
  });

  it("lists filters and reconstructs FilterPolicy state from summary via get-filters.ps1", async () => {
    const { calls, adapters } = harness(() => ({
      tenantId: "t-a",
      filterType: "spam",
      items: [
        {
          name: "Default",
          priority: 0,
          state: "Enabled",
          summary:
            "BulkThreshold=6; SpamAction=MoveToJmf; HighConfidenceSpamAction=Quarantine; SpamZapEnabled=True",
          lastModified: "2026-09-20T10:00:00.000Z",
        },
      ],
      totalCount: 1,
      retrievedAt: "2026-09-28T00:00:00Z",
    }));

    const page = await adapters.filters.getFilters("t-a", "spam");
    expect(page.filterType).toBe("spam");
    expect(page.items[0]?.name).toBe("Default");
    expect(calls[0]!.entrypoint).toBe("get-filters.ps1");
    expect(calls[0]!.job["payload"]).toEqual({ filterType: "spam" });

    const policy = await adapters.filters.getFilterPolicy("t-a", "spam", "default");
    expect(policy).toEqual({
      name: "Default",
      enabled: true,
      settings: {
        bulkThreshold: 6,
        spamAction: "MoveToJmf",
        highConfidenceSpamAction: "Quarantine",
        spamZapEnabled: true,
      },
    });
    expect(await adapters.filters.getFilterPolicy("t-a", "spam", "missing")).toBeUndefined();
  });

  it("dispatches all remediation queue envelopes to the matching PowerShell workers", async () => {
    const { calls, adapters } = harness(() => ({ success: true }));

    await adapters.queue.enqueue(
      envelope({
        area: "quarantine",
        action: "release",
        messageId: "msg-1",
        recipient: "user@example.invalid",
        sender: "sender@example.invalid",
        actor: "operator-1",
      }),
    );
    await adapters.queue.enqueue(
      envelope({
        area: "quarantine",
        action: "block",
        messageId: "msg-1",
        sender: "bad@example.invalid",
        actor: "operator-1",
      }),
    );
    await adapters.queue.enqueue(
      envelope({
        area: "quarantine-bulk",
        action: "delete",
        cap: 50,
        confirm: true,
        actor: "operator-1",
        messages: [{ messageId: "msg-1", recipient: "user@example.invalid", sender: "s", subject: "x" }],
      }),
    );
    await adapters.queue.enqueue(
      envelope({
        area: "quarantine-policies",
        action: "delete",
        policyType: "notification",
        policyName: "Strict notification",
        actor: "operator-1",
      }),
    );
    await adapters.queue.enqueue(
      envelope({
        area: "allow-block",
        action: "create",
        type: "url",
        value: "https://evil.example/login",
        entryAction: "block",
        expiresOn: "2027-01-01T00:00:00.000Z",
        notes: "phish",
        actor: "operator-1",
      }),
    );
    await adapters.queue.enqueue(
      envelope({
        area: "filters",
        action: "disable",
        filterType: "spam",
        policyName: "Default",
        settings: {},
        actor: "operator-1",
      }),
    );

    expect(calls.map((c) => c.entrypoint)).toEqual([
      "invoke-quarantine-action.ps1",
      "set-allow-block-entry.ps1",
      "invoke-quarantine-bulk.ps1",
      "set-quarantine-policy.ps1",
      "set-allow-block-entry.ps1",
      "set-filter.ps1",
    ]);

    expect(calls[0]!.job).toMatchObject({
      schemaVersion: "v1",
      correlationId: "corr-1",
      payload: {
        action: "release",
        messageId: "msg-1",
        recipient: "user@example.invalid",
        dryRun: false,
        confirm: true,
      },
    });
    expect(calls[1]!.job["payload"]).toMatchObject({
      type: "sender",
      action: "create",
      value: "bad@example.invalid",
      entryAction: "block",
      dryRun: false,
    });
    expect(calls[2]!.job["payload"]).toMatchObject({
      action: "delete",
      cap: 50,
      confirm: true,
      dryRun: false,
    });
    expect(calls[3]!.job["payload"]).toMatchObject({
      policyType: "notification",
      action: "delete",
      policyName: "Strict notification",
      confirm: true,
      dryRun: false,
    });
    expect(calls[4]!.job["payload"]).toMatchObject({
      type: "url",
      action: "create",
      value: "https://evil.example/login",
      entryAction: "block",
      expiresOn: "2027-01-01T00:00:00.000Z",
      notes: "phish",
      dryRun: false,
    });
    expect(calls[5]!.job["payload"]).toMatchObject({
      filterType: "spam",
      action: "disable",
      policyName: "Default",
      confirm: true,
      dryRun: false,
    });
  });

  it("fails with 409 when the tenant has no credential and 400 on unknown remediation area", async () => {
    const { adapters } = harness(() => ({}));

    await expect(
      adapters.quarantine.listMessages("t-missing", { tab: "email", cursor: null, limit: 50 }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      adapters.queue.enqueue(envelope({ area: "unknown-area", action: "create" })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("maps FeatureWorkerError on reads to 502 and NotFound on getMessage to undefined", async () => {
    const notFoundRun: WorkerRunner = async () => {
      throw new FeatureWorkerError("worker.failed", "failed", 1, "NotFound: message not found");
    };
    const notFoundAdapters = createSpamQuarantineAdapters(notFoundRun, credentials);
    expect(await notFoundAdapters.quarantine.getMessage("t-a", "missing")).toBeUndefined();

    const errorRun: WorkerRunner = async () => {
      throw new FeatureWorkerError("worker.failed", "exited 1", 1, "EXO connection failed");
    };
    const errorAdapters = createSpamQuarantineAdapters(errorRun, credentials);
    await expect(errorAdapters.allowBlock.listEntries("t-a")).rejects.toMatchObject({ status: 502 });
  });

  it("handles releaseAll, submitProvider fallback id, and antiphish filter summary parsing", async () => {
    const { calls, adapters } = harness((entrypoint) => {
      if (entrypoint === "submit-quarantine-review.ps1") {
        return null;
      }
      if (entrypoint === "get-filters.ps1") {
        return {
          tenantId: "t-a",
          filterType: "antiphish",
          items: [
            {
              name: "Standard Preset Policy",
              priority: 1,
              state: "Disabled",
              summary: "Enabled=False; PhishThresholdLevel=2; EnableSpoofIntelligence=True",
              lastModified: "2026-09-22T10:00:00.000Z",
            },
          ],
          totalCount: 1,
          retrievedAt: "2026-09-28T00:00:00Z",
        };
      }
      return { success: true };
    });

    await adapters.queue.enqueue(
      envelope({
        area: "quarantine",
        action: "releaseAll",
        messageId: "msg-2",
        recipient: null,
        sender: "sender@example.invalid",
        actor: "operator-1",
      }),
    );
    expect(calls[0]!.job["payload"]).toMatchObject({
      action: "releaseAll",
      messageId: "msg-2",
      confirm: true,
      dryRun: false,
    });
    expect("recipient" in (calls[0]!.job["payload"] as Record<string, unknown>)).toBe(false);

    expect(await adapters.submitProvider.getSubmissionStatus("t-a", "msg-untracked")).toBeUndefined();
    expect(calls[1]!.job["payload"]).toEqual({
      messageId: "msg-untracked",
      refresh: true,
      submissionId: "msg-untracked",
    });

    const phishPolicy = await adapters.filters.getFilterPolicy(
      "t-a",
      "antiphish",
      "Standard Preset Policy",
    );
    expect(phishPolicy).toEqual({
      name: "Standard Preset Policy",
      enabled: false,
      settings: {
        enabled: false,
        phishThresholdLevel: 2,
        enableSpoofIntelligence: true,
      },
    });
  });
});
