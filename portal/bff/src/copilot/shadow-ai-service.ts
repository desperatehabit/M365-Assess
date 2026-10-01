// Shadow AI discovery domain service (EPIC-041 SPEC.md §3.3, §4, §5, §9; T-0807).
//
// Detects unsanctioned AI-tool usage. Detection prefers Defender for Cloud Apps
// (the SPEC §11 open question 3 resolution) and falls back to sign-in logs when
// Defender is unavailable for the tenant. The service is report-only: it reads
// detections and persists tenant-scoped findings for triage. There is
// deliberately no block / CA write path — blocking is a tenant write routed
// through EPIC-006 and requires explicit review (§9). Reads and persistence go
// through injected ports so the BFF stays free of Graph and SQL (ADR-0014); the
// route owns RBAC and audit.

// ─── Sources ──────────────────────────────────────────────────────────────────

export const SHADOW_AI_DEFENDER_SOURCE = "defender-cloud-apps";
export const SHADOW_AI_SIGNIN_SOURCE = "sign-in-logs";

export type ShadowAiSourceKind =
  | typeof SHADOW_AI_DEFENDER_SOURCE
  | typeof SHADOW_AI_SIGNIN_SOURCE;

export interface ShadowAiDetection {
  readonly tool: string;
  readonly user: string;
  readonly detectedAt: string;
}

// A source returns `null` when it is unavailable for the tenant (not licensed,
// not configured, or the query failed upstream), which triggers the fallback.
// An empty array means "available, nothing detected" and does not fall back.
export interface ShadowAiDetectionSource {
  readonly kind: ShadowAiSourceKind;
  listDetections(tenantId: string): Promise<readonly ShadowAiDetection[] | null>;
}

// ─── Findings model ───────────────────────────────────────────────────────────

export type ShadowAiFindingState = "open" | "acknowledged" | "dismissed";

export const SHADOW_AI_FINDING_STATES: readonly ShadowAiFindingState[] = Object.freeze([
  "open",
  "acknowledged",
  "dismissed",
]);

const FINDING_STATE_SET: ReadonlySet<string> = new Set(SHADOW_AI_FINDING_STATES);

export interface ShadowAiFinding {
  readonly id: string;
  readonly tenantId: string;
  readonly tool: string;
  readonly user: string;
  readonly detectedAt: string;
  readonly state: ShadowAiFindingState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ShadowAiFindingInput {
  readonly id: string;
  readonly tenantId: string;
  readonly tool: string;
  readonly user: string;
  readonly detectedAt: string;
  readonly state?: ShadowAiFindingState;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

// Portal-side persistence port. The store holds findings only; it has no tenant
// write path, which is what keeps discovery report-only (SPEC §9).
export interface ShadowAiFindingStore {
  saveFindings(findings: readonly ShadowAiFindingInput[]): Promise<readonly ShadowAiFinding[]>;
  listFindings(tenantId: string): Promise<readonly ShadowAiFinding[]>;
  updateFindingState(
    tenantId: string,
    findingId: string,
    state: ShadowAiFindingState,
  ): Promise<ShadowAiFinding | undefined>;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export const SHADOW_AI_TENANT_REQUIRED = "shadow-ai.tenant_required";
export const SHADOW_AI_SOURCES_UNAVAILABLE = "shadow-ai.sources_unavailable";
export const SHADOW_AI_INVALID_STATE = "shadow-ai.invalid_state";

export class ShadowAiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ShadowAiError";
    this.code = code;
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface ShadowAiServiceOptions {
  readonly defender: ShadowAiDetectionSource;
  readonly signInLogs: ShadowAiDetectionSource;
  readonly store: ShadowAiFindingStore;
  readonly now?: () => string;
  readonly idGenerator?: (tenantId: string, detection: ShadowAiDetection) => string;
}

export interface ShadowAiDiscoveryResult {
  readonly tenantId: string;
  readonly source: ShadowAiSourceKind;
  readonly usedFallback: boolean;
  /** Always false: discovery never blocks; blocking is an EPIC-006 tenant write. */
  readonly blocked: false;
  readonly findings: readonly ShadowAiFinding[];
}

// Deterministic id so re-running discovery upserts the same finding instead of
// duplicating it. The store's ON CONFLICT (id) only refreshes the timestamp,
// preserving any triage state set through setState.
function defaultFindingId(tenantId: string, detection: ShadowAiDetection): string {
  return ["shadow-ai", tenantId, detection.tool, detection.user, detection.detectedAt].join(":");
}

function requireTenantId(tenantId: string): string {
  const value = typeof tenantId === "string" ? tenantId.trim() : "";
  if (value.length === 0) {
    throw new ShadowAiError(SHADOW_AI_TENANT_REQUIRED, "tenantId is required");
  }
  return value;
}

export class ShadowAiService {
  private readonly options: ShadowAiServiceOptions;

  constructor(options: ShadowAiServiceOptions) {
    this.options = options;
  }

  // Reads detections (Defender first, sign-in logs fallback) and persists them
  // as tenant-scoped findings. Fails closed only when both sources are
  // unavailable; it never writes to the tenant.
  async discover(tenantId: string): Promise<ShadowAiDiscoveryResult> {
    const tenant = requireTenantId(tenantId);
    const primary = this.options.defender;
    const fallback = this.options.signInLogs;

    let source: ShadowAiSourceKind = primary.kind;
    let detections = await primary.listDetections(tenant);
    let usedFallback = false;
    if (detections === null) {
      usedFallback = true;
      source = fallback.kind;
      detections = await fallback.listDetections(tenant);
    }
    if (detections === null) {
      throw new ShadowAiError(
        SHADOW_AI_SOURCES_UNAVAILABLE,
        "neither Defender for Cloud Apps nor sign-in logs is available for this tenant",
      );
    }

    const instant = this.now();
    const generateId = this.options.idGenerator ?? defaultFindingId;
    const inputs: ShadowAiFindingInput[] = detections.map((detection) => ({
      id: generateId(tenant, detection),
      tenantId: tenant,
      tool: detection.tool,
      user: detection.user,
      detectedAt: detection.detectedAt,
      state: "open",
      createdAt: instant,
      updatedAt: instant,
    }));
    const findings =
      inputs.length === 0 ? [] : await this.options.store.saveFindings(inputs);
    return { tenantId: tenant, source, usedFallback, blocked: false, findings };
  }

  async list(tenantId: string): Promise<readonly ShadowAiFinding[]> {
    return this.options.store.listFindings(requireTenantId(tenantId));
  }

  async setState(
    tenantId: string,
    findingId: string,
    state: ShadowAiFindingState,
  ): Promise<ShadowAiFinding | undefined> {
    const tenant = requireTenantId(tenantId);
    if (!FINDING_STATE_SET.has(state)) {
      throw new ShadowAiError(
        SHADOW_AI_INVALID_STATE,
        `finding state must be one of: ${SHADOW_AI_FINDING_STATES.join(", ")}`,
      );
    }
    return this.options.store.updateFindingState(tenant, findingId, state);
  }

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString();
  }
}
