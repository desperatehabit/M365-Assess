import { describe, expect, it } from "vitest";
import type { RestoreJob, RestoreJobInput, RestoreJobUpdate } from "@m365-assess/db";
import { AppError } from "../errors.js";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import { createEmailToolsProviders, type RestoreJobRepository } from "./email-tools.js";
import { WORKER_FAILED, type WorkerRunner } from "./workers.js";

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
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

function inMemoryRestoreJobs(): RestoreJobRepository & { readonly rows: Map<string, RestoreJob> } {
  const rows = new Map<string, RestoreJob>();
  return {
    rows,
    async createRestoreJob(input: RestoreJobInput): Promise<RestoreJob> {
      const job: RestoreJob = {
        id: input.id,
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        scope: input.scope,
        target: input.target,
        state: input.state ?? "planned",
        result: input.result ?? null,
        createdAt: input.createdAt ?? "2026-11-07T00:00:00.000Z",
        createdBy: input.createdBy,
      };
      rows.set(job.id, job);
      return job;
    },
    async getRestoreJob(tenantId: string, jobId: string): Promise<RestoreJob | undefined> {
      const job = rows.get(jobId);
      return job?.tenantId === tenantId ? job : undefined;
    },
    async updateRestoreJob(
      tenantId: string,
      jobId: string,
      update: RestoreJobUpdate,
    ): Promise<RestoreJob | undefined> {
      const job = rows.get(jobId);
      if (job?.tenantId !== tenantId) return undefined;
      const next = { ...job, ...update };
      rows.set(jobId, next);
      return next;
    },
  };
}

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
  const restoreJobs = inMemoryRestoreJobs();
  return { calls, restoreJobs, providers: createEmailToolsProviders(run, credentials, restoreJobs) };
}

