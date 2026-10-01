// Domain Analyser panel (EPIC-034 SPEC.md §3.2; T-0669).
// Renders the six DNS record families (MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT)
// from a T-0665 DomainCheck. Each family carries a `.status-badge` and a
// plain-language explanation; the panel reuses the report's `.dns-*` classes
// for visual continuity and report theme tokens only (zero colour literals).
//
// The analyser worker (T-0664) emits `records` keyed by family and a per-family
// `health` map. Records may be a string, a list, or an object carrying the
// record text; the helpers below mirror the defensive reads the
// Get-DnsRecommendations worker uses so a malformed payload degrades to
// "unknown" rather than throwing.

import React, { type CSSProperties, type ReactElement } from "react";

export type DnsFamilyId = "mx" | "spf" | "dkim" | "dmarc" | "mtaSts" | "tlsRpt";
export type DnsFamilyStatus = "pass" | "warn" | "fail" | "info";

export interface DnsFamilyDetail {
  readonly label: string;
  readonly value: string;
}

export interface DnsFamilyView {
  readonly id: DnsFamilyId;
  readonly title: string;
  readonly status: DnsFamilyStatus;
  readonly explanation: string;
  readonly details: readonly DnsFamilyDetail[];
}

export interface DnsPanelProps {
  readonly domain?: string;
  readonly records?: Record<string, unknown>;
  readonly health?: Record<string, unknown>;
  readonly loading?: boolean;
  readonly error?: string | null;
}

export const DNS_FAMILY_ORDER: readonly DnsFamilyId[] = [
  "mx",
  "spf",
  "dkim",
  "dmarc",
  "mtaSts",
  "tlsRpt",
];

export const DNS_FAMILY_TITLES: Readonly<Record<DnsFamilyId, string>> = {
  mx: "MX",
  spf: "SPF",
  dkim: "DKIM",
  dmarc: "DMARC",
  mtaSts: "MTA-STS",
  tlsRpt: "TLS-RPT",
};

const STATUS_LABELS: Readonly<Record<DnsFamilyStatus, string>> = {
  pass: "Pass",
  warn: "Warning",
  fail: "Fail",
  info: "Info",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstDefined(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function recordParts(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => recordParts(item));
  const object = asRecord(value);
  if (object) {
    const nested = firstDefined(object, [
      "record",
      "text",
      "value",
      "strings",
      "records",
      "NameExchange",
    ]);
    if (nested !== undefined) return recordParts(nested);
  }
  return [];
}

export function dnsRecordText(value: unknown): string {
  return recordParts(value).join(" ");
}

export function dnsRecordPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => dnsRecordPresent(item));
  const object = asRecord(value);
  if (object) {
    for (const key of ["present", "published", "exists"]) {
      if (typeof object[key] === "boolean") return object[key] as boolean;
    }
    const nested = firstDefined(object, ["record", "text", "value", "strings", "records"]);
    if (nested !== undefined) return dnsRecordPresent(nested);
  }
  return false;
}

export function countSpfLookups(record: string): number {
  let count = 0;
  for (const term of record.split(/\s+/)) {
    if (/^(include:|exists:|redirect=)/i.test(term)) count += 1;
    else if (/^(a|mx|ptr)(:|$)/i.test(term)) count += 1;
  }
  return count;
}

function normalizeStatus(value: unknown): DnsFamilyStatus | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "pass":
    case "healthy":
    case "ok":
      return "pass";
    case "warn":
    case "warning":
    case "degraded":
      return "warn";
    case "fail":
    case "unhealthy":
    case "error":
      return "fail";
    case "info":
    case "review":
    case "unknown":
      return "info";
    default:
      return null;
  }
}

export function dnsHealthStatus(
  health: Record<string, unknown> | undefined,
  id: DnsFamilyId,
): DnsFamilyStatus | null {
  if (!health) return null;
  const families = asRecord(health["families"]);
  const value = health[id] ?? families?.[id];
  const direct = normalizeStatus(value);
  if (direct) return direct;
  const object = asRecord(value);
  if (object) {
    return normalizeStatus(firstDefined(object, ["status", "health"]));
  }
  return null;
}

