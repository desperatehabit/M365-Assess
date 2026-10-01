// DNS change detection for scheduled domain analysis (EPIC-034 SPEC.md §3.4,
// §4.3; T-0667). A scheduled run persists one DomainCheck per verified domain
// (T-0661); this module diffs the new records against the previous check and
// classifies the MX/SPF/DKIM/DMARC changes. The change event it produces is the
// input an EPIC-029 rule consumes — this module raises no notification itself.
//
// Pure and side-effect free. Record order is not a change (MX and DKIM are
// sets), object key order is not a change, and a first run with no prior check
// is not a change.

export type DnsChangeFamily = "MX" | "SPF" | "DKIM" | "DMARC";

export const DNS_CHANGE_FAMILIES: readonly DnsChangeFamily[] = Object.freeze([
  "MX",
  "SPF",
  "DKIM",
  "DMARC",
]);

export type DnsChangeKind = "added" | "removed" | "changed";

export interface DnsChangeEvent {
  readonly family: DnsChangeFamily;
  readonly kind: DnsChangeKind;
  readonly before: unknown;
  readonly after: unknown;
  readonly summary: string;
}

export interface DnsChangeSet {
  readonly changed: boolean;
  readonly events: readonly DnsChangeEvent[];
}

export type DnsRecordSet = Record<string, unknown> | null | undefined;

// The T-0664 analyser keys the resolved payload by record family. The canonical
// keys are lowercase; aliases tolerate the shapes other DNS surfaces emit.
const FAMILY_KEYS: Record<DnsChangeFamily, readonly string[]> = {
  MX: ["mx", "mxrecords", "mx_records"],
  SPF: ["spf", "spfrecord", "spf_records"],
  DKIM: ["dkim", "dkimrecords", "selectors"],
  DMARC: ["dmarc", "dmarcrecord", "dmarc_records"],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Order-independent canonical form: arrays sorted, object keys sorted, strings trimmed. */
function canonical(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => normalize(item));
    items.sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
    return items;
  }
  if (isPlainObject(value)) {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalize(value[key]);
    }
    return normalized;
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return value;
}

/** A family that resolves to nothing (absent, empty, or null) is treated as no record. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

interface FamilyValue {
  readonly present: boolean;
  readonly value: unknown;
}

function lookupFamily(records: DnsRecordSet, family: DnsChangeFamily): FamilyValue {
  if (records === null || records === undefined) {
    return { present: false, value: undefined };
  }
  const byLowerKey = new Map<string, unknown>();
  for (const [key, value] of Object.entries(records)) {
    byLowerKey.set(key.toLowerCase(), value);
  }
  for (const key of FAMILY_KEYS[family]) {
    const value = byLowerKey.get(key);
    if (value !== undefined && !isEmpty(value)) {
      return { present: true, value };
    }
  }
  return { present: false, value: undefined };
}

function event(
  family: DnsChangeFamily,
  kind: DnsChangeKind,
  before: unknown,
  after: unknown,
): DnsChangeEvent {
  return { family, kind, before, after, summary: `${family} ${kind}` };
}

/**
 * Diffs two record sets and classifies the MX/SPF/DKIM/DMARC changes. Returns an
 * empty set when nothing changed or when there is no prior check to compare
 * against (a first scheduled run establishes the baseline, it does not alert).
 */
export function detectDnsChanges(priorRecords: DnsRecordSet, currentRecords: DnsRecordSet): DnsChangeSet {
  if (priorRecords === null || priorRecords === undefined) {
    return { changed: false, events: [] };
  }

  const events: DnsChangeEvent[] = [];
  for (const family of DNS_CHANGE_FAMILIES) {
    const prior = lookupFamily(priorRecords, family);
    const current = lookupFamily(currentRecords, family);
    if (!prior.present && !current.present) {
      continue;
    }
    if (!prior.present && current.present) {
      events.push(event(family, "added", undefined, current.value));
      continue;
    }
    if (prior.present && !current.present) {
      events.push(event(family, "removed", prior.value, undefined));
      continue;
    }
    if (canonical(prior.value) !== canonical(current.value)) {
      events.push(event(family, "changed", prior.value, current.value));
    }
  }

  return { changed: events.length > 0, events };
}
