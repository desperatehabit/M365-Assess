"use client";

import { useEffect, useState } from "react";
import BlockCanvas, {
  BLOCK_PALETTE_GROUPS,
  BLOCK_TYPE_DESCRIPTIONS,
  BLOCK_TYPE_LABELS,
  V1_BLOCK_TYPES,
  createBlock,
  isV1BlockType,
  moveBlockInList,
  moveBlockToIndex,
  refreshBlockInList,
  removeBlockFromList,
  revertBlockInList,
  type ReportBlock,
  type RunPreviewData,
  type RunPreviewFinding,
  type RunPreviewRun,
  type V1BlockType,
} from "../../../components/reports/BlockCanvas";
import ReportSettingsRail, {
  type BuilderBranding,
  type BuilderPageSetup,
  type BuilderReportSettings,
} from "../../../components/reports/ReportSettingsRail";

export const TEMPLATE_API_PATH = "/v1/report-templates";
export const RENDER_API_PATH = "/v1/reports/render";
export const RUNS_API_PATH = "/v1/runs";
export const SCHEDULER_HREF = "/schedules?type=report";

export interface BuilderDocument {
  readonly schemaVersion: "v1";
  readonly name: string;
  readonly blocks: ReadonlyArray<Record<string, unknown>>;
  readonly settings: Record<string, unknown>;
  readonly pageSetup: Record<string, unknown>;
  readonly brandingOverrides: Record<string, unknown>;
  /** Live run data used for preview renders; never persisted with a template. */
  readonly data?: Record<string, unknown>;
}