describe("Email Tools providers (T-0854)", () => {
  it("traces messages through the envelope worker and normalizes an empty cursor", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      items: [
        {
          timestamp: "2026-11-01T10:00:00Z",
          sender: "sender@example.invalid",
          recipient: "recipient@example.invalid",
          subject: "Invoice",
          status: "Delivered",
          event: "Deliver",
          messageId: "msg-1",
        },
      ],
      nextCursor: "",
      totalCount: 1,
      retrievedAt: "2026-11-01T10:05:00Z",
    }));

    const page = await providers.messageTrace.traceMessages("t-a", {
      sender: "sender@example.invalid",
      subject: "Invoice",
      cursor: null,
      limit: 50,
    });

    expect(page.nextCursor).toBeNull();
    expect(page.items[0]?.messageId).toBe("msg-1");
    expect(calls[0]!.entrypoint).toBe("get-message-trace.ps1");
    expect(calls[0]!.job["schemaVersion"]).toBe("v1");
    expect(calls[0]!.job["payload"]).toMatchObject({
      sender: "sender@example.invalid",
      subject: "Invoice",
      top: 50,
      cursor: "",
    });
    expect(calls[0]!.job["credential"]).toMatchObject({ record: { tenantId: "t-a" } });
  });

  it("starts, polls, and cancels a historical search with a stable job id", async () => {
    const { calls, providers } = harness((entrypoint, job) => {
      const payload = job["payload"] as Record<string, unknown>;
      if (payload["action"] === "start") {
        return {
          jobId: payload["jobId"],
          tenantId: "t-a",
          searchName: `historical-search-${String(payload["jobId"])}`,
          state: "running",
          updatedAt: "2026-11-01T10:00:00Z",
        };
      }
      if (payload["action"] === "poll") {
        return {
          jobId: payload["jobId"],
          tenantId: "t-a",
          searchName: "historical-search-job-1",
          state: "succeeded",
          updatedAt: "2026-11-01T10:05:00Z",
          matches: [{ mailbox: "mbx@example.invalid", subject: "Invoice", receivedAt: "2026-11-01T09:00:00Z" }],
          totalCount: 1,
          downloadRef: "compliance-search/name/export",
        };
      }
      return {
        jobId: payload["jobId"],
        tenantId: "t-a",
        searchName: "historical-search-job-1",
        state: "cancelled",
        updatedAt: "2026-11-01T10:06:00Z",
      };
    });

    const started = await providers.historicalSearch.startSearch("t-a", {
      query: "subject:invoice",
      mailboxes: ["mbx@example.invalid"],
    });
    const polled = await providers.historicalSearch.getSearch("t-a", started.id);
    const cancelled = await providers.historicalSearch.cancelSearch("t-a", started.id);

    expect(started.id).toBeTruthy();
    expect(started.createdAt).toBe("2026-11-01T10:00:00Z");
    expect(polled.job.state).toBe("succeeded");
    expect(polled.matches).toHaveLength(1);
    expect(polled.downloadRef).toBe("compliance-search/name/export");
    expect(cancelled.state).toBe("cancelled");
    expect(calls.map((call) => (call.job["payload"] as Record<string, unknown>)["action"])).toEqual([
      "start",
      "poll",
      "cancel",
    ]);
    expect((calls[0]!.job["payload"] as Record<string, unknown>)["jobId"]).toBe(started.id);
  });

  it("reads a message detail and returns null for an unknown message", async () => {
    let fail = false;
    const { calls, providers } = harness(() => {
      if (fail) {
        throw new AppError(WORKER_FAILED, "message 'msg-404' was not found", 502);
      }
      return {
        tenantId: "t-a",
        messageId: "msg-1",
        subject: "Invoice",
        sender: "sender@example.invalid",
        recipients: ["recipient@example.invalid"],
        receivedAt: "2026-11-01T09:00:00Z",
        status: "Delivered",
        size: "1 KB",
        deliveryEvents: [],
        connectors: [],
        filtersHit: [],
        headers: [],
        body: null,
        bodyGated: true,
        bodyGateReason: "gated",
        retrievedAt: "2026-11-01T10:00:00Z",
      };
    });

    const detail = await providers.messages.getMessage("t-a", "msg-1", true);
    expect(detail?.messageId).toBe("msg-1");
    expect(calls[0]!.job["payload"]).toMatchObject({ messageId: "msg-1", includeBody: true });

    fail = true;
    const missing = await providers.messages.getMessage("t-a", "msg-404", false);
    expect(missing).toBeNull();
  });

  it("plans and applies a mailbox restore, persisting the RestoreJob", async () => {
    const { calls, providers, restoreJobs } = harness((entrypoint, job) => {
      const payload = job["payload"] as Record<string, unknown>;
      const plan = {
        action: "restore",
        mailboxId: payload["mailboxId"],
        scope: payload["scope"],
        target: payload["target"] ?? null,
        before: { itemCount: 1 },
        after: { itemCount: 1 },
        diff: ["restore"],
        valid: true,
        dryRun: payload["dryRun"] === true,
        requiresConfirmation: payload["confirmed"] !== true,
      };
      if (payload["dryRun"] === true) {
        return {
          success: true,
          dryRun: true,
          plan,
          job: {
            id: "job-plan",
            tenantId: "t-a",
            mailboxId: payload["mailboxId"],
            scope: payload["scope"],
            target: null,
            state: "planned",
            result: null,
            createdBy: "",
          },
        };
      }
      return {
        success: true,
        dryRun: false,
        plan: { ...plan, dryRun: false, requiresConfirmation: false },
        result: { before: { itemCount: 1 }, after: { itemCount: 2 } },
        auditEvent: { id: "a-1", tenantId: "t-a", action: "mail.restore.apply", targetId: "job-1", timestamp: "2026-11-01T10:00:00Z" },
        job: {
          id: "job-1",
          tenantId: "t-a",
          mailboxId: payload["mailboxId"],
          scope: payload["scope"],
          target: null,
          state: "completed",
          result: { before: { itemCount: 1 }, after: { itemCount: 2 } },
          createdBy: payload["createdBy"],
        },
      };
    });

    const plan = await providers.mailRestores.planRestore("t-a", {
      mailboxId: "mbx@example.invalid",
      scope: "mailbox",
    }, "user-1");
    expect(plan.dryRun).toBe(true);
    expect(plan.action).toBe("restore");

    const result = await providers.mailRestores.applyRestore("t-a", {
      mailboxId: "mbx@example.invalid",
      scope: "mailbox",
    }, "user-1");
    expect(result.job.id).toBe("job-1");
    expect(result.job.state).toBe("completed");
    expect(result.auditEvent?.id).toBe("a-1");
    expect(restoreJobs.rows.get("job-1")?.createdBy).toBe("user-1");
    expect((calls[0]!.job["payload"] as Record<string, unknown>)["action"]).toBe("plan");
    expect((calls[1]!.job["payload"] as Record<string, unknown>)["action"]).toBe("apply");
  });

  it("returns a persisted restore job or a not-found error", async () => {
    const { providers, restoreJobs } = harness(() => ({}));
    await restoreJobs.createRestoreJob({
      id: "job-1",
      tenantId: "t-a",
      mailboxId: "mbx",
      scope: "mailbox",
      target: null,
      createdBy: "user-1",
    });

    const job = await providers.mailRestores.getRestoreJob("t-a", "job-1");
    expect(job.id).toBe("job-1");
    await expect(providers.mailRestores.getRestoreJob("t-a", "missing")).rejects.toThrow(/not found/);
  });

  it("reads encryption configuration and applies a template with a top-level action", async () => {
    const { calls, providers } = harness((entrypoint, job) => {
      if (job["action"] === "apply") {
        return {
          plan: { action: "ome-template-apply", templateId: "Default", targetName: "Default", diff: [], valid: true, dryRun: false, requiresConfirmation: false },
          result: { templateId: "Default", state: "applied" },
          auditEvent: { id: "a-1", tenantId: "t-a", action: "mail.encryption_template.apply", targetId: "Default", targetName: "Default", timestamp: "2026-11-01T10:00:00Z" },
          success: true,
        };
      }
      return {
        tenantId: "t-a",
        irmConfiguration: {
          identity: "Default",
          azureRmsLicensingEnabled: true,
          internalLicensingEnabled: true,
          externalLicensingEnabled: false,
        },
        omeTemplates: [],
        retrievedAt: "2026-11-01T10:00:00Z",
      };
    });

    const config = await providers.encryption.getMessageEncryption("t-a");
    expect(config?.tenantId).toBe("t-a");
    expect(config?.irmConfiguration.azureRmsLicensingEnabled).toBe(true);

    const applied = await providers.encryption.applyMessageEncryptionTemplate(
      "t-a",
      { templateId: "Default", settings: { portalText: "Confidential" } },
      false,
    );
    expect("plan" in applied).toBe(true);
    expect(calls[1]!.job["action"]).toBe("apply");
    expect(calls[1]!.job["payload"]).toMatchObject({ templateId: "Default", confirmed: true, dryRun: false });
  });
});
