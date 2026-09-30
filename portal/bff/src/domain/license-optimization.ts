// Licence optimization classification (EPIC-033 SPEC.md §3.2, §4.2, §11.1; T-0643).
//
// The worker gathers raw per-user assignments, activity, assignment errors, and
// upcoming SKU expiries from Graph. This module is the pure classifier: an
// assignment is unused when the user has no activity inside the configurable
// inactivity window (default 30 days), assignment errors are grouped as
// overused, and upcoming SKU expiries are surfaced with their affected users.
// Everything here is advisory — nothing removes a licence (SPEC §9 risk of
// false positives).

export const DEFAULT_INACTIVITY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LicenseActivityUser {
  readonly userId: string;
  readonly userPrincipalName: string;
  readonly displayName: string;
  readonly lastActivityDate: string | null;
}

export interface LicenseAssignment extends LicenseActivityUser {
  readonly skuId: string;
  readonly skuPartNumber: string;
}

export interface LicenseAssignmentError extends LicenseActivityUser {
  readonly skuId: string;
  readonly skuPartNumber: string;
  readonly error: string;
}

export interface LicenseExpiration {
  readonly skuId: string;
  readonly skuPartNumber: string;
  readonly expirationDateTime: string;
}

/** The raw worker payload (Get-LicenseOptimization.ps1) to classify. */
export interface LicenseOptimizationInput {
  readonly tenantId?: string;
  readonly generatedAt?: string;
  readonly assignments?: readonly LicenseAssignment[];
  readonly assignmentErrors?: readonly LicenseAssignmentError[];
  readonly expirations?: readonly LicenseExpiration[];
}

export interface UnusedLicenseRow {
  readonly skuId: string;
  readonly skuPartNumber: string;
  readonly affectedUsers: readonly LicenseActivityUser[];
}

export interface OverusedLicenseRow {
  readonly skuId: string;
  readonly skuPartNumber: string;
  readonly error: string;
  readonly affectedUsers: readonly LicenseActivityUser[];
}

export interface ExpiringLicenseRow {
  readonly skuId: string;
  readonly skuPartNumber: string;
  readonly expirationDateTime: string;
  readonly daysRemaining: number;
  readonly affectedUsers: readonly LicenseActivityUser[];
}

export interface LicenseOptimizationResult {
  readonly tenantId: string;
  readonly generatedAt: string;
  readonly inactivityDays: number;
  /** Always true: the endpoint only advises, it never removes a licence. */
  readonly advisory: true;
  readonly unused: readonly UnusedLicenseRow[];
  readonly overused: readonly OverusedLicenseRow[];
  readonly expiring: readonly ExpiringLicenseRow[];
}

export interface ClassifyLicenseOptimizationOptions {
  readonly inactivityDays?: number;
  readonly now?: Date;
}

interface MutableRow {
  skuId: string;
  skuPartNumber: string;
  affectedUsers: LicenseActivityUser[];
}

interface MutableOverusedRow extends MutableRow {
  error: string;
}

function normalizeInactivityDays(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_INACTIVITY_DAYS;
  }
  return Math.floor(value);
}

function parseDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toAffectedUser(user: LicenseActivityUser): LicenseActivityUser {
  return {
    userId: user.userId,
    userPrincipalName: user.userPrincipalName,
    displayName: user.displayName,
    lastActivityDate: user.lastActivityDate ?? null,
  };
}

function bySkuPartNumber(
  a: { readonly skuPartNumber: string },
  b: { readonly skuPartNumber: string },
): number {
  return a.skuPartNumber.localeCompare(b.skuPartNumber);
}

function byUserPrincipalName(a: LicenseActivityUser, b: LicenseActivityUser): number {
  return a.userPrincipalName.localeCompare(b.userPrincipalName);
}

/**
 * Classifies a worker payload into the three advisory groups. `inactivityDays`
 * (default 30) is the window: an assignment is unused when the user's last
 * activity is absent or older than the window. `now` is injectable for tests.
 */
export function classifyLicenseOptimization(
  input: LicenseOptimizationInput,
  options: ClassifyLicenseOptimizationOptions = {},
): LicenseOptimizationResult {
  const inactivityDays = normalizeInactivityDays(options.inactivityDays);
  const now = options.now ?? new Date();
  const windowStart = now.getTime() - inactivityDays * DAY_MS;

  const assignmentsBySku = new Map<string, LicenseActivityUser[]>();
  for (const assignment of input.assignments ?? []) {
    const list = assignmentsBySku.get(assignment.skuId) ?? [];
    list.push(toAffectedUser(assignment));
    assignmentsBySku.set(assignment.skuId, list);
  }

  const unusedBySku = new Map<string, MutableRow>();
  for (const assignment of input.assignments ?? []) {
    const lastActivity = parseDate(assignment.lastActivityDate);
    const inactive = lastActivity === null || lastActivity.getTime() < windowStart;
    if (!inactive) continue;
    const row = unusedBySku.get(assignment.skuId) ?? {
      skuId: assignment.skuId,
      skuPartNumber: assignment.skuPartNumber,
      affectedUsers: [],
    };
    row.affectedUsers.push(toAffectedUser(assignment));
    unusedBySku.set(assignment.skuId, row);
  }
  const unused = [...unusedBySku.values()].map((row) => ({
    ...row,
    affectedUsers: [...row.affectedUsers].sort(byUserPrincipalName),
  }));
  unused.sort(bySkuPartNumber);

  const overusedByKey = new Map<string, MutableOverusedRow>();
  for (const error of input.assignmentErrors ?? []) {
    const key = `${error.skuId}\u0000${error.error}`;
    const row = overusedByKey.get(key) ?? {
      skuId: error.skuId,
      skuPartNumber: error.skuPartNumber,
      error: error.error,
      affectedUsers: [],
    };
    row.affectedUsers.push(toAffectedUser(error));
    overusedByKey.set(key, row);
  }
  const overused = [...overusedByKey.values()].map((row) => ({
    ...row,
    affectedUsers: [...row.affectedUsers].sort(byUserPrincipalName),
  }));
  overused.sort((a, b) => bySkuPartNumber(a, b) || a.error.localeCompare(b.error));

  const expiring: ExpiringLicenseRow[] = [];
  for (const expiration of input.expirations ?? []) {
    const expiry = parseDate(expiration.expirationDateTime);
    if (expiry === null) continue;
    const daysRemaining = Math.ceil((expiry.getTime() - now.getTime()) / DAY_MS);
    if (daysRemaining < 0) continue;
    expiring.push({
      skuId: expiration.skuId,
      skuPartNumber: expiration.skuPartNumber,
      expirationDateTime: expiration.expirationDateTime,
      daysRemaining,
      affectedUsers: [...(assignmentsBySku.get(expiration.skuId) ?? [])].sort(byUserPrincipalName),
    });
  }
  expiring.sort((a, b) => a.daysRemaining - b.daysRemaining || bySkuPartNumber(a, b));

  return {
    tenantId: input.tenantId ?? "",
    generatedAt: input.generatedAt ?? now.toISOString(),
    inactivityDays,
    advisory: true,
    unused,
    overused,
    expiring,
  };
}
