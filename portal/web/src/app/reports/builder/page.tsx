"use client";

import { useState } from "react";
import BlockCanvas, {
  V1_BLOCK_TYPES,
  createBlock,
  isV1BlockType,
  moveBlockInList,
  refreshBlockInList,
  removeBlockFromList,
  revertBlockInList,
  type ReportBlock,
  type V1BlockType,
} from "../../../components/reports/BlockCanvas";
import ReportSettingsRail, {
  type BuilderBranding,
  type BuilderPageSetup,
  type BuilderReportSettings,
} from "../../../components/reports/ReportSettingsRail";

export const TEMPLATE_API_PATH = "/v1/report-templates";
export const RENDER_API_PATH = "/v1/reports/render";
export const SCHEDULER_HREF = "/schedules?type=report";

export interface BuilderDocument {
  readonly schemaVersion: "v1";
  readonly name: string;
  readonly blocks: ReadonlyArray<Record<string, unknown>>;
  readonly settings: Record<string, unknown>;
  readonly pageSetup: Record<string, unknown>;
  readonly brandingOverrides: Record<string, unknown>;
}

export function buildTemplateDocument(
  name: string,
  blocks: readonly ReportBlock[],
  settings: BuilderReportSettings,
  pageSetup: BuilderPageSetup,
  branding: BuilderBranding,
): BuilderDocument {
  return {
    schemaVersion: "v1",
    name,
    blocks: blocks.map((block) => ({
      id: block.id,
      type: block.type,
      title: block.title,
      static: block.isStatic,
      ...(block.dataBinding === undefined
        ? {}
        : { dataBinding: { ...block.dataBinding } }),
      settings: { ...block.settings },
    })),
    settings: { ...settings },
    pageSetup: { ...pageSetup },
    brandingOverrides: {
      primaryColor: branding.primaryColor,
      secondaryColor: branding.secondaryColor,
      watermarkText: branding.watermarkText,
      showPageNumbers: branding.showPageNumbers,
    },
  };
}