export function buildTemplateDocument(
  name: string,
  blocks: readonly ReportBlock[],
  settings: BuilderReportSettings,
  pageSetup: BuilderPageSetup,
  branding: BuilderBranding,
  runData?: Record<string, unknown>,
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
    ...(runData === undefined ? {} : { data: runData }),
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

interface BuilderTemplateDocument {
  readonly name: string;
  readonly blocks: ReportBlock[];
  readonly settings?: Partial<BuilderReportSettings>;
  readonly pageSetup?: Partial<BuilderPageSetup>;
  readonly brandingOverrides?: Partial<BuilderBranding>;
}

export function parseBuilderDocument(document: unknown): BuilderTemplateDocument | null {
  const parsed = parseBuilderBlocks(document);
  if (parsed === null) return null;
  const record = document as Record<string, unknown>;
  const recordOf = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const settings = recordOf(record["settings"]);
  const pageSetup = recordOf(record["pageSetup"]);
  const branding = recordOf(record["brandingOverrides"]);
  return {
    ...parsed,
    settings: {
      ...(typeof settings["title"] === "string" ? { title: settings["title"] } : {}),
      ...(typeof settings["subtitle"] === "string"
        ? { subtitle: settings["subtitle"] }
        : {}),
      ...(typeof settings["redact"] === "boolean" ? { redact: settings["redact"] } : {}),
    },
    pageSetup: {
      ...(pageSetup["pageSize"] === "A4" ||
      pageSetup["pageSize"] === "Letter" ||
      pageSetup["pageSize"] === "Legal"
        ? { pageSize: pageSetup["pageSize"] }
        : {}),
      ...(pageSetup["orientation"] === "portrait" ||
      pageSetup["orientation"] === "landscape"
        ? { orientation: pageSetup["orientation"] }
        : {}),
      ...(typeof pageSetup["marginMm"] === "number"
        ? { marginMm: pageSetup["marginMm"] }
        : {}),
      ...(typeof pageSetup["headerText"] === "string"
        ? { headerText: pageSetup["headerText"] }
        : {}),
      ...(typeof pageSetup["footerText"] === "string"
        ? { footerText: pageSetup["footerText"] }
        : {}),
    },
    brandingOverrides: {
      ...(typeof branding["primaryColor"] === "string"
        ? { primaryColor: branding["primaryColor"] }
        : {}),
      ...(typeof branding["secondaryColor"] === "string"
        ? { secondaryColor: branding["secondaryColor"] }
        : {}),
      ...(typeof branding["watermarkText"] === "string"
        ? { watermarkText: branding["watermarkText"] }
        : {}),
      ...(typeof branding["showPageNumbers"] === "boolean"
        ? { showPageNumbers: branding["showPageNumbers"] }
        : {}),
    },
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

interface TemplateOption {
  readonly id: string;
  readonly name: string;
  readonly readOnly?: boolean;
}

interface RunOption {
  readonly id: string;
  readonly tenantId?: string;
  readonly tenantDisplayName?: string | null;
  readonly status?: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly summaryCounts?: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

  // Starter templates and live run preview are loaded on demand so opening the
  // builder never blocks on the network.
  const [templateOptions, setTemplateOptions] = useState<TemplateOption[]>([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [runs, setRuns] = useState<RunOption[]>([]);
  const [runId, setRunId] = useState("");
  const [runsLoading, setRunsLoading] = useState(false);
  const [previewData, setPreviewData] = useState<RunPreviewData | undefined>();
  const [liveStatus, setLiveStatus] = useState("");

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

  function applyTemplate(id: string, readOnly: boolean, reloaded: unknown) {
    const parsed = parseBuilderDocument(reloaded);
    if (parsed === null) {
      setError("That template could not be loaded.");
      return;
    }
    setBlocks(parsed.blocks);
    setSelectedBlockId(parsed.blocks[0]?.id ?? null);
    setTemplateId(readOnly ? null : id);
    if (parsed.name !== "") {
      setTemplateName(parsed.name);
      setSettings((previous) => ({ ...previous, title: parsed.name }));
    }
    if (parsed.settings !== undefined) {
      setSettings((previous) => ({ ...previous, ...parsed.settings }));
    }
    if (parsed.pageSetup !== undefined) {
      setPageSetup((previous) => ({ ...previous, ...parsed.pageSetup }));
    }
    if (parsed.brandingOverrides !== undefined) {
      setBranding((previous) => ({ ...previous, ...parsed.brandingOverrides }));
    }
    setError("");
    setStatus(
      readOnly
        ? `Loaded built-in template ${parsed.name || id}. Saving creates a copy.`
        : `Loaded template ${parsed.name || id}.`,
    );
  }

  async function loadTemplateById(id: string, readOnly = false) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${TEMPLATE_API_PATH}/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(`Load failed with status ${response.status}`);
      const body = (await response.json()) as { document?: unknown; readOnly?: boolean };
      applyTemplate(id, readOnly || body.readOnly === true, body.document);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Template load failed.");
    } finally {
      setBusy(false);
    }
  }

  async function loadTemplateOptions() {
    setTemplatePickerOpen(true);
    if (templateOptions.length > 0 || templatesLoading) return;
    setTemplatesLoading(true);
    setError("");
    try {
      const response = await fetch(TEMPLATE_API_PATH);
      if (!response.ok) throw new Error(`Templates failed to load: ${response.status}`);
      const body = (await response.json()) as { items?: unknown };
      const items = Array.isArray(body.items) ? body.items : [];
      setTemplateOptions(
        items
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> & { id: string; name: string } =>
            typeof item["id"] === "string" && typeof item["name"] === "string",
          )
          .map((item) => ({
            id: item.id,
            name: item.name,
            readOnly: item["readOnly"] === true,
          })),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Templates failed to load.");
    } finally {
      setTemplatesLoading(false);
    }
  }

  async function loadRuns() {
    if (runsLoading) return;
    setRunsLoading(true);
    setError("");
    try {
      const response = await fetch(RUNS_API_PATH);
      if (!response.ok) throw new Error(`Runs failed to load: ${response.status}`);
      const body = (await response.json()) as { items?: unknown };
      const items = Array.isArray(body.items) ? body.items : [];
      const loaded: RunOption[] = items
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> & { id: string } =>
          typeof item["id"] === "string",
        )
        .map((item) => ({
          id: item.id,
          tenantId: typeof item["tenantId"] === "string" ? item["tenantId"] : undefined,
          tenantDisplayName:
            typeof item["tenantDisplayName"] === "string"
              ? item["tenantDisplayName"]
              : null,
          status: typeof item["status"] === "string" ? item["status"] : undefined,
          startedAt: typeof item["startedAt"] === "string" ? item["startedAt"] : null,
          finishedAt: typeof item["finishedAt"] === "string" ? item["finishedAt"] : null,
          summaryCounts:
            typeof item["summaryCounts"] === "object" && item["summaryCounts"] !== null
              ? (item["summaryCounts"] as Record<string, unknown>)
              : null,
        }));
      setRuns(loaded);
      if (loaded.length > 0 && runId === "") {
        await loadRunPreview(loaded[0]!.id, loaded);
      } else {
        setLiveStatus(
          loaded.length === 0 ? "No finished runs are available." : "Runs loaded.",
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Runs failed to load.");
    } finally {
      setRunsLoading(false);
    }
  }

  async function loadRunPreview(id: string, available: readonly RunOption[] = runs) {
    setRunId(id);
    setLiveStatus("Loading run findings…");
    try {
      const response = await fetch(`${RUNS_API_PATH}/${encodeURIComponent(id)}/results`);
      if (!response.ok) throw new Error(`Run results failed to load: ${response.status}`);
      const body = (await response.json()) as { items?: unknown };
      const findings: RunPreviewFinding[] = (Array.isArray(body.items) ? body.items : [])
        .map((item) => asRecord(item))
        .map((item) => ({
          status: typeof item["status"] === "string" ? item["status"] : undefined,
          severity: typeof item["severity"] === "string" ? item["severity"] : undefined,
          category: typeof item["category"] === "string" ? item["category"] : undefined,
          section: typeof item["section"] === "string" ? item["section"] : undefined,
          collector: typeof item["collector"] === "string" ? item["collector"] : undefined,
          controlName:
            typeof item["controlName"] === "string" ? item["controlName"] : undefined,
          checkId: typeof item["checkId"] === "string" ? item["checkId"] : undefined,
          currentValue:
            typeof item["currentValue"] === "string" ? item["currentValue"] : undefined,
          recommendedValue:
            typeof item["recommendedValue"] === "string"
              ? item["recommendedValue"]
              : undefined,
          remediation:
            typeof item["remediation"] === "string" ? item["remediation"] : undefined,
          frameworkRefs: Array.isArray(item["frameworkRefs"])
            ? item["frameworkRefs"].filter(
                (ref): ref is string => typeof ref === "string",
              )
            : undefined,
        }));
      const index = available.findIndex((run) => run.id === id);
      const current = available[index] ?? available[0];
      const baseline =
        index >= 0 && index + 1 < available.length ? available[index + 1] : undefined;

      // The trend endpoint is optional for the preview: the block falls back to
      // the selected run's pass rate when snapshots are unavailable.
      let secureScore: RunPreviewData["secureScore"];
      if (typeof current?.tenantId === "string") {
        try {
          const trendResponse = await fetch(
            `/v1/tenants/${encodeURIComponent(current.tenantId)}/secure-score/trend`,
          );
          if (trendResponse.ok) {
            const trendBody = (await trendResponse.json()) as { snapshots?: unknown };
            const history = (Array.isArray(trendBody.snapshots) ? trendBody.snapshots : [])
              .map((snapshot) => asRecord(snapshot))
              .map((snapshot) => ({
                at: typeof snapshot["at"] === "string" ? snapshot["at"] : undefined,
                current:
                  typeof snapshot["current"] === "number" ? snapshot["current"] : undefined,
                max: typeof snapshot["max"] === "number" ? snapshot["max"] : undefined,
                percentage:
                  typeof snapshot["percentage"] === "number"
                    ? snapshot["percentage"]
                    : undefined,
              }));
            const latest = history.at(-1);
            secureScore = {
              current: latest?.current,
              max: latest?.max,
              percentage: latest?.percentage,
              history,
            };
          }
        } catch {
          // Preview still works without the trend history.
        }
      }

      setPreviewData({
        run: current as RunPreviewRun | undefined,
        baselineRun: baseline as RunPreviewRun | undefined,
        findings,
        secureScore,
      });
      setLiveStatus(
        `Live preview: ${findings.length} finding${findings.length === 1 ? "" : "s"}` +
          (baseline === undefined ? " · no baseline run" : ` · baseline ${baseline.id}`),
      );
    } catch (cause) {
      setLiveStatus("");
      setError(cause instanceof Error ? cause.message : "Run results failed to load.");
    }
  }

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("templateId");
    if (requested !== null && requested !== "") {
      void loadTemplateById(requested);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function renderDocument(): BuilderDocument {
    if (previewData === undefined) return document;
    const findings = previewData.findings ?? [];
    const pass = findings.filter(
      (finding) => (finding.status ?? "").toLowerCase() === "pass",
    ).length;
    return buildTemplateDocument(
      templateName,
      blocks,
      settings,
      pageSetup,
      branding,
      {
        tenant: {
          tenantId: previewData.run?.tenantId,
          displayName: previewData.run?.tenantDisplayName ?? undefined,
        },
        run: asRecord(previewData.run),
        baselineRun: asRecord(previewData.baselineRun),
        findings,
        secureScore:
          previewData.secureScore ??
          (findings.length === 0
            ? undefined
            : {
                current: pass,
                max: findings.length,
                percentage: Math.round((pass / findings.length) * 100),
              }),
      },
    );
  }

  async function handlePreview() {
    setBusy(true);
    setError("");
    try {
      const pdf = await requestRender(fetch, renderDocument());
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
      const pdf = await requestRender(fetch, renderDocument());
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

  function addBlock(type: V1BlockType) {
    const block = createBlock(type);
    setBlocks((previous) => [...previous, block]);
    setSelectedBlockId(block.id);
  }

  return (
    <main className="report-builder" data-testid="report-builder">
      <header className="report-builder-header">
        <div className="report-builder-heading">
          <div>
            <p className="report-eyebrow">Reports</p>
            <h1>Report Builder</h1>
            <p className="report-builder-subtitle">
              Compose a template from data-bound blocks, then save it or hand
              delivery to the scheduler.
            </p>
          </div>
          <div className="report-builder-actions">
            <button
              type="button"
              className="report-button primary"
              data-testid="save-template"
              disabled={busy}
              onClick={handleSave}
            >
              Save template
            </button>
            <a
              className="report-button"
              data-testid="schedule-link"
              href={SCHEDULER_HREF}
            >
              Schedule
            </a>
            <button
              type="button"
              className="report-button"
              data-testid="download-pdf"
              disabled={busy}
              onClick={handleDownload}
            >
              Download PDF
            </button>
            <button
              type="button"
              className="report-button"
              data-testid="preview-pdf"
              disabled={busy}
              onClick={handlePreview}
            >
              Preview PDF
            </button>
          </div>
        </div>

        <div className="report-builder-meta">
          <label className="report-field report-field-inline">
            <span>Template name</span>
            <input
              className="report-input"
              type="text"
              aria-label="Template name"
              data-testid="template-name"
              disabled={busy}
              value={templateName}
              onChange={(event) => setTemplateName(event.target.value)}
            />
          </label>

          <div className="report-starter">
            <button
              type="button"
              className="report-button"
              data-testid="load-templates"
              disabled={busy || templatesLoading}
              onClick={() => void loadTemplateOptions()}
            >
              {templatesLoading ? "Loading templates…" : "Start from template"}
            </button>
            {templatePickerOpen ? (
              <label className="report-field report-field-inline">
                <span>Starter template</span>
                <select
                  className="report-input"
                  aria-label="Starter template"
                  data-testid="template-picker"
                  disabled={busy || templateOptions.length === 0}
                  defaultValue=""
                  onChange={(event) => {
                    const id = event.target.value;
                    if (id !== "") void loadTemplateById(id);
                  }}
                >
                  <option value="">
                    {templateOptions.length === 0 ? "No templates available" : "Choose a template…"}
                  </option>
                  {templateOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                      {option.readOnly === true ? " (built-in)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          <div className="report-live-preview">
            <button
              type="button"
              className="report-button"
              data-testid="load-runs"
              disabled={busy || runsLoading}
              onClick={() => void loadRuns()}
            >
              {runsLoading ? "Loading runs…" : "Preview against a run"}
            </button>
            {runs.length > 0 ? (
              <label className="report-field report-field-inline">
                <span>Run</span>
                <select
                  className="report-input"
                  aria-label="Preview run"
                  data-testid="preview-run"
                  disabled={busy}
                  value={runId}
                  onChange={(event) => void loadRunPreview(event.target.value)}
                >
                  {runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.tenantDisplayName ?? run.tenantId ?? run.id} · {run.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {liveStatus !== "" ? (
              <p className="report-live-status" data-testid="live-preview-status">
                {liveStatus}
              </p>
            ) : null}
          </div>
        </div>

        {status !== "" ? (
          <p className="report-status" role="status" data-testid="builder-status">
            {status}
          </p>
        ) : null}
        {error !== "" ? (
          <p className="report-error" role="alert" data-testid="builder-error">
            {error}
          </p>
        ) : null}
      </header>

      <div className="report-builder-layout">
        <aside
          className="report-palette"
          aria-label="Block palette"
          data-testid="report-palette"
        >
          <h2>Blocks</h2>
          <p className="report-palette-intro">
            Add data-bound sections or layout blocks to the page.
          </p>
          {BLOCK_PALETTE_GROUPS.map((group) => (
            <section key={group.label} className="report-palette-group">
              <h3>{group.label}</h3>
              <div className="report-palette-list">
                {group.types.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className="report-palette-button"
                    data-testid={`palette-${type}`}
                    aria-label={`Add ${BLOCK_TYPE_LABELS[type]} block`}
                    disabled={busy}
                    onClick={() => addBlock(type)}
                  >
                    <span className="report-palette-name">
                      {BLOCK_TYPE_LABELS[type]}
                    </span>
                    <span className="report-palette-description">
                      {BLOCK_TYPE_DESCRIPTIONS[type]}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}

          <section className="report-palette-group report-palette-custom">
            <h3>Custom block</h3>
            <label className="report-field">
              <span>Block type</span>
              <select
                className="report-input"
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
            </label>
            <button
              type="button"
              className="report-button"
              data-testid="add-block"
              disabled={busy}
              onClick={() => addBlock(pendingType)}
            >
              Add block
            </button>
          </section>
        </aside>

        <div className="report-canvas-column">
          <div className="report-canvas-toolbar">
            <span className="report-canvas-label">
              {settings.title || "Untitled report"}
            </span>
            <span className="report-canvas-meta">
              {blocks.length} block{blocks.length === 1 ? "" : "s"} · {pageSetup.pageSize}{" "}
              {pageSetup.orientation}
            </span>
          </div>
          <div className="report-page">
            <BlockCanvas
              blocks={blocks}
              selectedBlockId={selectedBlockId}
              disabled={busy}
              runData={previewData}
              onSelect={setSelectedBlockId}
              onMoveBlock={(index, direction) =>
                setBlocks((previous) => moveBlockInList(previous, index, direction))
              }
              onReorderBlock={(from, to) =>
                setBlocks((previous) => moveBlockToIndex(previous, from, to))
              }
              onRemoveBlock={(index) =>
                setBlocks((previous) => removeBlockFromList(previous, index))
              }
              onRefreshBlock={(index) =>
                setBlocks((previous) => refreshBlockInList(previous, index))
              }
              onRevertBlock={(index) =>
                setBlocks((previous) => revertBlockInList(previous, index))
              }
            />
          </div>
        </div>

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
          className="report-preview-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Report preview"
          data-testid="preview-dialog"
        >
          <div className="report-preview-panel">
            <header className="report-preview-header">
              <h2>Report preview</h2>
              <button
                type="button"
                className="report-control-button"
                aria-label="Close preview"
                onClick={() => setPreviewOpen(false)}
              >
                ✕
              </button>
            </header>
            {previewUrl !== null ? (
              <iframe
                className="report-preview-frame"
                title="Report PDF preview"
                data-testid="preview-frame"
                src={previewUrl}
              />
            ) : null}
            <footer className="report-preview-actions">
              {previewUrl !== null ? (
                <a
                  className="report-button"
                  data-testid="preview-download"
                  href={previewUrl}
                  download={`${templateName || "report"}.pdf`}
                >
                  Download
                </a>
              ) : null}
              <button
                type="button"
                className="report-button"
                data-testid="preview-close"
                onClick={() => setPreviewOpen(false)}
              >
                Close
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </main>
  );
}
