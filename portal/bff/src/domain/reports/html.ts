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

function renderBlock(block: unknown): string {
  const record = asRecord(block);
  const title = typeof record["title"] === "string" ? record["title"] : "";
  const type = typeof record["type"] === "string" ? record["type"] : "";
  const settings = asRecord(record["settings"]);
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
    default:
      return `<section class="block"><h2>${escapeHtml(title)}</h2></section>`;
  }
}

/** A builder document page: settings, page setup, branding, and blocks. */
export function composeBuilderHtml(document: unknown): string {
  const doc = asRecord(document);
  const settings = asRecord(doc["settings"]);
  const pageSetup = asRecord(doc["pageSetup"]);
  const branding = asRecord(doc["brandingOverrides"]);
  const blocks = Array.isArray(doc["blocks"]) ? doc["blocks"] : [];
  const title = typeof settings["title"] === "string" ? settings["title"] : "Report";
  const subtitle = typeof settings["subtitle"] === "string" ? settings["subtitle"] : null;
  const body = `${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}${blocks.map(renderBlock).join("\n")}`;
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
  return composeBuilderHtml(document);
}