function mxProvider(records: readonly string[]): string {
  if (records.length === 0) return "Not published";
  const joined = records.join(" ").toLowerCase();
  if (joined.includes("mail.protection.outlook.com")) return "Microsoft 365 / Exchange Online";
  if (joined.includes("google.com") || joined.includes("googlemail.com")) return "Google Workspace";
  if (joined.includes("protection.outlook.com")) return "Microsoft 365";
  return "Other / self-hosted";
}

function spfPolicy(record: string): string {
  if (/-all\b/i.test(record)) return "-all (hard fail)";
  if (/~all\b/i.test(record)) return "~all (soft fail)";
  if (/\?all\b/i.test(record)) return "?all (neutral)";
  if (/\+all\b/i.test(record)) return "+all (permissive)";
  return "no all mechanism";
}

function dmarcPolicy(record: string): string {
  const match = record.match(/\bp\s*=\s*(none|quarantine|reject)/i);
  return match ? match[1]!.toLowerCase() : "none";
}

function dmarcAlignment(record: string, tag: string): string {
  const match = record.match(new RegExp(`\\b${tag}\\s*=\\s*([sr])\\b`, "i"));
  if (!match) return "relaxed (default)";
  return match[1]!.toLowerCase() === "s" ? "strict" : "relaxed";
}

function dmarcTag(record: string, tag: string): string {
  const match = record.match(new RegExp(`\\b${tag}\\s*=\\s*([^;]+)`, "i"));
  return match ? match[1]!.trim() : "not set";
}

function mtaStsPolicy(value: unknown): string {
  const object = asRecord(value);
  if (object) {
    const mode = firstDefined(object, ["mode", "policy"]);
    if (typeof mode === "string" && mode.trim().length > 0) return mode.trim();
  }
  const record = dnsRecordText(value);
  const match = record.match(/\bmode\s*[:=]\s*([a-z]+)/i);
  return match ? match[1]!.toLowerCase() : "published";
}

