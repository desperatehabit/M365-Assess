// Application approval — consent request decisions (EPIC-040 SPEC.md §3.3, §4.2,
// §5, §6, §8; T-0786).
//
// The service holds pending consent requests and persisted decisions in memory.
// Approve/deny is a tenant write: it routes through the EPIC-006 write boundary
// (an injected port), persists a ConsentDecision row, and records an AuditEvent
// with before/after state. Deny requires a reason.

export const CONSENT_DECISION_APPROVE = "approve" as const;
export const CONSENT_DECISION_DENY = "deny" as const;
export const CONSENT_REQUEST_NOT_FOUND = "consent.request_not_found";
export const CONSENT_DECISION_INVALID = "consent.decision_invalid";
export const CONSENT_REASON_REQUIRED = "consent.reason_required";

export type ConsentDecisionValue = typeof CONSENT_DECISION_APPROVE | typeof CONSENT_DECISION_DENY;

export interface ConsentRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly appId: string;
  readonly appName: string;
  readonly requestedPermissions: readonly string[];
  readonly requestor: string;
  readonly status: "pending";
}

export interface ConsentDecision {
  readonly id: string;
  readonly tenantId: string;
  readonly appId: string;
  readonly decision: ConsentDecisionValue;
  readonly by: string;
  readonly at: string;
  readonly reason: string | null;
}

export interface ConsentAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  readonly actor: string;
}

export interface ConsentDecisionInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly decision: ConsentDecisionValue;
  readonly actor: string;
  readonly reason?: string;
}

export interface ConsentDecisionResult {
  readonly decision: ConsentDecision;
  readonly auditEvent: ConsentAuditEvent;
}

export class ConsentDecisionError extends Error {
  readonly code: string;
  readonly field?: string;

  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "ConsentDecisionError";
    this.code = code;
    this.field = field;
  }
}

export interface ConsentWriteInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly appId: string;
  readonly decision: ConsentDecisionValue;
  readonly reason: string | null;
}

export interface ConsentWriteResult {
  readonly success: boolean;
  readonly error?: string;
}

/** EPIC-006 write boundary: the tenant write is handed to the remediation contract. */
export interface ConsentWritePort {
  applyDecision(input: ConsentWriteInput): Promise<ConsentWriteResult>;
}

export interface ConsentAuditPort {
  record(event: Record<string, unknown>): Promise<void> | void;
}

export interface AppApprovalServiceOptions {
  readonly writePort: ConsentWritePort;
  readonly auditPort: ConsentAuditPort;
  readonly now?: () => Date;
  readonly requests?: readonly ConsentRequest[];
}

export interface AppApprovalService {
  list(tenantId: string): Promise<ConsentRequest[]>;
  decide(input: ConsentDecisionInput): Promise<ConsentDecisionResult>;
  listDecisions(tenantId: string): Promise<ConsentDecision[]>;
}

function validateDecision(input: ConsentDecisionInput): ConsentDecisionValue {
  if (input.decision !== CONSENT_DECISION_APPROVE && input.decision !== CONSENT_DECISION_DENY) {
    throw new ConsentDecisionError(
      CONSENT_DECISION_INVALID,
      "decision must be 'approve' or 'deny'",
      "decision",
    );
  }
  if (input.decision === CONSENT_DECISION_DENY) {
    const reason = input.reason?.trim() ?? "";
    if (reason.length === 0) {
      throw new ConsentDecisionError(
        CONSENT_REASON_REQUIRED,
        "reason is required when denying a consent request",
        "reason",
      );
    }
  }
  return input.decision;
}

export function createAppApprovalService(options: AppApprovalServiceOptions): AppApprovalService {
  const now = options.now ?? (() => new Date());
  const requests = new Map<string, ConsentRequest>();
  const decisions: ConsentDecision[] = [];

  for (const request of options.requests ?? []) {
    requests.set(request.id, { ...request });
  }

  async function list(tenantId: string): Promise<ConsentRequest[]> {
    return [...requests.values()].filter((r) => r.tenantId === tenantId);
  }

  async function decide(input: ConsentDecisionInput): Promise<ConsentDecisionResult> {
    const decision = validateDecision(input);
    const reason = decision === CONSENT_DECISION_DENY ? (input.reason?.trim() ?? "") : null;

    const request = requests.get(input.requestId);
    if (!request || request.tenantId !== input.tenantId) {
      throw new ConsentDecisionError(
        CONSENT_REQUEST_NOT_FOUND,
        `consent request ${input.requestId} not found`,
        "requestId",
      );
    }

    const writeResult = await options.writePort.applyDecision({
      tenantId: input.tenantId,
      requestId: input.requestId,
      appId: request.appId,
      decision,
      reason,
    });
    if (!writeResult.success) {
      throw new ConsentDecisionError(
        CONSENT_DECISION_INVALID,
        writeResult.error ?? "tenant write failed",
      );
    }

    const at = now().toISOString();
    const consentDecision: ConsentDecision = {
      id: globalThis.crypto.randomUUID(),
      tenantId: input.tenantId,
      appId: request.appId,
      decision,
      by: input.actor,
      at,
      reason,
    };
    decisions.push(consentDecision);

    const auditEvent: ConsentAuditEvent = {
      id: globalThis.crypto.randomUUID(),
      tenantId: input.tenantId,
      action: decision === CONSENT_DECISION_APPROVE ? "consent.approve" : "consent.deny",
      targetId: request.appId,
      targetName: request.appName,
      timestamp: at,
      before: { status: "pending", requestId: request.id },
      after: {
        status: decision === CONSENT_DECISION_APPROVE ? "approved" : "denied",
        requestId: request.id,
        decidedBy: input.actor,
        decidedAt: at,
        ...(reason !== null ? { reason } : {}),
      },
      actor: input.actor,
    };
    await options.auditPort.record({ ...auditEvent });

    requests.delete(request.id);

    return { decision: consentDecision, auditEvent };
  }

  async function listDecisions(tenantId: string): Promise<ConsentDecision[]> {
    return decisions.filter((d) => d.tenantId === tenantId);
  }

  return { list, decide, listDecisions };
}
