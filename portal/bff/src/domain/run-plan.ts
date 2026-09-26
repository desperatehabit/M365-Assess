// Run plan expansion and scoping (EPIC-003 SPEC.md §3.2, §4.1, §11.1, §11.4).
// Expands single/multi tenants and groups into a parent run with per-tenant child runs.
// Applies CLI default sections when omitted, validates caller RBAC scope (403 on out-of-scope),
// and prepares per-tenant job envelopes.

import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { JobEnvelope } from "@m365-assess/contracts";
import { buildRunEnvelope, runArtifactPath } from "./runs/run-lifecycle.js";
import type { RunStatus, RunTrigger } from "./runs/run-lifecycle.js";

// CLI default section set per SPEC.md §11.4
export const CLI_DEFAULT_SECTIONS = Object.freeze([
  "Tenant",
  "Identity",
  "Licensing",
  "Email",
  "Intune",
  "Security",
  "Collaboration",
  "PowerBI",
  "Hybrid",
] as const);

export type DefaultSection = (typeof CLI_DEFAULT_SECTIONS)[number];

export interface RunCreateOptions {
  readonly quickScan?: boolean;
  readonly skipPurview?: boolean;
  readonly redact?: boolean;
  readonly evidence?: boolean;
  readonly [key: string]: unknown;
}

export interface RunCreateRequest {
  readonly tenantId?: string;
  readonly tenantIds?: readonly string[];
  readonly tenants?: readonly string[];
  readonly groupIds?: readonly string[];
  readonly groups?: readonly string[];
  readonly trigger?: RunTrigger;
  readonly sections?: readonly string[];
  readonly options?: RunCreateOptions;
}

export interface GroupMemberResolver {
  resolveGroupMembers(groupId: string): Promise<readonly string[]>;
}

export interface PlanRunTarget {
  readonly tenantId: string;
  readonly runId: string;
  readonly jobId: string;
  readonly envelope: JobEnvelope;
  readonly artifactPath: string;
}

export interface RunPlan {
  readonly parentRunId: string;
  readonly trigger: RunTrigger;
  readonly sections: readonly string[];
  readonly options: RunCreateOptions;
  readonly targets: readonly PlanRunTarget[];
}

export async function expandTargetTenants(
  request: RunCreateRequest,
  resolver?: GroupMemberResolver,
): Promise<string[]> {
  const direct = new Set<string>();

  if (request.tenantId && request.tenantId.trim()) {
    direct.add(request.tenantId.trim());
  }
  if (request.tenantIds) {
    for (const t of request.tenantIds) {
      if (t && t.trim()) direct.add(t.trim());
    }
  }
  if (request.tenants) {
    for (const t of request.tenants) {
      if (t && t.trim()) direct.add(t.trim());
    }
  }

  const groupList = [
    ...(request.groupIds ?? []),
    ...(request.groups ?? []),
  ].map((g) => g.trim()).filter((g) => g.length > 0);

  if (groupList.length > 0 && resolver) {
    for (const groupId of groupList) {
      const members = await resolver.resolveGroupMembers(groupId);
      for (const m of members) {
        if (m && m.trim()) direct.add(m.trim());
      }
    }
  }

  const result = [...direct];
  if (result.length === 0) {
    throw new AppError("run.missing_tenants", "at least one tenant or group must be specified", 400);
  }
  return result;
}

export function assertTenantsInScope(caller: Caller, tenants: readonly string[]): void {
  for (const tenantId of tenants) {
    requireTenantInScope(caller, tenantId);
  }
}

export function resolveSections(requested?: readonly string[]): string[] {
  if (requested && requested.length > 0) {
    return [...requested];
  }
  return [...CLI_DEFAULT_SECTIONS];
}

export interface BuildRunPlanOptions {
  readonly request: RunCreateRequest;
  readonly caller: Caller;
  readonly groupResolver?: GroupMemberResolver;
  readonly idGenerator?: () => { runId: string; jobId: string; requestId: string };
  readonly correlationId?: string;
  readonly now?: () => string;
}

export async function buildRunPlan(options: BuildRunPlanOptions): Promise<RunPlan> {
  const tenants = await expandTargetTenants(options.request, options.groupResolver);
  assertTenantsInScope(options.caller, tenants);

  const sections = resolveSections(options.request.sections);
  const trigger: RunTrigger = options.request.trigger ?? "manual";
  const runOptions: RunCreateOptions = options.request.options ?? {};
  const newIds = options.idGenerator ?? (() => ({
    runId: randomUUID(),
    jobId: randomUUID(),
    requestId: randomUUID(),
  }));
  const instant = options.now?.() ?? new Date().toISOString();
  const correlationId = options.correlationId ?? randomUUID();

  const parentIds = newIds();
  const parentRunId = parentIds.runId;

  const targets: PlanRunTarget[] = [];
  for (const tenantId of tenants) {
    const childIds = newIds();
    const envelope = buildRunEnvelope({
      jobId: childIds.jobId,
      runId: childIds.runId,
      requestId: childIds.requestId,
      correlationId,
      tenantId,
      sections,
      createdAt: instant,
    });
    targets.push({
      tenantId,
      runId: childIds.runId,
      jobId: childIds.jobId,
      envelope,
      artifactPath: runArtifactPath(tenantId, childIds.runId),
    });
  }

  return {
    parentRunId,
    trigger,
    sections,
    options: runOptions,
    targets,
  };
}