export function buildDnsFamilies(
  records: Record<string, unknown> | undefined,
  health: Record<string, unknown> | undefined,
): DnsFamilyView[] {
  const source = records ?? {};

  const mxValue = source["mx"];
  const mxRecords = recordParts(mxValue);
  const mxPresent = dnsRecordPresent(mxValue);
  const mxStatus =
    dnsHealthStatus(health, "mx") ?? (mxPresent ? "pass" : "fail");

  const spfValue = source["spf"];
  const spfRecord = dnsRecordText(spfValue);
  const spfObject = asRecord(spfValue);
  const spfLookupsRaw = spfObject ? firstDefined(spfObject, ["lookupCount", "lookups"]) : undefined;
  const spfLookups =
    typeof spfLookupsRaw === "number" ? spfLookupsRaw : countSpfLookups(spfRecord);
  const spfPresent = dnsRecordPresent(spfValue) || spfRecord.length > 0;
  const spfPolicyValue = spfPolicy(spfRecord);
  const spfStatus =
    dnsHealthStatus(health, "spf") ??
    (!spfPresent ? "fail" : spfLookups > 10 ? "fail" : /-all\b/i.test(spfRecord) ? "pass" : "warn");

  const dkimValue = source["dkim"];
  const dkimObject = asRecord(dkimValue);
  const dkimSelectors = new Set<string>();
  if (dkimObject) {
    const list = dkimObject["selectors"];
    if (Array.isArray(list)) {
      for (const selector of list) {
        if (typeof selector === "string" && selector.trim()) dkimSelectors.add(selector.trim());
      }
    }
    for (const name of ["selector1", "selector2"]) {
      const value = dkimObject[name];
      if (value === true || (typeof value === "string" && value.trim())) dkimSelectors.add(name);
    }
  } else if (typeof dkimValue === "string" && dkimValue.trim()) {
    dkimSelectors.add(dkimValue.trim());
  }
  const dkimEnabled = dkimObject ? dkimObject["enabled"] : undefined;
  const dkimStatus =
    dnsHealthStatus(health, "dkim") ??
    (dkimSelectors.size === 0 ? "fail" : dkimEnabled === false ? "warn" : "pass");

  const dmarcValue = source["dmarc"];
  const dmarcRecord = dnsRecordText(dmarcValue);
  const dmarcPresent = dnsRecordPresent(dmarcValue) || dmarcRecord.length > 0;
  const dmarcPolicyValue = dmarcPolicy(dmarcRecord);
  const dmarcStatus =
    dnsHealthStatus(health, "dmarc") ??
    (!dmarcPresent
      ? "fail"
      : dmarcPolicyValue === "none"
        ? "fail"
        : dmarcPolicyValue === "quarantine"
          ? "warn"
          : "pass");

  const mtaStsValue = source["mtaSts"];
  const mtaStsPresent = dnsRecordPresent(mtaStsValue) || dnsRecordText(mtaStsValue).length > 0;
  const mtaStsStatus = dnsHealthStatus(health, "mtaSts") ?? (mtaStsPresent ? "pass" : "warn");

  const tlsRptValue = source["tlsRpt"];
  const tlsRptPresent = dnsRecordPresent(tlsRptValue) || dnsRecordText(tlsRptValue).length > 0;
  const tlsRptStatus = dnsHealthStatus(health, "tlsRpt") ?? (tlsRptPresent ? "pass" : "warn");

  return [
    {
      id: "mx",
      title: DNS_FAMILY_TITLES.mx,
      status: mxStatus,
      explanation: mxPresent
        ? `Mail for this domain is delivered to ${mxProvider(mxRecords)}.`
        : "No MX record is published, so this domain cannot receive mail.",
      details: [
        { label: "Records", value: mxRecords.join(", ") || "Not published" },
        { label: "Provider", value: mxProvider(mxRecords) },
      ],
    },
    {
      id: "spf",
      title: DNS_FAMILY_TITLES.spf,
      status: spfStatus,
      explanation: !spfPresent
        ? "No SPF record is published, so receivers cannot verify which servers may send for the domain."
        : spfLookups > 10
          ? `SPF uses ${spfLookups} DNS lookups, over the 10-lookup limit, so receivers may treat it as a permanent error.`
          : /-all\b/i.test(spfRecord)
            ? "SPF ends in -all, so unauthorised senders are hard-failed."
            : "SPF does not end in -all, so unauthorised senders are only soft-failed or accepted.",
      details: [
        { label: "Record", value: spfRecord || "Not published" },
        { label: "Lookups", value: String(spfLookups) },
        { label: "Policy", value: spfPolicyValue },
      ],
    },
    {
      id: "dkim",
      title: DNS_FAMILY_TITLES.dkim,
      status: dkimStatus,
      explanation:
        dkimSelectors.size === 0
          ? "No DKIM selectors are published, so outbound mail is not cryptographically signed."
          : dkimEnabled === false
            ? "DKIM selectors are published but signing is not enabled in Exchange Online."
            : "DKIM selectors are published and signing is enabled, so outbound mail is signed.",
      details: [
        {
          label: "selector1",
          value: dkimSelectors.has("selector1") ? "Present" : "Not published",
        },
        {
          label: "selector2",
          value: dkimSelectors.has("selector2") ? "Present" : "Not published",
        },
        {
          label: "Enabled",
          value: dkimEnabled === false ? "No" : dkimSelectors.size > 0 ? "Yes" : "No",
        },
      ],
    },
    {
      id: "dmarc",
      title: DNS_FAMILY_TITLES.dmarc,
      status: dmarcStatus,
      explanation: !dmarcPresent
        ? "No DMARC record is published, so receivers cannot act on mail that fails SPF or DKIM."
        : dmarcPolicyValue === "none"
          ? "DMARC policy is none, so failing mail is only monitored and still delivered."
          : dmarcPolicyValue === "quarantine"
            ? "DMARC policy is quarantine; advance to reject once reports show no legitimate mail failing."
            : "DMARC policy is reject, so failing mail is blocked.",
      details: [
        { label: "Record", value: dmarcRecord || "Not published" },
        { label: "Policy", value: dmarcPolicyValue },
        { label: "rua", value: dmarcTag(dmarcRecord, "rua") },
        { label: "ruf", value: dmarcTag(dmarcRecord, "ruf") },
        {
          label: "Alignment",
          value: `DKIM ${dmarcAlignment(dmarcRecord, "adkim")}, SPF ${dmarcAlignment(dmarcRecord, "aspf")}`,
        },
      ],
    },
    {
      id: "mtaSts",
      title: DNS_FAMILY_TITLES.mtaSts,
      status: mtaStsStatus,
      explanation: mtaStsPresent
        ? "MTA-STS is published, so transport security can be enforced."
        : "MTA-STS is not published, so transport security cannot be enforced.",
      details: [
        { label: "Record", value: dnsRecordText(mtaStsValue) || "Not published" },
        { label: "Policy", value: mtaStsPresent ? mtaStsPolicy(mtaStsValue) : "Not published" },
      ],
    },
    {
      id: "tlsRpt",
      title: DNS_FAMILY_TITLES.tlsRpt,
      status: tlsRptStatus,
      explanation: tlsRptPresent
        ? "TLS-RPT is published, so transport failures can be reported on."
        : "TLS-RPT is not published, so transport security cannot be reported on.",
      details: [
        { label: "Record", value: dnsRecordText(tlsRptValue) || "Not published" },
        { label: "Policy", value: tlsRptPresent ? "published" : "Not published" },
      ],
    },
  ];
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: "14px",
};

const familyStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  background: "var(--bg-elev)",
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const familyHeadStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "8px",
};

const familyTitleStyle: CSSProperties = {
  fontSize: "14px",
  fontWeight: 700,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const detailRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  padding: "3px 0",
  borderBottom: "1px solid var(--border)",
  fontSize: "12px",
};

const detailLabelStyle: CSSProperties = {
  color: "var(--muted)",
  whiteSpace: "nowrap",
};

const detailValueStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  overflowWrap: "anywhere",
  textAlign: "right",
};

const stateStyle: CSSProperties = {
  padding: "24px",
  textAlign: "center",
  color: "var(--text-soft)",
};

const errorStyle: CSSProperties = {
  padding: "16px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "var(--radius, 10px)",
  color: "var(--danger-text)",
};

export function DnsPanel({
  domain,
  records,
  health,
  loading = false,
  error = null,
}: DnsPanelProps): ReactElement {
  if (loading) {
    return (
      <div style={stateStyle} data-testid="dns-panel-loading">
        Loading DNS analysis…
      </div>
    );
  }

  if (error) {
    return (
      <div style={errorStyle} data-testid="dns-panel-error" role="alert">
        {error}
      </div>
    );
  }

  const families = buildDnsFamilies(records, health);
  const counts = families.reduce(
    (acc, family) => {
      acc[family.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0, info: 0 } as Record<DnsFamilyStatus, number>,
  );

  return (
    <div style={containerStyle} data-testid="dns-panel">
      <div className="dns-panel-label">
        {domain ? `Email authentication posture · ${domain}` : "Email authentication posture"}
      </div>
      <div className="dns-panel-explainer">
        MX, SPF, DKIM, DMARC, MTA-STS, and TLS-RPT are the DNS records that route
        mail and prove it really came from this domain.
      </div>

      <div className="dns-stat-row">
        <div className="dns-stat-card">
          <div className="dns-stat-label">Families passing</div>
          <div className="dns-stat-val">
            {counts.pass}
            <span> of {families.length}</span>
          </div>
        </div>
        <div className="dns-stat-card">
          <div className="dns-stat-label">Attention needed</div>
          <div className="dns-stat-val">{counts.warn + counts.fail}</div>
        </div>
      </div>

      <div style={gridStyle}>
        {families.map((family) => (
          <section
            key={family.id}
            style={familyStyle}
            data-testid={`dns-family-${family.id}`}
          >
            <div style={familyHeadStyle}>
              <span style={familyTitleStyle}>{family.title}</span>
              <span
                className={`status-badge ${family.status}`}
                data-testid={`dns-family-badge-${family.id}`}
              >
                <span className="dot" />
                {STATUS_LABELS[family.status]}
              </span>
            </div>
            <p
              className="dns-panel-explainer"
              data-testid={`dns-family-explanation-${family.id}`}
            >
              {family.explanation}
            </p>
            <div>
              {family.details.map((detail) => (
                <div key={detail.label} style={detailRowStyle}>
                  <span style={detailLabelStyle}>{detail.label}</span>
                  <span style={detailValueStyle}>{detail.value}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