export function parseBuilderBlocks(
  document: unknown,
): { name: string; blocks: ReportBlock[] } | null {
  if (typeof document !== "object" || document === null) return null;
  const record = document as Record<string, unknown>;
  if (!Array.isArray(record["blocks"])) return null;
  const blocks: ReportBlock[] = [];
  for (const entry of record["blocks"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const item = entry as Record<string, unknown>;
    if (typeof item["id"] !== "string" || typeof item["title"] !== "string") {
      return null;
    }
    if (!isV1BlockType(item["type"]) || typeof item["static"] !== "boolean") {
      return null;
    }
    blocks.push({
      id: item["id"] as string,
      type: item["type"],
      title: item["title"] as string,
      isStatic: item["static"] as boolean,
      dataBinding:
        typeof item["dataBinding"] === "object" && item["dataBinding"] !== null
          ? (item["dataBinding"] as { entity: string; field?: string })
          : undefined,
      settings:
        typeof item["settings"] === "object" && item["settings"] !== null
          ? (item["settings"] as Record<string, unknown>)
          : {},
    });
  }
  return {
    name: typeof record["name"] === "string" ? (record["name"] as string) : "",
    blocks,
  };
}

type FetchImpl = typeof fetch;

export async function saveTemplateDocument(
  fetchImpl: FetchImpl,
  document: BuilderDocument,
  templateId: string | null,
): Promise<{ id: string; document: unknown }> {
  if (templateId !== null) {
    const updated = await fetchImpl(`${TEMPLATE_API_PATH}/${templateId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: document.name, document }),
    });
    if (!updated.ok) throw new Error(`Save failed with status ${updated.status}`);
    const reloaded = await fetchImpl(`${TEMPLATE_API_PATH}/${templateId}`);
    if (!reloaded.ok) throw new Error(`Reload failed with status ${reloaded.status}`);
    const body = (await reloaded.json()) as { document?: unknown };
    return { id: templateId, document: body.document };
  }
  const created = await fetchImpl(TEMPLATE_API_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: document.name, document }),
  });
  if (!created.ok) throw new Error(`Save failed with status ${created.status}`);
  const body = (await created.json()) as { id?: string };
  if (typeof body.id !== "string") throw new Error("Save response is missing the template id");
  const reloaded = await fetchImpl(`${TEMPLATE_API_PATH}/${body.id}`);
  if (!reloaded.ok) throw new Error(`Reload failed with status ${reloaded.status}`);
  const reloadedBody = (await reloaded.json()) as { document?: unknown };
  return { id: body.id, document: reloadedBody.document };
}

// Preview and download share the server-side render path (ADR-0016): the
// browser never lays out the PDF itself.
export async function requestRender(
  fetchImpl: FetchImpl,
  document: BuilderDocument,
): Promise<Blob> {
  const response = await fetchImpl(RENDER_API_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ document }),
  });
  if (!response.ok) throw new Error(`Render failed with status ${response.status}`);
  return response.blob();
}

export default function ReportBuilderPage() {
  const [templateName, setTemplateName] = useState("Untitled report");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<ReportBlock[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [pendingType, setPendingType] = useState<V1BlockType>("rich-text");
  const [settings, setSettings] = useState<BuilderReportSettings>({
    title: "Untitled report",
    subtitle: "",
    redact: false,
  });
  const [pageSetup, setPageSetup] = useState<BuilderPageSetup>({
    pageSize: "A4",
    orientation: "portrait",
    marginMm: 16,
    headerText: "",
    footerText: "",
  });
  const [branding, setBranding] = useState<BuilderBranding>({
    primaryColor: "",
    secondaryColor: "",
    watermarkText: "",
    showPageNumbers: true,
  });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const document = buildTemplateDocument(
    templateName,
    blocks,
    settings,
    pageSetup,
    branding,
  );

  function applyReloaded(id: string, reloaded: unknown) {
    const parsed = parseBuilderBlocks(reloaded);
    if (parsed === null) {
      setError("Saved template could not be reloaded intact.");
      return;
    }
    setTemplateId(id);
    setBlocks(parsed.blocks);
    if (parsed.name !== "") setTemplateName(parsed.name);
    setStatus(`Saved template ${parsed.name || templateName}.`);
  }

  async function handleSave() {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const saved = await saveTemplateDocument(fetch, document, templateId);
      applyReloaded(saved.id, saved.document);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePreview() {
    setBusy(true);
    setError("");
    try {
      const pdf = await requestRender(fetch, document);
      const url = URL.createObjectURL(pdf);
      setPreviewUrl(url);
      setPreviewOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preview failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload() {
    setBusy(true);
    setError("");
    try {
      const pdf = await requestRender(fetch, document);
      const url = URL.createObjectURL(pdf);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = `${templateName || "report"}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus("Report download started.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      data-testid="report-builder"
      style={{ background: "var(--bg)", color: "var(--text)" }}
    >
      <header style={{ padding: "16px" }}>
        <h1 style={{ color: "var(--text)" }}>Report Builder</h1>
        <label>
          Template name
          <input
            type="text"
            aria-label="Template name"
            data-testid="template-name"
            disabled={busy}
            value={templateName}
            onChange={(event) => setTemplateName(event.target.value)}
            style={{
              background: "var(--input-bg)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              color: "var(--text)",
            }}
          />
        </label>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            data-testid="save-template"
            disabled={busy}
            onClick={handleSave}
          >
            Save template
          </button>
          <a data-testid="schedule-link" href={SCHEDULER_HREF}>
            Schedule
          </a>
          <button
            type="button"
            data-testid="download-pdf"
            disabled={busy}
            onClick={handleDownload}
          >
            Download PDF
          </button>
          <button
            type="button"
            data-testid="preview-pdf"
            disabled={busy}
            onClick={handlePreview}
          >
            Preview PDF
          </button>
          <select
            aria-label="Block type"
            data-testid="add-block-type"
            disabled={busy}
            value={pendingType}
            onChange={(event) =>
              setPendingType(event.target.value as V1BlockType)
            }
          >
            {V1_BLOCK_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="add-block"
            disabled={busy}
            onClick={() => setBlocks((prev) => [...prev, createBlock(pendingType)])}
          >
            Add block
          </button>
        </div>
        <p style={{ color: "var(--muted)" }}>
          Recurring delivery is owned by the scheduler (EPIC-007): saving a
          template first, then creating a report schedule keeps generation and
          delivery on the audited job path.
        </p>
        {status !== "" ? (
          <p role="status" data-testid="builder-status">
            {status}
          </p>
        ) : null}
        {error !== "" ? (
          <p role="alert" data-testid="builder-error">
            {error}
          </p>
        ) : null}
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 320px",
          gap: "16px",
          padding: "16px",
        }}
      >
        <BlockCanvas
          blocks={blocks}
          selectedBlockId={selectedBlockId}
          disabled={busy}
          onSelect={setSelectedBlockId}
          onMoveBlock={(index, direction) =>
            setBlocks((prev) => moveBlockInList(prev, index, direction))
          }
          onRemoveBlock={(index) =>
            setBlocks((prev) => removeBlockFromList(prev, index))
          }
          onRefreshBlock={(index) =>
            setBlocks((prev) => refreshBlockInList(prev, index))
          }
          onRevertBlock={(index) =>
            setBlocks((prev) => revertBlockInList(prev, index))
          }
        />
        <ReportSettingsRail
          settings={settings}
          pageSetup={pageSetup}
          branding={branding}
          disabled={busy}
          onSettingsChange={setSettings}
          onPageSetupChange={setPageSetup}
          onBrandingChange={setBranding}
        />
      </div>

      {previewOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Report preview"
          data-testid="preview-dialog"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border-strong)",
            borderRadius: "10px",
            color: "var(--text)",
            padding: "16px",
          }}
        >
          <h2>Report preview</h2>
          {previewUrl !== null ? (
            <iframe
              title="Report PDF preview"
              data-testid="preview-frame"
              src={previewUrl}
            />
          ) : null}
          <div style={{ display: "flex", gap: "8px" }}>
            {previewUrl !== null ? (
              <a
                data-testid="preview-download"
                href={previewUrl}
                download={`${templateName || "report"}.pdf`}
              >
                Download
              </a>
            ) : null}
            <button
              type="button"
              data-testid="preview-close"
              onClick={() => setPreviewOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
