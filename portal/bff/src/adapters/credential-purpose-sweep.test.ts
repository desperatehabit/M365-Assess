// Operator-credential sweep (T-0940).
//
// Every write worker invocation must sign in with the opt-in
// `tenants/<id>/operator-credential`; an adjacent read keeps the reader
// `tenants/<id>/credential`. One file records that contract for every write
// domain so the sweep is reviewable in one place. The shared assertions live in
// `credential-purpose.test-helper.ts`.
import type { JobEnvelope } from "@m365-assess/contracts";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createAuditProviders } from "./audit-logs.js";
import { createContactsResourcesAdapters } from "./contacts-resources.js";
import { createCaProviders } from "./conditional-access.js";
import { createDefenderProviders } from "./defender.js";
import { createDomainsProviders } from "./domains.js";
import { createEmailToolsProviders } from "./email-tools.js";
import { createGroupProviders } from "./groups.js";
import { createIncidentProviders } from "./incidents.js";
import {
  createAppUploadQueue,
  createAppUploadRunner,
  createIntuneAppProviders,
} from "./intune-apps.js";
import { createIntuneProviders } from "./intune.js";
import { createMailboxProviders } from "./mailboxes.js";
import { createAuthMethodsPolicyProvider, createMfaProviders, createRegistrationCampaignProvider } from "./mfa.js";
import { createPurviewProviders } from "./purview.js";
import { createRoleProviders } from "./roles.js";
import { createSharePointProviders } from "./sharepoint.js";
import { createSharingProviders } from "./sharing.js";
import { createSpamQuarantineAdapters } from "./spam-quarantine.js";
import { createTeamsProviders } from "./teams.js";
import { createTransportProviders } from "./transport.js";
import {
  createBecProviders,
  createOffboardingRunner,
  createUserProviders,
} from "./users.js";
import { createEnvelopeWorker, createTenantWorker, type WorkerRunner } from "./workers.js";
import {
  expectCallPurposes,
  expectOperatorCall,
  expectReaderCall,
  purposeAwareCredentials,
  type RecordedWorkerCall,
} from "./credential-purpose.test-helper.js";
import { createLicenseChangeProvider } from "../routes/license-assign.js";
import { createGraphExplorerWorkerExecutor } from "../tools/graph-explorer-service.js";

const TENANT = "t-a";

function harness(
  respond: (entrypoint: string, job: Record<string, unknown>) => unknown = () => ({}),
  options: { readonly operator?: boolean; readonly tenants?: readonly string[] } = {},
) {
  const calls: RecordedWorkerCall[] = [];
  const run: WorkerRunner = async (entrypoint, job) => {
    calls.push({ entrypoint, job: job as Record<string, unknown> });
    return respond(entrypoint, job as Record<string, unknown>) as never;
  };
  return {
    run,
    calls,
    credentials: purposeAwareCredentials(options.tenants ?? [TENANT], {
      operator: options.operator ?? true,
    }),
  };
}

function envelopeOf(tenantId: string): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId: "job-1",
    jobType: "custom-script",
    tenantId,
    runId: "run-1",
    requestId: "req-1",
    correlationId: "corr-1",
    createdAt: "2026-11-20T00:00:00.000Z",
    payload: {},
  } as JobEnvelope;
}

