// Access audit writer (EPIC-038 SPEC §4.5, §3.4).
// Every authorization decision — allow or deny, whether it comes from the
// Test-PortalAccess path (T-0743) or the tenant-scope path (T-0746) — is
// recorded through this one writer so the audit trail has a single shape:
// actor type and id, the caller's roles, the permission checked, the tenant,
// the result, the client IP, and the request correlation id. Rows are
// append-only: the sink only ever inserts into audit_events and this module
// exposes no update or delete path. Export to SIEM is EPIC-041.

export type AccessAuditActorType = "user" | "apiClient" | "system";

export interface AccessAuditDecision {
  readonly actorType: AccessAuditActorType;
  readonly actorId: string | null;
  readonly roles: readonly string[];
  readonly permission: string;
  readonly tenantId: string | null;
  readonly allowed: boolean;
  readonly ip: string | null;
  readonly correlationId: string;
}

export type AccessAuditSink = (event: Record<string, unknown>) => Promise<void>;

export const ACCESS_AUDIT_ACTION = "access.check";

export const ACCESS_AUDIT_TARGET_TYPE = "permission";

// Which enforcement path produced the decision: the RBAC include/exclude
// resolution (T-0743) or the tenant-scope check (T-0746). A denied request is
// audited from both paths, so the two rows need a discriminator.
export type AccessAuditCheck = "rbac" | "scope";

export interface AccessAuditEvent {
  readonly actor: string | null;
  readonly actorType: AccessAuditActorType;
  readonly tenantId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly result: "success" | "failure";
  readonly source: "request";
  readonly correlationId: string;
  readonly after: {
    readonly roles: readonly string[];
    readonly ip: string | null;
    readonly allowed: boolean;
    readonly check: AccessAuditCheck;
  };
}

export function accessAuditEvent(decision: AccessAuditDecision, check: AccessAuditCheck): AccessAuditEvent {
  return {
    actor: decision.actorId,
    actorType: decision.actorType,
    tenantId: decision.tenantId,
    action: ACCESS_AUDIT_ACTION,
    targetType: ACCESS_AUDIT_TARGET_TYPE,
    targetId: decision.permission,
    result: decision.allowed ? "success" : "failure",
    source: "request",
    correlationId: decision.correlationId,
    after: {
      roles: [...decision.roles],
      ip: decision.ip,
      allowed: decision.allowed,
      check,
    },
  };
}

export async function recordAccessDecision(
  sink: AccessAuditSink,
  decision: AccessAuditDecision,
  check: AccessAuditCheck = "rbac",
): Promise<void> {
  await sink({ ...accessAuditEvent(decision, check) });
}
