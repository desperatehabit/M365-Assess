// Credential expiry derivation and scheduled scan (03-database.md §4, EPIC-002 SPEC.md §4.5, T-0874).
// `expiring` at ≤30 days to expiry feeds the EPIC-029 alerts; the tenants list
// badge (T-0030) renders this state. A row without `expiresOn` (for example a
// thumbprint credential) carries no expiry to track, so it reads `valid`.
//
// Note: `tenant_credentials` (`Repository` / `SqliteRepository`) does not store a
// persisted expiry-state column or expose a state-setter; credential state is
// derived on read via `deriveCredentialState`, and `scanCredentialExpiry` raises
// deduplicated EPIC-029 alert events for expiring/expired credentials.
import type {
  AlertEventInsert,
  AlertEventQuery,
  AlertEventState,
  AlertRuleSeverity,
} from "@m365-assess/db";

export type CredentialState = "valid" | "expiring" | "expired" | "missing";

export const CREDENTIAL_EXPIRY_WARNING_DAYS = 30;
export const CREDENTIAL_EXPIRY_ALERT_RULE_ID = "credential-expiry-approaching";

const DAY_MS = 24 * 60 * 60 * 1000;
const ALERT_LIST_PAGE_SIZE = 100;

export interface ExpirableCredential {
  readonly expiresOn: string | null | undefined;
}

export interface CredentialExpiryDetail {
  readonly state: CredentialState;
  readonly expiresAt: string | null;
  readonly daysRemaining: number | null;
}

function toInstant(value: string): number {
  const instant = new Date(value).getTime();
  if (Number.isNaN(instant)) {
    throw new Error(`credential expiresOn '${value}' is not a valid date-time`);
  }
  return instant;
}

export function deriveCredentialExpiryDetail(
  credential: ExpirableCredential | null | undefined,
  now: Date | string = new Date(),
): CredentialExpiryDetail {
  if (credential === null || credential === undefined) {
    return { state: "missing", expiresAt: null, daysRemaining: null };
  }
  if (credential.expiresOn === null || credential.expiresOn === undefined) {
    return { state: "valid", expiresAt: null, daysRemaining: null };
  }
  const nowMs = now instanceof Date ? now.getTime() : toInstant(now);
  const expiresMs = toInstant(credential.expiresOn);
  const remainingMs = expiresMs - nowMs;
  const expiresAt = new Date(expiresMs).toISOString();
  const daysRemaining =
    remainingMs >= 0 ? Math.ceil(remainingMs / DAY_MS) : Math.floor(remainingMs / DAY_MS);

  if (remainingMs <= 0) {
    return { state: "expired", expiresAt, daysRemaining };
  }
  if (remainingMs <= CREDENTIAL_EXPIRY_WARNING_DAYS * DAY_MS) {
    return { state: "expiring", expiresAt, daysRemaining };
  }
  return { state: "valid", expiresAt, daysRemaining };
}

export function deriveCredentialState(
  credential: ExpirableCredential | null | undefined,
  now: Date | string = new Date(),
): CredentialState {
  return deriveCredentialExpiryDetail(credential, now).state;
}

export interface CredentialExpiryTenant {
  readonly id: string;
  readonly displayName?: string | null;
  readonly excluded?: boolean;
  readonly status?: string;
  readonly deletedAt?: string | null;
}

export interface CredentialExpiryTenantSource {
  listTenants(): Promise<readonly CredentialExpiryTenant[]>;
}

export interface CredentialExpiryCredential extends ExpirableCredential {
  readonly authMethod?: string | null;
}

export interface CredentialExpiryCredentialSource {
  getTenantCredential(tenantId: string): Promise<CredentialExpiryCredential | undefined>;
}

export interface CredentialExpiryAlertEvent {
  readonly id: string;
  readonly ruleId: string;
  readonly tenantId: string;
  readonly firedAt: string;
  readonly severity: AlertRuleSeverity;
  readonly payload: Record<string, unknown> | null;
  readonly state: AlertEventState;
  readonly snoozeUntil: string | null;
  readonly deletedAt?: string | null;
}

export interface CredentialExpiryAlertPage {
  readonly items: readonly CredentialExpiryAlertEvent[];
  readonly nextCursor?: string | null;
}

export interface CredentialExpiryAlertingPort {
  listEvents(query: AlertEventQuery): Promise<CredentialExpiryAlertPage>;
  createEvent(input: AlertEventInsert): Promise<CredentialExpiryAlertEvent>;
}

export type CredentialExpiryNow = Date | string | (() => Date | string);