describe("operator credential seam (T-0940)", () => {
  it("a write without an operator credential answers 409 instead of falling back", async () => {
    const run = vi.fn(async () => ({}));
    const call = createTenantWorker(
      run as unknown as WorkerRunner,
      purposeAwareCredentials([TENANT], { operator: false }),
    );
    await expect(call("set-group.ps1", TENANT, {}, { purpose: "operator" })).rejects.toMatchObject({
      code: "tenant.operator_credential_missing",
      status: 409,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("an omitted purpose still uses the reader credential", async () => {
    const { run, calls, credentials } = harness();
    await createTenantWorker(run, credentials)("get-groups.ps1", TENANT, {});
    expectReaderCall(calls[0]!);
  });
});

describe("users writes (T-0940)", () => {
  it("creates, patches, and acts with operator; lists and previews with reader", async () => {
    const { run, calls, credentials } = harness();
    const users = createUserProviders(createEnvelopeWorker(run, credentials));

    await users.list.listUsers(TENANT, { cursor: null, limit: 25 });
    await users.create.createUsers(TENANT, [], { dryRun: false });
    await users.execute.executeAction(TENANT, "u-1", "resetPassword", { dryRun: false });
    await users.patch.patchUsers(TENANT, [], { preview: false });
    await users.create.createUsers(TENANT, [], { dryRun: true });

    expectCallPurposes(calls, TENANT, ["reader", "operator", "operator", "operator", "reader"]);
  });

  it("runs BEC remediation and offboarding with operator", async () => {
    const { run, calls, credentials } = harness((entrypoint) =>
      entrypoint === "invoke-bec-check.ps1"
        ? { status: "remediated", before: null, after: { action: "revokeSessions" }, error: null }
        : { order: 1, state: "succeeded", result: null, error: null, appliedAt: null },
    );
    const envelope = createEnvelopeWorker(run, credentials);

    await createBecProviders(envelope).remediate.remediate(
      TENANT,
      "u-1",
      {
        id: "f-1",
        tenantId: TENANT,
        userId: "u-1",
        check: "signinLocations",
        detail: {},
        state: "open",
        createdAt: "",
        updatedAt: "",
      } as never,
      "revokeSessions",
    );

    const job = { id: "job-1", tenantId: TENANT, userIds: ["u-1"], options: {}, createdBy: "admin" };
    const step = { jobId: "job-1", order: 1, action: "disable-sign-in", state: "pending", result: null, error: null, appliedAt: null };
    const repo = {
      getOffboardingJob: async () => job,
      updateOffboardingJobState: async () => job,
      listOffboardingSteps: async () => [step],
      updateOffboardingStep: async () => undefined,
    } as never;
    const runner = createOffboardingRunner(envelope, repo);
    await runner.enqueue({ jobId: "job-1", tenantId: TENANT });
    await runner.idle();

    expectCallPurposes(calls, TENANT, ["operator", "operator"]);
  });
});

describe("groups writes (T-0940)", () => {
  it("writes with operator, previews and reads with reader", async () => {
    const { run, calls, credentials } = harness();
    const groups = createGroupProviders(run, credentials);

    await groups.list.listGroups(TENANT, { cursor: null, limit: 20 });
    await groups.crud.createGroup(TENANT, { displayName: "G", groupType: "security" }, true);
    await groups.crud.createGroup(TENANT, { displayName: "G", groupType: "security" }, false);
    await groups.gal.setGal(TENANT, "g-1", { hiddenFromAddressListsEnabled: true }, false);
    await groups.members.invokeBulkMembership(TENANT, "g-1", "members", { operation: "add", users: ["u-1"] }, false);

    expect(calls.map((c) => c.entrypoint)).toEqual([
      "get-groups.ps1",
      "set-group.ps1",
      "set-group.ps1",
      "set-group-gal-delivery.ps1",
      "group-membership-bulk.ps1",
    ]);
    expectCallPurposes(calls, TENANT, ["reader", "reader", "operator", "operator", "operator"]);
  });

  it("refuses a real group write when the tenant has no operator credential", async () => {
    const { run, calls, credentials } = harness(() => ({}), { operator: false });
    const groups = createGroupProviders(run, credentials);
    await expect(
      groups.crud.createGroup(TENANT, { displayName: "G", groupType: "security" }, false),
    ).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(0);
  });
});

describe("Conditional Access writes (T-0940)", () => {
  it("applies policies, named locations, and templates with operator; plans and reads with reader", async () => {
    const { run, calls, credentials } = harness();
    const ca = createCaProviders(run, credentials, new Database(":memory:"));

    await ca.policies.listPolicies(TENANT, { cursor: null, limit: 20 });
    await ca.crud.createPolicy(TENANT, { displayName: "P" }, true);
    await ca.crud.createPolicy(TENANT, { displayName: "P" }, false);
    await ca.namedLocations.createLocation(TENANT, { displayName: "L", locationType: "ip" }, false);
    await ca.templateDeploy.planDeploy(
      { id: "tpl-1" } as never,
      { tenantId: TENANT, createGroups: false, overwrite: false, disableSecurityDefaults: false, breakGlassExclusions: [] },
    );
    await ca.templateDeploy.executeDeploy(
      { id: "tpl-1" } as never,
      { tenantId: TENANT, createGroups: false, overwrite: false, disableSecurityDefaults: false, breakGlassExclusions: [] },
    );

    expectCallPurposes(calls, TENANT, ["reader", "reader", "operator", "operator", "reader", "operator"]);
  });
});

describe("roles, PIM and JIT writes (T-0940)", () => {
  it("requests PIM/JIT with operator; reads assignments and request status with reader", async () => {
    const { run, calls, credentials } = harness();
    const roles = createRoleProviders(createTenantWorker(run, credentials));

    await roles.roles.listRoleAssignments(TENANT, { cursor: null, limit: 20 });
    await roles.pimRequests.submitRequest(TENANT, {
      principalId: "u-1",
      roleId: "r-1",
      action: "assign",
      justification: "change",
      durationHours: 1,
      approvalRequired: false,
    });
    await roles.pimRequests.getRequestStatus(TENANT, "req-1");
    await roles.applySettings.applySettings(TENANT, "r-1", {}, { dryRun: true });
    await roles.applySettings.applySettings(TENANT, "r-1", {}, { dryRun: false });
    await roles.jit.grantRole(TENANT, {
      userId: "u-1",
      roleId: "r-1",
      assignmentType: "eligible",
      durationHours: 1,
      maxDurationHours: 8,
    });
    await roles.jit.revokeRole(TENANT, { userId: "u-1", roleId: "r-1", assignmentType: "eligible" });

    expectCallPurposes(calls, TENANT, ["reader", "operator", "reader", "reader", "operator", "operator", "operator"]);
  });
});

describe("Intune writes (T-0940)", () => {
  it("applies policies, filters, reusable settings, and device actions with operator", async () => {
    const { run, calls, credentials } = harness();
    const intune = createIntuneProviders(run, credentials);

    await intune.policies.listPolicies(TENANT, "configurationPolicies", { cursor: null, limit: 20 });
    await intune.crud.createPolicy(TENANT, "configurationPolicies", {}, true);
    await intune.crud.createPolicy(TENANT, "configurationPolicies", {}, false);
    await intune.assignmentFilters.create(TENANT, { name: "F" } as never, "admin");
    await intune.assignmentFilters.planDeploy(TENANT, { name: "F" } as never);
    await intune.reusableSettings.sync(TENANT, [], { preview: false, actor: "admin" });
    await intune.deviceActions.applyAction(TENANT, "d-1", "sync", "reason");
    await intune.destructiveActions.applyAction(TENANT, "d-1", "wipe", "reason");

    expectCallPurposes(calls, TENANT, [
      "reader",
      "reader",
      "operator",
      "operator",
      "reader",
      "operator",
      "operator",
      "operator",
    ]);
  });

  it("writes apps, assignments, autopilot, and enrollment with operator; reads and previews with reader", async () => {
    const { run, calls, credentials } = harness();
    const apps = createIntuneAppProviders(createTenantWorker(run, credentials));

    await apps.apps.listApps(TENANT, { view: "all", cursor: null, limit: 20 } as never);
    await apps.crud.changeApp(TENANT, "app-1", { action: "update", preview: true, changes: {}, actor: "admin" });
    await apps.crud.changeApp(TENANT, "app-1", { action: "update", preview: false, changes: {}, actor: "admin" });
    await apps.assign.assign(TENANT, "app-1", { assignments: [], mode: "replace", preview: false, actor: "admin" });
    await apps.autopilot.importDevices(TENANT, { source: "csv", csv: "", preview: false, actor: "admin" });
    await apps.autopilotWrite.write(TENANT, { action: "create", preview: false, actor: "admin" });
    await apps.enrollment.write(TENANT, { action: "create", platform: "windows", preview: false, actor: "admin" });

    expectCallPurposes(calls, TENANT, ["reader", "reader", "operator", "operator", "operator", "operator", "operator"]);
  });
});

describe("app upload queue (T-0940)", () => {
  it("envelopes and runs the upload with the operator credential", async () => {
    const envelopes: JobEnvelope[] = [];
    const queue = createAppUploadQueue({
      enqueue: async (envelope) => (envelopes.push(envelope as JobEnvelope), "job-1"),
    });
    await queue.enqueue({ jobId: "job-1", tenantId: TENANT, deploymentId: "dep-1", correlationId: "corr" });
    expect(envelopes[0]!.payload).toMatchObject({
      credentialRef: `tenants/${TENANT}/operator-credential`,
      purpose: "operator",
    });

    const { run, calls, credentials } = harness(() => ({ state: "succeeded", appId: "app-1", steps: [] }));
    const deployment = {
      id: "dep-1",
      tenantId: TENANT,
      appType: "store",
      payload: { displayName: "App" },
      results: {},
      state: "queued",
      createdBy: "admin",
      createdAt: "",
      updatedAt: "",
    };
    const runner = createAppUploadRunner({
      call: createTenantWorker(run, credentials),
      repository: {
        getDeployment: async () => deployment,
        transitionDeployment: async (_t: string, _d: string, state: string) => ({ ...deployment, state }),
      } as never,
      packages: {} as never,
      packageBaseUrl: "http://127.0.0.1:1",
    });
    await runner(
      {
        ...envelopeOf(TENANT),
        jobType: "app-upload",
        payload: {
          contextRef: "app-deployments/dep-1",
          outputRef: "app-deployments/dep-1",
          credentialRef: `tenants/${TENANT}/operator-credential`,
          purpose: "operator",
          sectionRefs: [],
          artifactRefs: [],
        },
      } as JobEnvelope,
      new AbortController().signal,
    );

    expectOperatorCall(calls[0]!);
  });
});

describe("SharePoint and Teams writes (T-0940)", () => {
  it("creates sites, edits lifecycle, and cleans versions with operator; reads and plans with reader", async () => {
    const { run, calls, credentials } = harness((entrypoint) =>
      entrypoint === "invoke-sharepoint-site-action.ps1"
        ? { action: "restore", mode: "apply", results: [], auditEvents: [], summary: { total: 0, succeeded: 0, failed: 0 } }
        : {},
    );
    const sharepoint = createSharePointProviders(run, credentials);

    await sharepoint.sites.listSites(TENANT, { cursor: null, limit: 20 });
    await sharepoint.sitesCreate.createSite(
      TENANT,
      { name: "Site", alias: "site", type: "team", owners: ["admin"], sharing: "internal" },
      true,
    );
    await sharepoint.sitesCreate.createSite(
      TENANT,
      { name: "Site", alias: "site", type: "team", owners: ["admin"], sharing: "internal" },
      false,
    );
    await sharepoint.lifecycle.editSite(TENANT, "s-1", {}, false);
    await sharepoint.lifecycle.recycleBinAction(TENANT, { action: "restore", itemIds: ["i-1"] } as never, false);
    await sharepoint.storage.cleanupVersions(TENANT, "s-1", { ageThresholdDays: 30, preview: true });
    await sharepoint.storage.cleanupVersions(TENANT, "s-1", { ageThresholdDays: 30, preview: false });

    expectCallPurposes(calls, TENANT, ["reader", "reader", "operator", "operator", "operator", "reader", "operator"]);
  });

  it("edits teams, voice, creates, and LIS with operator; lists and previews with reader", async () => {
    const { run, calls, credentials } = harness();
    const teams = createTeamsProviders(run, credentials);

    await teams.teams.listTeams(TENANT, { cursor: null, limit: 20 } as never);
    await teams.lifecycle.editTeam(TENANT, "tm-1", {}, true);
    await teams.lifecycle.editTeam(TENANT, "tm-1", {}, false);
    await teams.voice.assignNumber(TENANT, { phoneNumber: "+1", targetId: "u-1" }, false);
    await teams.enqueueCreate(envelopeOf(TENANT));
    await teams.enqueueLis({ ...envelopeOf(TENANT), payload: { action: "create", displayName: "L" } });

    expectCallPurposes(calls, TENANT, ["reader", "reader", "operator", "operator", "operator", "operator"]);
  });
});

describe("email writes (T-0940)", () => {
  it("writes mailbox settings, rules, permissions, retention, and vacation with operator", async () => {
    const { run, calls, credentials } = harness(() => ({ items: [] }));
    const mailboxes = createMailboxProviders(run, credentials, new Database(":memory:"));

    await mailboxes.mailboxes.listMailboxes(TENANT, { cursor: null, limit: 20 } as never);
    await mailboxes.mailboxWrite.createSharedMailbox(TENANT, { displayName: "Shared" }, true);
    await mailboxes.mailboxWrite.createSharedMailbox(TENANT, { displayName: "Shared" }, false);
    await mailboxes.mailboxSettings.setMailboxSettings(TENANT, "m-1", {}, false);
    await mailboxes.mailboxPermissions.grantPermission(
      TENANT,
      "m-1",
      { action: "add", scope: "mailbox", principal: "u-1" } as never,
      false,
    );
    await mailboxes.mailboxRules.createRule(TENANT, "m-1", { name: "Rule" } as never, false);
    await mailboxes.retention.assignTag(TENANT, { tagId: "tag-1", mailboxId: "m-1" } as never, false);
    await mailboxes.vacationApply.applyVacationPhase(
      TENANT,
      {
        id: "v-1",
        tenantId: TENANT,
        mailboxId: "m-1",
        startsAt: "2026-11-20T00:00:00Z",
        endsAt: "2026-11-21T00:00:00Z",
        oooMessage: "Away",
        forwardTo: null,
        state: "scheduled",
        createdAt: "",
        updatedAt: "",
      } as never,
      "enable",
    );
    await mailboxes.deletedMailboxes.restoreMailbox(TENANT, "m-1", {} as never, false);

    expectCallPurposes(calls, TENANT, [
      "reader",
      "reader",
      "operator",
      "operator",
      "operator",
      "operator",
      "operator",
      "operator",
      "operator",
    ]);
  });

  it("starts/searches/restores with operator; trace and poll reads stay reader", async () => {
    const { run, calls, credentials } = harness(() => ({ items: [] }));
    const tools = createEmailToolsProviders(run, credentials, {
      createRestoreJob: async (input) => ({
        ...input,
        state: "completed",
        result: null,
        createdAt: "",
      }),
    } as never);

    await tools.messageTrace.traceMessages(TENANT, { cursor: null, limit: 20 } as never);
    await tools.historicalSearch.startSearch(TENANT, { query: "x", mailboxes: ["u@example.invalid"] });
    await tools.historicalSearch.getSearch(TENANT, "job-1");
    await tools.historicalSearch.cancelSearch(TENANT, "job-1");
    await tools.mailRestores.planRestore(TENANT, { mailboxId: "m-1", scope: "mailbox" } as never);
    await tools.mailRestores.applyRestore(TENANT, { mailboxId: "m-1", scope: "mailbox" } as never);
    await tools.encryption.getMessageEncryption(TENANT);
    await tools.encryption.applyMessageEncryptionTemplate(TENANT, { settings: {} } as never, true);
    await tools.encryption.applyMessageEncryptionTemplate(TENANT, { settings: {} } as never, false);

    expectCallPurposes(calls, TENANT, [
      "reader",
      "operator",
      "reader",
      "operator",
      "reader",
      "operator",
      "reader",
      "reader",
      "operator",
    ]);
  });

  it("writes transport rules, connectors, and template deploys with operator", async () => {
    const { run, calls, credentials } = harness();
    const transport = createTransportProviders(run, credentials);

    await transport.rules.listTransportRules(TENANT, { cursor: null, limit: 20 });
    await transport.rulesWrite.createRule(TENANT, { name: "Rule" }, true);
    await transport.rulesWrite.createRule(TENANT, { name: "Rule" }, false);
    await transport.connectors.createConnector(TENANT, { name: "Conn" } as never, false);
    await transport.deploy.apply({
      kind: "transport-rule",
      tenantId: TENANT,
      templateId: "tpl-1",
      name: "Rule",
      actor: "admin",
      payload: {},
    } as never);

    expectCallPurposes(calls, TENANT, ["reader", "reader", "operator", "operator", "operator"]);
  });

  it("queues every quarantine/allow-block/filter write with operator", async () => {
    const { run, calls, credentials } = harness(() => ({ items: [] }));
    const spam = createSpamQuarantineAdapters(run, credentials);

    await spam.quarantine.listMessages(TENANT, { tab: "email", cursor: null, limit: 20 } as never);
    await spam.queue.enqueue({
      ...envelopeOf(TENANT),
      jobType: "remediation",
      payload: { area: "quarantine", action: "release", messageId: "msg-1" },
    } as JobEnvelope);
    await spam.queue.enqueue({
      ...envelopeOf(TENANT),
      jobType: "remediation",
      payload: { area: "allow-block", action: "create", type: "sender", value: "x@example.invalid", entryAction: "block" },
    } as JobEnvelope);
    await spam.queue.enqueue({
      ...envelopeOf(TENANT),
      jobType: "remediation",
      payload: { area: "filters", action: "edit", filterType: "anti-spam", policyName: "Default", settings: {} },
    } as JobEnvelope);

    expectCallPurposes(calls, TENANT, ["reader", "operator", "operator", "operator"]);
  });

  it("writes contacts/resources with operator; reads and previews with reader", async () => {
    const { run, calls, credentials } = harness(() => ({ items: [] }));
    const contacts = createContactsResourcesAdapters(run, credentials);

    await contacts.contacts.listContacts(TENANT, { cursor: null, limit: 20 } as never);
    await contacts.contactsCrud.createContact(
      TENANT,
      { displayName: "C", externalAddress: "c@example.invalid" } as never,
      true,
    );
    await contacts.contactsCrud.createContact(
      TENANT,
      { displayName: "C", externalAddress: "c@example.invalid" } as never,
      false,
    );
    await contacts.contactsImport.importContacts(TENANT, { csv: "", preview: false } as never);
    await contacts.contactTemplateDeploy.executeDeploy(
      { id: "tpl-1" } as never,
      [{ tenantId: TENANT, variables: {} }] as never,
      "admin",
    );
    await contacts.resourcesCrud.deleteResource(TENANT, "room", "r-1", false);

    expectCallPurposes(calls, TENANT, ["reader", "reader", "operator", "operator", "operator", "operator"]);
  });
});

describe("security and tenant writes (T-0940)", () => {
  it("deploys Defender and Safe Links policies with operator; reads and plans with reader", async () => {
    const { run, calls, credentials } = harness();
    const defender = createDefenderProviders(run, credentials);
    const purview = createPurviewProviders(run, credentials);

    await defender.status.getDefenderStatus(TENANT);
    await defender.deploy.planDeploy(TENANT, {
      policyAreas: [],
      targetScope: "all",
      overwrite: false,
      saveAsTemplate: false,
    } as never);
    await defender.deploy.executeDeploy(TENANT, {
      policyAreas: [],
      targetScope: "all",
      overwrite: false,
      saveAsTemplate: false,
    } as never);
    await purview.safelinks.listPolicies(TENANT, { cursor: null, limit: 20 } as never);
    await purview.safelinks.createPolicy(TENANT, { name: "P" } as never, true);
    await purview.safelinks.createPolicy(TENANT, { name: "P" } as never, false);

    expectCallPurposes(calls, TENANT, ["reader", "reader", "operator", "reader", "reader", "operator"]);
  });

  it("runs domain actions with operator; dry runs and reads with reader", async () => {
    const { run, calls, credentials } = harness();
    const domains = createDomainsProviders(run, credentials, {
      checks: {
        listLatestDomainChecks: async () => [],
        appendDomainCheck: async (input: unknown) => input as never,
        listDomainHistory: async () => [],
      } as never,
    });

    await domains.list.listDomains(TENANT, { cursor: null, limit: 20 } as never, []);
    await domains.actions.run(TENANT, {
      domain: "example.invalid",
      action: "verify",
      dryRun: true,
      confirmed: false,
      actor: "admin",
      reason: "test",
    } as never);
    await domains.actions.run(TENANT, {
      domain: "example.invalid",
      action: "verify",
      dryRun: false,
      confirmed: true,
      actor: "admin",
      reason: "test",
    } as never);

    expectCallPurposes(calls, TENANT, ["reader", "reader", "operator"]);
  });

  it("assigns licenses with operator and previews with reader", async () => {
    const { run, calls, credentials } = harness();
    const licenses = createLicenseChangeProvider(run, credentials);

    await licenses.plan(TENANT, "sku-1", ["u-1"]);
    await licenses.apply({
      tenantId: TENANT,
      skuId: "sku-1",
      action: "assign",
      userIds: ["u-1"],
      dryRun: true,
      confirmed: false,
      continueOnFailure: false,
      reason: "test",
      actor: "admin",
      correlationId: "corr",
    } as never);
    await licenses.apply({
      tenantId: TENANT,
      skuId: "sku-1",
      action: "assign",
      userIds: ["u-1"],
      dryRun: false,
      confirmed: true,
      continueOnFailure: false,
      reason: "test",
      actor: "admin",
      correlationId: "corr",
    } as never);

    expectCallPurposes(calls, TENANT, ["reader", "reader", "operator"]);
  });
});

describe("audit, incident, MFA and sharing writes (T-0940)", () => {
  it("manages webhooks with operator; lists with reader", async () => {
    const { run, calls, credentials } = harness(() => ({ subscriptions: [] }));
    const audit = createAuditProviders(run, credentials);

    await audit.webhooks.list(TENANT);
    await audit.webhooks.create(TENANT, { resource: "/users", notificationUrl: "https://example.invalid/hook" });
    await audit.webhooks.renew(TENANT, "sub-1");
    await audit.webhooks.recreate(TENANT, "sub-1");
    await audit.webhooks.remove(TENANT, "sub-1");
    await audit.webhooks.test(TENANT, "sub-1");

    expectCallPurposes(calls, TENANT, ["reader", "operator", "operator", "operator", "operator", "operator"]);
  });

  it("acts on incidents and alerts with operator; reads with reader", async () => {
    const { run, calls, credentials } = harness();
    const repo = {
      listIncidentNotes: async () => [],
      listAlertStateChanges: async () => [],
    } as never;
    const incidents = createIncidentProviders(run, credentials, repo);

    await incidents.incidents.listIncidents(TENANT, { cursor: null, limit: 20 });
    await incidents.actions.executeAction(TENANT, "i-1", "resolve", {
      value: null,
      comment: null,
      reason: "done",
    } as never);
    await incidents.alertActions.executeAction(TENANT, "a-1", "resolve", {
      value: null,
      comment: null,
      reason: "done",
    } as never);

    expectCallPurposes(calls, TENANT, ["reader", "operator", "operator"]);
  });

  it("resets MFA, issues TAPs, and acts with operator; reads and previews with reader", async () => {
    const { run, calls, credentials } = harness(() => ({ rows: [] }));
    const mfa = createMfaProviders(createEnvelopeWorker(run, credentials));

    await mfa.report.getMfaReport(TENANT, { cursor: null, limit: 20 } as never);
    await mfa.reset.resetMfa(TENANT, "u-1", { dryRun: false });
    await mfa.tap.createTap(TENANT, "u-1", { lifetimeMinutes: 60, oneTime: true, dryRun: false } as never);
    await mfa.actions.sendPush(TENANT, "u-1", { dryRun: false });
    await mfa.actions.setDefaultMethod(TENANT, "u-1", "push", { dryRun: true });

    expectCallPurposes(calls, TENANT, ["reader", "operator", "operator", "operator", "reader"]);
  });

  it("sets auth methods and campaigns through the flat worker with operator", async () => {
    const { run, calls, credentials } = harness();
    const call = createTenantWorker(run, credentials);

    await createAuthMethodsPolicyProvider(call).getPolicy(TENANT);
    await createAuthMethodsPolicyProvider(call).applyPolicy(TENANT, {}, { dryRun: false });
    await createRegistrationCampaignProvider(call).getCampaign(TENANT);
    await createRegistrationCampaignProvider(call).setCampaign(TENANT, {
      state: "enabled",
      snoozeDurationInDays: 0,
      includeTargets: [],
      excludeTargets: [],
    });

    expectCallPurposes(calls, TENANT, ["reader", "operator", "reader", "operator"]);
  });

  it("removes sharing links with operator; reports stay reader", async () => {
    const { run, calls, credentials } = harness();
    const sharing = createSharingProviders(run, credentials);

    await sharing.sharingReport.listLinks(TENANT, { cursor: null, limit: 20 } as never);
    await sharing.linkRemoval.removeLink(TENANT, { permissionId: "p-1", siteId: "s-1" } as never);

    expectCallPurposes(calls, TENANT, ["reader", "operator"]);
  });
});

describe("Graph Explorer writes (T-0940)", () => {
  it("signs a GET with reader and a write with operator", async () => {
    const { run, calls, credentials } = harness();
    const executor = createGraphExplorerWorkerExecutor(run, credentials);

    await executor(TENANT, { method: "GET", url: "https://graph.microsoft.com/v1.0/users" });
    await executor(TENANT, { method: "POST", url: "https://graph.microsoft.com/v1.0/users", body: {} });

    expectCallPurposes(calls, TENANT, ["reader", "operator"]);
  });

  it("refuses a Graph write when the operator credential is absent", async () => {
    const { run, calls, credentials } = harness(() => ({}), { operator: false });
    const executor = createGraphExplorerWorkerExecutor(run, credentials);

    await expect(
      executor(TENANT, { method: "PATCH", url: "https://graph.microsoft.com/v1.0/users/u-1", body: {} }),
    ).rejects.toMatchObject({ code: "tenant.operator_credential_missing", status: 409 });
    expect(calls).toHaveLength(0);
  });
});
