// Credential expiry derivation (03-database.md §4, EPIC-002 SPEC.md §4.5).
// `expiring` at ≤30 days to expiry feeds the EPIC-029 alerts; the tenants list
// badge (T-0030) renders this state. A row without `expiresOn` (for example a
// thumbprint credential) carries no expiry to track, so it reads `valid`.
export type CredentialState = "valid" | "expiring" | "expired" | "missing";

export const CREDENTIAL_EXPIRY_WARNING_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExpirableCredential {
  readonly expiresOn: string | null | undefined;
}

function toInstant(value: string): number {
  const instant = new Date(value).getTime();
  if (Number.isNaN(instant)) {
    throw new Error(`credential expiresOn '${value}' is not a valid date-time`);
  }
  return instant;
}

export function deriveCredentialState(
  credential: ExpirableCredential | null | undefined,
  now: Date | string = new Date(),
): CredentialState {
  if (credential === null || credential === undefined) {
    return "missing";
  }
  if (credential.expiresOn === null || credential.expiresOn === undefined) {
    return "valid";
  }
  const nowMs = now instanceof Date ? now.getTime() : toInstant(now);
  const remainingMs = toInstant(credential.expiresOn) - nowMs;
  if (remainingMs <= 0) {
    return "expired";
  }
  if (remainingMs <= CREDENTIAL_EXPIRY_WARNING_DAYS * DAY_MS) {
    return "expiring";
  }
  return "valid";
}