export interface CredentialExpiryScanDeps {
  readonly tenants: CredentialExpiryTenantSource;
  readonly credentials: CredentialExpiryCredentialSource;
  readonly alerting: CredentialExpiryAlertingPort;
  readonly now?: CredentialExpiryNow;
}

export interface CredentialExpiryScanResult {
  readonly scannedCount: number;
  readonly expiringCount: number;
  readonly expiredCount: number;
  readonly alertsRaised: number;
}

function resolveNow(now?: CredentialExpiryNow): Date {
  if (now === undefined) return new Date();
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date ? value : new Date(toInstant(value));
}

function isExcludedTenant(tenant: CredentialExpiryTenant): boolean {
  return (
    tenant.excluded === true ||
    tenant.status === "excluded" ||
    (tenant.deletedAt !== undefined && tenant.deletedAt !== null)
  );
}

function readEventCredentialState(event: CredentialExpiryAlertEvent): unknown {
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const detail = payload["detail"];
  if (detail !== null && typeof detail === "object" && !Array.isArray(detail)) {
    const detailState = (detail as Record<string, unknown>)["state"];
    if (detailState !== undefined) return detailState;
  }
  return payload["state"];
}

async function hasActiveAlertForState(
  alerting: CredentialExpiryAlertingPort,
  tenantId: string,
  state: "expiring" | "expired",
): Promise<boolean> {
  let cursor: string | null = null;
  do {
    const page = await alerting.listEvents({
      tenantId,
      ruleId: CREDENTIAL_EXPIRY_ALERT_RULE_ID,
      cursor,
      limit: ALERT_LIST_PAGE_SIZE,
    });
    for (const event of page.items) {
      if (event.deletedAt !== undefined && event.deletedAt !== null) continue;
      if (event.tenantId !== tenantId) continue;
      if (event.ruleId !== CREDENTIAL_EXPIRY_ALERT_RULE_ID) continue;
      if (event.state === "resolved") continue;
      if (readEventCredentialState(event) === state) {
        return true;
      }
    }
    cursor = page.nextCursor ?? null;
  } while (cursor !== null);
  return false;
}

function buildAlertTitle(
  tenant: CredentialExpiryTenant,
  derived: CredentialExpiryDetail,
): string {
  const tenantLabel = tenant.displayName?.trim() || tenant.id;
  if (derived.state === "expired") {
    return `Tenant credential expired for ${tenantLabel}`;
  }
  const days = derived.daysRemaining ?? 0;
  const unit = days === 1 ? "day" : "days";
  return `Tenant credential expiring in ${days} ${unit} for ${tenantLabel}`;
}

/**
 * Scans all non-excluded tenants' credentials against `now` and raises
 * deduplicated EPIC-029 alert events (`credential-expiry-approaching`) when a
 * credential is `expiring` (<=30 days) or `expired`.
 */
export async function scanCredentialExpiry(
  deps: CredentialExpiryScanDeps,
  signal?: AbortSignal,
): Promise<CredentialExpiryScanResult> {
  const at = resolveNow(deps.now);
  const firedAt = at.toISOString();
  const tenants = await deps.tenants.listTenants();

  let scannedCount = 0;
  let expiringCount = 0;
  let expiredCount = 0;
  let alertsRaised = 0;

  for (const tenant of tenants) {
    if (signal?.aborted) break;
    if (isExcludedTenant(tenant)) continue;

    scannedCount += 1;
    const cred = await deps.credentials.getTenantCredential(tenant.id);
    const derived = deriveCredentialExpiryDetail(cred, at);
    if (
      cred === undefined ||
      cred === null ||
      (derived.state !== "expiring" && derived.state !== "expired")
    ) {
      continue;
    }

    if (derived.state === "expiring") {
      expiringCount += 1;
    } else {
      expiredCount += 1;
    }

    if (await hasActiveAlertForState(deps.alerting, tenant.id, derived.state)) {
      continue;
    }

    const severity: AlertRuleSeverity = derived.state === "expired" ? "High" : "Medium";
    await deps.alerting.createEvent({
      ruleId: CREDENTIAL_EXPIRY_ALERT_RULE_ID,
      tenantId: tenant.id,
      firedAt,
      severity,
      state: "open",
      payload: {
        title: buildAlertTitle(tenant, derived),
        detail: {
          state: derived.state,
          expiresAt: derived.expiresAt,
          daysRemaining: derived.daysRemaining,
          authMethod: cred.authMethod ?? null,
        },
      },
    });
    alertsRaised += 1;
  }

  return {
    scannedCount,
    expiringCount,
    expiredCount,
    alertsRaised,
  };
}
