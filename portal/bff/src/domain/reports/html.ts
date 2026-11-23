// Report HTML composition (EPIC-005 SPEC.md §3.1, §3.2, §4.4; ADR-0016).
//
// Decision: report HTML is composed here in the BFF, not in the worker or the web app.
// render-report.ps1 only prints an HTML file to PDF with headless Chromium (ADR-0016);
// it never sees the executive payload or the builder document. Composing the page here
// keeps a single HTML builder for both inputs — the executive payload and a template
// document — so the on-screen report and the PDF cannot diverge, and the render worker
// stays a thin printer.
//
// The output is a self-contained document: the payload is inlined as window.REPORT_DATA
// and the content is server-rendered into <div id="root">. Both markers are required by
// the render worker's input guard (Test-ReportRenderInput), which rejects HTML our
// builders did not produce. No external script references are emitted, so the guard's
// injection check passes by construction.
import type { ExecutiveRenderPayload } from "../../routes/reports.js";

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPE[ch] ?? ch);
}

/** Inline JSON safely inside a script tag: escape "<" so a payload cannot close it or inject markup. */
function inlineJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function factsRows(facts: Record<string, unknown>): string {
  const entries = Object.entries(facts);
  if (entries.length === 0) return '<p class="muted">None recorded.</p>';
  return `<table class="facts"><tbody>${entries
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("")}</tbody></table>`;
}

function bucketList(buckets: Record<string, unknown>): string {
  const entries = Object.entries(buckets);
  if (entries.length === 0) return '<p class="muted">None recorded.</p>';
  return `<ul class="buckets">${entries
    .map(([key, value]) => `<li><strong>${escapeHtml(key)}</strong> ${escapeHtml(value)}</li>`)
    .join("")}</ul>`;
}

interface ShellOptions {
  readonly title: string;
  readonly body: string;
  readonly data: unknown;
  readonly pageSize?: string;
  readonly orientation?: string;
  readonly marginMm?: number;
  readonly headerText?: string;
  readonly footerText?: string;
  readonly primaryColor?: string;
}

function documentShell(options: ShellOptions): string {
  const pageSize = options.pageSize ?? "A4";
  const orientation = options.orientation ?? "portrait";
  const marginMm = options.marginMm ?? 16;
  const primaryColor = options.primaryColor ?? "#1a3a5c";
  const header = options.headerText ? `<header>${escapeHtml(options.headerText)}</header>` : "";
  const footer = options.footerText ? `<footer>${escapeHtml(options.footerText)}</footer>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(options.title)}</title>
<style>
  :root { --primary: ${escapeHtml(primaryColor)}; }
  @page { size: ${escapeHtml(pageSize)} ${escapeHtml(orientation)}; margin: ${marginMm}mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #1f2933; margin: 0; line-height: 1.5; }
  #root { max-width: 100%; }
  h1 { color: var(--primary); font-size: 1.6rem; margin: 0 0 0.25rem; }
  h2 { color: var(--primary); font-size: 1.15rem; margin: 1.5rem 0 0.5rem; border-bottom: 1px solid #d9e2ec; padding-bottom: 0.25rem; }
  .subtitle { color: #52606d; margin: 0 0 1rem; }
  .muted { color: #7b8794; font-style: italic; }
  table.facts { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
  table.facts th, table.facts td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid #e4e7eb; vertical-align: top; }
  table.facts th { color: #52606d; font-weight: 600; width: 40%; }
  ul.buckets { list-style: none; padding: 0; margin: 0.5rem 0; }
  ul.buckets li { padding: 0.35rem 0; border-bottom: 1px solid #e4e7eb; }
  .block { margin: 1rem 0; }
  .page-break { page-break-after: always; height: 0; }
  table.report-table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; font-size: 0.88rem; }
  table.report-table th, table.report-table td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #e4e7eb; vertical-align: top; }
  table.report-table th { color: #52606d; font-size: 0.75rem; letter-spacing: 0.04em; text-transform: uppercase; }
  .progress-row { display: grid; grid-template-columns: minmax(90px, 160px) 1fr 48px; gap: 0.5rem; align-items: center; margin: 0.3rem 0; font-size: 0.85rem; }
  .progress-track { height: 7px; border-radius: 4px; background: #e4e7eb; overflow: hidden; }
  .progress-fill { display: block; height: 100%; background: var(--primary); }
  .progress-value { color: #52606d; text-align: right; font-family: Consolas, monospace; }
  .score-trend { padding-left: 1.1rem; margin: 0.5rem 0; }
  .score-trend li { margin: 0.3rem 0; font-size: 0.85rem; }
  .risk-list { padding-left: 1.2rem; margin: 0.5rem 0; font-size: 0.88rem; }
  .risk-list li { margin: 0.3rem 0; }
  .risk-severity { display: inline-block; min-width: 5.5rem; color: #b42318; font-family: Consolas, monospace; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; }
  .delta-up { color: #0f766e; }
  .delta-down { color: #b42318; }
  dl.report-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.5rem; margin: 0.5rem 0; }
  dl.report-facts div { border: 1px solid #e4e7eb; border-radius: 6px; padding: 0.45rem 0.6rem; }
  dl.report-facts dt { color: #7b8794; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
  dl.report-facts dd { margin: 0.15rem 0 0; font-size: 0.85rem; }
  header, footer { color: #7b8794; font-size: 0.8rem; }
</style>
</head>
<body>
<div id="root">
${header}
${options.body}
${footer}
</div>
<script>
window.REPORT_DATA = ${inlineJson(options.data)};
</script>
</body>
</html>
`;
}

