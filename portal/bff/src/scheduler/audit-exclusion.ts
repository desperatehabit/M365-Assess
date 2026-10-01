// Audit exclusion-window guard (EPIC-032 SPEC.md §3.6, §4.4, §11.4; T-0626).
//
// Resolved §11.4 makes exclusion windows portal-only: they suppress portal
// scheduled searches only and make no Microsoft-side changes. The T-0623
// scheduled search run consults this helper before dispatching — a run whose
// fire instant falls inside an active window is skipped, and the matching
// window is returned so the skip can be recorded against it. Windows
// auto-expire by `endsAt`: an instant at or after `endsAt` is outside the
// window. The window store is an injected seam, so this module stays free of
// SQL.
import type { AuditExclusionWindow } from "@m365-assess/db";

// Structural seam over the T-0621 AuditRepository window surface. The real
// repository satisfies this shape; depending on the seam keeps SQL out of the
// scheduler.
export interface AuditExclusionWindowStore {
  listAuditExclusionWindows(tenantId: string): Promise<AuditExclusionWindow[]>;
}

function toEpochMs(instant: string | Date): number {
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid instant: ${String(instant)}`);
  }
  return ms;
}

function windowContains(window: AuditExclusionWindow, ms: number): boolean {
  if (window.deletedAt !== null) {
    return false;
  }
  const startsAt = Date.parse(window.startsAt);
  const endsAt = Date.parse(window.endsAt);
  if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) {
    return false;
  }
  return ms >= startsAt && ms < endsAt;
}

/**
 * The active window containing `instant`, if any. A window is active from
 * `startsAt` (inclusive) until `endsAt` (exclusive), so it auto-expires at
 * `endsAt` and an expired window no longer suppresses.
 */
export async function findActiveAuditExclusionWindow(
  store: AuditExclusionWindowStore,
  tenantId: string,
  instant: string | Date,
): Promise<AuditExclusionWindow | undefined> {
  const ms = toEpochMs(instant);
  const windows = await store.listAuditExclusionWindows(tenantId);
  return windows.find((window) => windowContains(window, ms));
}

/** True when a scheduled search firing at `instant` must be skipped. */
export async function isAuditSearchSuppressed(
  store: AuditExclusionWindowStore,
  tenantId: string,
  instant: string | Date,
): Promise<boolean> {
  return (await findActiveAuditExclusionWindow(store, tenantId, instant)) !== undefined;
}
