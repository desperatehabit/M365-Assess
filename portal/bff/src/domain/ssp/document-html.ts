// Renders the SSP blocks as one self-contained, printable HTML page (inline CSS,
// no scripts, no external resources), suitable for a browser view or Print to PDF.
import type { SspDocumentView } from "@m365-assess/contracts/ssp";
import { buildSspBlocks, type SspBlock } from "./document-content.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((chunk) => escapeHtml(chunk).replace(/\n/g, "<br>"))
    .join("</p><p>");
}

function renderBlock(block: SspBlock): string {
  switch (block.kind) {
    case "title":
      return `<header class="title"><h1>${escapeHtml(block.text)}</h1>${block.subtitle
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join("")}</header>`;
    case "heading": {
      const tag = `h${block.level + 1}`;
      return `<${tag}>${escapeHtml(block.text)}</${tag}>`;
    }
    case "paragraph":
      return `<p class="${block.tone ?? "normal"}">${paragraphs(block.text)}</p>`;
    case "fields":
      return `<dl>${block.rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
    case "table":
      return `<table><thead><tr>${block.header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
    case "list":
      return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    case "pageBreak":
      return `<div class="page-break"></div>`;
  }
}

const STYLES = `
:root { color-scheme: light; }
body { margin: 0; background: #f4f5f7; color: #1f2328; font: 15px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 860px; margin: 0 auto; background: #fff; padding: 48px 56px; }
.title { border-bottom: 3px solid #1f4e79; margin-bottom: 24px; padding-bottom: 16px; }
.title h1 { font-size: 30px; margin: 0 0 8px; color: #1f4e79; }
.title p { margin: 2px 0; color: #57606a; }
h2 { font-size: 21px; color: #1f4e79; margin: 32px 0 8px; border-bottom: 1px solid #d0d7de; padding-bottom: 4px; }
h3 { font-size: 17px; margin: 24px 0 6px; }
h4 { font-size: 15px; margin: 20px 0 4px; }
p { margin: 6px 0; }
p.muted { color: #57606a; }
p.notice { background: #fff8c5; border-left: 4px solid #d4a72c; padding: 8px 12px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 8px 0; }
dt { font-weight: 600; }
dd { margin: 0; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 12px; font-size: 13px; }
th, td { border: 1px solid #d0d7de; padding: 4px 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: #eef2f6; }
@media (max-width: 640px) { main { padding: 24px 16px; } dl { grid-template-columns: 1fr; } }
@media print { body { background: #fff; } main { padding: 0; max-width: none; } .page-break { page-break-after: always; } }
`;

export function renderSspHtml(view: SspDocumentView): string {
  const blocks = buildSspBlocks(view);
  const name = view.profile?.systemName?.trim() || view.tenantId;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>System Security Plan — ${escapeHtml(name)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
${blocks.map(renderBlock).join("\n")}
</main>
</body>
</html>
`;
}