/** The executive report page: tenant facts, compliance, secure score, action buckets. */
export function composeExecutiveHtml(payload: ExecutiveRenderPayload): string {
  const facts = payload.tenantFacts ?? {};
  const compliance = payload.compliance ?? {};
  const secureScore = payload.secureScore ?? {};
  const actionBuckets = payload.actionBuckets ?? {};
  const displayName = typeof facts["displayName"] === "string" ? facts["displayName"] : "Tenant";
  const body = `
<h1>${escapeHtml(displayName)}</h1>
<section class="facts">
  <h2>Tenant facts</h2>
  ${factsRows(facts)}
</section>
<section class="compliance">
  <h2>Compliance</h2>
  ${factsRows(compliance)}
</section>
<section class="secure-score">
  <h2>Secure score</h2>
  ${factsRows(secureScore)}
</section>
<section class="actions">
  <h2>Action buckets</h2>
  ${bucketList(actionBuckets)}
</section>`;
  return documentShell({ title: `${displayName} — Executive report`, body, data: payload });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function lower(value: unknown): string {
  return text(value).toLowerCase();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function dataRecord(value: unknown, key: string): Record<string, unknown> {
  return asRecord(asRecord(value)[key]);
}

function findingsFor(data: unknown): Array<Record<string, unknown>> {
  const findings = asRecord(data)["findings"];
  return Array.isArray(findings) ? findings.map(asRecord) : [];
}

function sectionOf(finding: Record<string, unknown>): string {
  return (
    text(finding["section"]) ||
    text(finding["category"]) ||
    text(finding["collector"]) ||
    "Unsectioned"
  );
}

function findingTitle(finding: Record<string, unknown>): string {
  return (
    text(finding["controlName"]) ||
    text(finding["checkId"]) ||
    text(finding["title"]) ||
    "Finding"
  );
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function percent(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

function progressRow(label: string, count: number, total: number, showPercent = true): string {
  const pct = percent(count, total);
  const value = showPercent ? `${pct}%` : String(count);
  return `<div class="progress-row"><span>${escapeHtml(label)}</span><span class="progress-track"><span class="progress-fill" style="width:${pct}%"></span></span><span class="progress-value">${escapeHtml(value)}</span></div>`;
}

function placeholder(message: string): string {
  return `<p class="muted">${escapeHtml(message)}</p>`;
}

function filterFindings(
  settings: Record<string, unknown>,
  findings: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const statuses = stringArray(settings["statuses"]).map((value) => value.toLowerCase());
  const severities = stringArray(settings["severities"]).map((value) => value.toLowerCase());
  const sections = stringArray(settings["sections"]).map((value) => value.toLowerCase());
  const limit =
    typeof settings["limit"] === "number" && Number.isFinite(settings["limit"])
      ? Math.max(1, Math.trunc(settings["limit"]))
      : undefined;
  const filtered = findings.filter((finding) => {
    if (statuses.length > 0 && !statuses.includes(lower(finding["status"]))) return false;
    if (severities.length > 0 && !severities.includes(lower(finding["severity"]))) return false;
    if (
      sections.length > 0 &&
      !sections.some((section) =>
        [finding["section"], finding["category"], finding["collector"]]
          .map(lower)
          .includes(section),
      )
    ) {
      return false;
    }
    return true;
  });
  return limit === undefined ? filtered : filtered.slice(0, limit);
}

function renderFindingsTable(
  settings: Record<string, unknown>,
  data: unknown,
): string {
  const findings = findingsFor(data);
  if (findings.length === 0) {
    return placeholder("Findings are resolved when the report renders against a run.");
  }
  const rows = filterFindings(settings, findings);
  if (rows.length === 0) {
    return placeholder("No findings match the selected filters.");
  }
  return `<table class="report-table"><thead><tr><th>Status</th><th>Severity</th><th>Section</th><th>Finding</th></tr></thead><tbody>${rows
    .map(
      (finding) =>
        `<tr><td>${escapeHtml(text(finding["status"]) || "—")}</td><td>${escapeHtml(text(finding["severity"]) || "—")}</td><td>${escapeHtml(sectionOf(finding))}</td><td>${escapeHtml(findingTitle(finding))}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function renderFrameworkCoverage(
  settings: Record<string, unknown>,
  data: unknown,
): string {
  const configured = stringArray(settings["frameworks"]).map((value) => value.toLowerCase());
  const explicit = asRecord(data)["frameworks"];
  if (Array.isArray(explicit) && explicit.length > 0) {
    const rows = explicit
      .map(asRecord)
      .map((row) => ({
        framework: text(row["framework"]) || text(row["name"]) || "Framework",
        pass: Number(row["pass"]) || 0,
        fail: Number(row["fail"]) || 0,
        warning: Number(row["warning"]) || 0,
        total: Number(row["total"]) || 0,
      }))
      .filter(
        (row) =>
          configured.length === 0 ||
          configured.includes(row.framework.toLowerCase()),
      );
    if (rows.length === 0) return placeholder("No frameworks match the selected filters.");
    return `<table class="report-table"><thead><tr><th>Framework</th><th>Pass</th><th>Fail</th><th>Coverage</th></tr></thead><tbody>${rows
      .map((row) => {
        const total = row.total || row.pass + row.fail + row.warning;
        return `<tr><td>${escapeHtml(row.framework)}</td><td>${row.pass}</td><td>${row.fail}</td><td><span class="progress-track"><span class="progress-fill" style="width:${percent(row.pass, total)}%"></span></span> ${percent(row.pass, total)}%</td></tr>`;
      })
      .join("")}</tbody></table>`;
  }

  const findings = findingsFor(data);
  if (findings.length === 0) {
    return placeholder("Framework coverage is resolved when the report renders against a run.");
  }
  const groups = new Map<string, Array<Record<string, unknown>>>();
  const hasFrameworkRefs = findings.some(
    (finding) => stringArray(finding["frameworkRefs"]).length > 0,
  );
  for (const finding of findings) {
    const labels = hasFrameworkRefs
      ? stringArray(finding["frameworkRefs"]).map(
          (ref) => ref.split(/\s+/)[0] ?? ref,
        )
      : [sectionOf(finding)];
    for (const label of labels) {
      const list = groups.get(label);
      if (list) list.push(finding);
      else groups.set(label, [finding]);
    }
  }
  const rows = [...groups.entries()]
    .filter(
      ([section]) =>
        configured.length === 0 || configured.includes(section.toLowerCase()),
    )
    .sort((a, b) => b[1].length - a[1].length);
  if (rows.length === 0) return placeholder("No frameworks match the selected filters.");
  return `<table class="report-table"><thead><tr><th>Framework / section</th><th>Pass</th><th>Fail</th><th>Coverage</th></tr></thead><tbody>${rows
    .map(([section, items]) => {
      const pass = items.filter((item) => lower(item["status"]) === "pass").length;
      const fail = items.filter((item) => lower(item["status"]) === "fail").length;
      return `<tr><td>${escapeHtml(section)}</td><td>${pass}</td><td>${fail}</td><td><span class="progress-track"><span class="progress-fill" style="width:${percent(pass, items.length)}%"></span></span> ${percent(pass, items.length)}%</td></tr>`;
    })
    .join("")}</tbody></table>`;
}

function renderSecureScoreTrend(
  settings: Record<string, unknown>,
  data: unknown,
): string {
  const score = dataRecord(data, "secureScore");
  const history = Array.isArray(score["history"])
    ? score["history"].map(asRecord)
    : [];
  const points = history.length > 0 ? history : Object.keys(score).length > 0 ? [score] : [];
  if (points.length === 0) {
    return placeholder("Secure score history is resolved when the report renders.");
  }
  const limit =
    typeof settings["points"] === "number" && Number.isFinite(settings["points"])
      ? Math.max(1, Math.trunc(settings["points"]))
      : points.length;
  const shown = points.slice(-limit);
  return `<ol class="score-trend">${shown
    .map((point) => {
      const current = Number(point["current"]) || 0;
      const max = Number(point["max"]) || 100;
      const pct =
        typeof point["percentage"] === "number"
          ? point["percentage"]
          : percent(current, max);
      const at = text(point["at"]) || text(point["capturedAt"]) || "Snapshot";
      return `<li>${escapeHtml(at)}: <strong>${escapeHtml(pct)}%</strong> <span class="progress-track"><span class="progress-fill" style="width:${pct}%"></span></span></li>`;
    })
    .join("")}</ol>`;
}

function renderTopRisks(
  settings: Record<string, unknown>,
  data: unknown,
): string {
  const minSeverity = lower(settings["minSeverity"]);
  const minimum = minSeverity === "" ? 4 : SEVERITY_RANK[minSeverity] ?? 4;
  const limit =
    typeof settings["limit"] === "number" && Number.isFinite(settings["limit"])
      ? Math.max(1, Math.trunc(settings["limit"]))
      : 5;
  const risks = findingsFor(data)
    .filter((finding) => {
      const status = lower(finding["status"]);
      if (status !== "fail" && status !== "warning") return false;
      return (SEVERITY_RANK[lower(finding["severity"])] ?? 4) <= minimum;
    })
    .sort(
      (a, b) =>
        (SEVERITY_RANK[lower(a["severity"])] ?? 4) -
        (SEVERITY_RANK[lower(b["severity"])] ?? 4),
    )
    .slice(0, limit);
  if (risks.length === 0) {
    return placeholder("Top risks appear once the run has failed findings.");
  }
  return `<ol class="risk-list">${risks
    .map(
      (risk) =>
        `<li><span class="risk-severity">${escapeHtml(text(risk["severity"]) || "—")}</span>${escapeHtml(findingTitle(risk))}</li>`,
    )
    .join("")}</ol>`;
}

function renderRemediationProgress(
  settings: Record<string, unknown>,
  data: unknown,
): string {
  const findings = findingsFor(data);
  if (findings.length === 0) {
    return placeholder("Remediation progress is resolved when the report renders.");
  }
  const groupBy = settings["groupBy"];
  const key = groupBy === "severity" || groupBy === "section" ? groupBy : "status";
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const label =
      key === "status"
        ? text(finding["status"]) || "Unknown"
        : key === "severity"
          ? text(finding["severity"]) || "Unrated"
          : sectionOf(finding);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const showPercentages = settings["showPercentages"] !== false;
  return `<div class="progress-list">${rows
    .map(([label, count]) => progressRow(label, count, findings.length, showPercentages))
    .join("")}</div>`;
}

function renderTenantSummary(
  settings: Record<string, unknown>,
  data: unknown,
): string {
  const tenant = dataRecord(data, "tenant");
  const run = dataRecord(data, "run");
  const facts: Array<[string, string]> = [
    ["Tenant", text(tenant["displayName"]) || text(tenant["tenantId"])],
    ["Default domain", text(tenant["defaultDomain"])],
    ["Run", text(run["id"]) || text(run["runId"])],
    ["Status", text(run["status"])],
    ["Started", text(run["startedAt"])],
    ["Finished", text(run["finishedAt"])],
  ].filter(([, value]) => value !== "") as Array<[string, string]>;
  if (facts.length === 0) {
    return placeholder("Tenant facts are resolved when the report renders against a run.");
  }
  const configured = stringArray(settings["fields"]).map((value) => value.toLowerCase());
  const shown =
    configured.length === 0
      ? facts
      : facts.filter(([label]) => configured.includes(label.toLowerCase()));
  if (shown.length === 0) return placeholder("No tenant fields match the selected filters.");
  return `<dl class="report-facts">${shown
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join("")}</dl>`;
}

function renderRunComparison(
  settings: Record<string, unknown>,
  data: unknown,
): string {
  const current = dataRecord(data, "run");
  const baseline = dataRecord(data, "baselineRun");
  if (Object.keys(current).length === 0) {
    return placeholder("Run comparison is resolved when the report renders against runs.");
  }
  if (Object.keys(baseline).length === 0) {
    return placeholder("No baseline run is available for this comparison.");
  }
  const currentCounts = asRecord(current["summaryCounts"]);
  const currentSummary = Object.keys(currentCounts).length > 0 ? currentCounts : current;
  const baselineCounts = asRecord(baseline["summaryCounts"]);
  const baselineSummary = Object.keys(baselineCounts).length > 0 ? baselineCounts : baseline;
  const showUnchanged = settings["showUnchanged"] !== false;
  const rows = (["pass", "fail", "warning"] as const)
    .map((metric) => ({
      metric,
      current: Number(currentSummary[metric]) || 0,
      baseline: Number(baselineSummary[metric]) || 0,
    }))
    .map((row) => ({ ...row, delta: row.current - row.baseline }))
    .filter((row) => showUnchanged || row.delta !== 0);
  if (rows.length === 0 && !showUnchanged) {
    return placeholder("No counts changed between the selected runs.");
  }
  return `<table class="report-table"><thead><tr><th>Metric</th><th>Current</th><th>Baseline</th><th>Change</th></tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.metric)}</td><td>${row.current}</td><td>${row.baseline}</td><td class="${row.delta === 0 ? "" : row.delta > 0 ? "delta-up" : "delta-down"}">${row.delta > 0 ? `+${row.delta}` : row.delta}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function renderBlock(block: unknown, data: unknown): string {
  const record = asRecord(block);
  const title = typeof record["title"] === "string" ? record["title"] : "";
  const type = typeof record["type"] === "string" ? record["type"] : "";
  const settings = asRecord(record["settings"]);
  // A captured block carries its snapshot; live blocks use the render data.
  const blockData = settings["data"] ?? settings["snapshot"] ?? data;
  switch (type) {
    case "rich-text": {
      const body = typeof settings["body"] === "string" ? settings["body"] : "";
      return `<section class="block rich-text"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></section>`;
    }
    case "section-divider":
      return `<section class="block section-divider"><h2>${escapeHtml(title)}</h2></section>`;
    case "page-break":
      return '<div class="block page-break"></div>';
    case "chart":
    case "score-cards":
    case "progress-bars":
      return `<section class="block ${escapeHtml(type)}"><h2>${escapeHtml(title)}</h2><p class="muted">Data-backed block.</p></section>`;
    case "findings-table":
      return `<section class="block findings-table"><h2>${escapeHtml(title)}</h2>${renderFindingsTable(settings, blockData)}</section>`;
    case "framework-coverage":
      return `<section class="block framework-coverage"><h2>${escapeHtml(title)}</h2>${renderFrameworkCoverage(settings, blockData)}</section>`;
    case "secure-score-trend":
      return `<section class="block secure-score-trend"><h2>${escapeHtml(title)}</h2>${renderSecureScoreTrend(settings, blockData)}</section>`;
    case "top-risks":
      return `<section class="block top-risks"><h2>${escapeHtml(title)}</h2>${renderTopRisks(settings, blockData)}</section>`;
    case "remediation-progress":
      return `<section class="block remediation-progress"><h2>${escapeHtml(title)}</h2>${renderRemediationProgress(settings, blockData)}</section>`;
    case "tenant-summary":
      return `<section class="block tenant-summary"><h2>${escapeHtml(title)}</h2>${renderTenantSummary(settings, blockData)}</section>`;
    case "run-comparison":
      return `<section class="block run-comparison"><h2>${escapeHtml(title)}</h2>${renderRunComparison(settings, blockData)}</section>`;
    default:
      return `<section class="block"><h2>${escapeHtml(title)}</h2></section>`;
  }
}

/**
 * A builder document page: settings, page setup, branding, and blocks. Live
 * data-bound blocks render from `runData` (the run the preview targets) or from
 * a snapshot captured on the block; without either they show a placeholder so
 * the page never looks broken.
 */
export function composeBuilderHtml(document: unknown, runData?: unknown): string {
  const doc = asRecord(document);
  const settings = asRecord(doc["settings"]);
  const pageSetup = asRecord(doc["pageSetup"]);
  const branding = asRecord(doc["brandingOverrides"]);
  const blocks = Array.isArray(doc["blocks"]) ? doc["blocks"] : [];
  const title = typeof settings["title"] === "string" ? settings["title"] : "Report";
  const subtitle = typeof settings["subtitle"] === "string" ? settings["subtitle"] : null;
  const data = runData ?? doc["data"];
  const body = `${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}${blocks.map((block) => renderBlock(block, data)).join("\n")}`;
  return documentShell({
    title,
    body,
    data: document,
    pageSize: typeof pageSetup["pageSize"] === "string" ? pageSetup["pageSize"] : undefined,
    orientation: typeof pageSetup["orientation"] === "string" ? pageSetup["orientation"] : undefined,
    marginMm: typeof pageSetup["marginMm"] === "number" ? pageSetup["marginMm"] : undefined,
    headerText: typeof pageSetup["headerText"] === "string" ? pageSetup["headerText"] : undefined,
    footerText: typeof pageSetup["footerText"] === "string" ? pageSetup["footerText"] : undefined,
    primaryColor: typeof branding["primaryColor"] === "string" ? branding["primaryColor"] : undefined,
  });
}

/**
 * Compose the HTML for a render job from its route payload: the executive payload for
 * executive renders, the builder document for custom and template renders.
 */
export function composeReportHtml(payload: Record<string, unknown>): string {
  if (payload["type"] === "executive") {
    return composeExecutiveHtml(payload["executivePayload"] as ExecutiveRenderPayload);
  }
  const document = payload["document"] ?? payload["template"];
  const runData = payload["runData"] ?? payload["data"] ?? asRecord(document)["data"];
  return composeBuilderHtml(document, runData);
}
