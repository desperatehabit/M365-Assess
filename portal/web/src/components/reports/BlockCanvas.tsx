import { BLOCK_TYPES, type BlockType } from "@m365-assess/contracts/reports";
import BlockControls from "./BlockControls";

// Block shapes mirror the T-0081 contract in portal/contracts/src/reports.ts so
// the builder and the renderer reject the same unknown types at the boundary.
// T-0923 appends the data-bound block types; the list stays in contract order so
// stored documents keep their ordering and the canvas can add every type.
export const V1_BLOCK_TYPES = BLOCK_TYPES;

export type V1BlockType = BlockType;

export interface ReportBlock {
  readonly id: string;
  readonly type: V1BlockType;
  readonly title: string;
  readonly isStatic: boolean;
  readonly dataBinding?: { readonly entity: string; readonly field?: string };
  readonly settings: Record<string, unknown>;
}

export function isV1BlockType(value: unknown): value is V1BlockType {
  return (
    typeof value === "string" &&
    (V1_BLOCK_TYPES as readonly string[]).includes(value)
  );
}

export const BLOCK_TYPE_LABELS: Readonly<Record<V1BlockType, string>> = {
  chart: "Chart",
  "score-cards": "Score cards",
  "progress-bars": "Progress bars",
  "section-divider": "Section divider",
  "page-break": "Page break",
  "rich-text": "Rich text",
  "findings-table": "Findings table",
  "framework-coverage": "Framework coverage",
  "secure-score-trend": "Secure score trend",
  "top-risks": "Top risks",
  "remediation-progress": "Remediation progress",
  "tenant-summary": "Tenant summary",
  "run-comparison": "Run comparison / drift",
};

export const BLOCK_TYPE_DESCRIPTIONS: Readonly<Record<V1BlockType, string>> = {
  chart: "Plot a findings series.",
  "score-cards": "Headline metrics as cards.",
  "progress-bars": "Compare metric completion.",
  "section-divider": "Open a new report section.",
  "page-break": "Start a new page.",
  "rich-text": "Analyst narrative and notes.",
  "findings-table": "Run findings filtered by status, severity or section.",
  "framework-coverage": "Pass/fail coverage per compliance framework.",
  "secure-score-trend": "Secure score across recent snapshots.",
  "top-risks": "The highest-severity failed findings.",
  "remediation-progress": "Remediation counts grouped by status, severity or section.",
  "tenant-summary": "Tenant and run identity facts.",
  "run-comparison": "Current run against a baseline, with drift deltas.",
};

export const BLOCK_PALETTE_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly types: readonly V1BlockType[];
}> = [
  {
    label: "Data-bound blocks",
    types: [
      "findings-table",
      "framework-coverage",
      "secure-score-trend",
      "top-risks",
      "remediation-progress",
      "tenant-summary",
      "run-comparison",
      "score-cards",
      "progress-bars",
      "chart",
    ],
  },
  {
    label: "Layout & content",
    types: ["section-divider", "page-break", "rich-text"],
  },
];

let blockSequence = 0;

export function createBlock(type: V1BlockType, title?: string): ReportBlock {
  blockSequence += 1;
  const id = `block-${Date.now().toString(36)}-${blockSequence}`;
  const label = title ?? `New ${type}`;
  switch (type) {
    case "chart":
      return {
        id,
        type,
        title: label,
        isStatic: false,
        dataBinding: { entity: "findings" },
        settings: { chartKind: "bar", series: [] },
      };
    case "score-cards":
      return {
        id,
        type,
        title: label,
        isStatic: false,
        dataBinding: { entity: "secure-score" },
        settings: { metrics: [], columns: 3 },
      };
    case "progress-bars":
      return {
        id,
        type,
        title: label,
        isStatic: false,
        dataBinding: { entity: "compliance" },
        settings: { metrics: [], showPercentages: true },
      };
    case "section-divider":
      return { id, type, title: label, isStatic: true, settings: {} };
    case "page-break":
      return { id, type, title: label, isStatic: true, settings: {} };
    case "rich-text":
      return {
        id,
        type,
        title: label,
        isStatic: true,
        settings: { body: "" },
      };
    case "findings-table":
      return {
        id,
        type,
        title: label,
        isStatic: false,
        dataBinding: { entity: "findings" },
        settings: { statuses: [], severities: [], sections: [], limit: 25 },
      };
    case "framework-coverage":
      return {
        id,
        type,
        title: label,
        isStatic: false,
        dataBinding: { entity: "compliance" },
        settings: { frameworks: [], showGaps: true },
      };
    case "secure-score-trend":
      return {
        id,
        type,
        title: label,
        isStatic: false,
        dataBinding: { entity: "secure-score" },
        settings: { points: 6, includeTarget: true },
      };
    case "top-risks":
      return {
        id,
        type,
        title: label,
        isStatic: false,
        dataBinding: { entity: "findings" },
        settings: { limit: 5, minSeverity: "high" },
      };
    case "remediation-progress":
      return {
        id,
        type,
        title: label,
        isStatic: false,
        dataBinding: { entity: "findings" },
        settings: { groupBy: "status", showPercentages: true },
      };
    case "tenant-summary":
      return {
        id,
        type,
        title: label,
        isStatic: false,
        dataBinding: { entity: "run-summary" },
        settings: { fields: ["displayName", "defaultDomain", "status"] },
      };
    case "run-comparison":
      return {
        id,
        type,
        title: label,
        isStatic: false,
        dataBinding: { entity: "run-summary" },
        settings: { mode: "drift", showUnchanged: false },
      };
  }
}

export function moveBlockInList(
  blocks: readonly ReportBlock[],
  index: number,
  direction: -1 | 1,
): ReportBlock[] {
  const target = index + direction;
  if (index < 0 || index >= blocks.length || target < 0 || target >= blocks.length) {
    return [...blocks];
  }
  return moveBlockToIndex(blocks, index, target);
}

/** Drag-and-drop reorder and the "move to top/bottom" controls share this. */
export function moveBlockToIndex(
  blocks: readonly ReportBlock[],
  from: number,
  to: number,
): ReportBlock[] {
  if (
    from < 0 ||
    from >= blocks.length ||
    to < 0 ||
    to >= blocks.length ||
    from === to
  ) {
    return [...blocks];
  }
  const next = [...blocks];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function removeBlockFromList(
  blocks: readonly ReportBlock[],
  index: number,
): ReportBlock[] {
  if (index < 0 || index >= blocks.length) return [...blocks];
  return blocks.filter((_, i) => i !== index);
}

// Refresh captures the live binding into a static snapshot; revert drops the
// snapshot so the block renders live data again at the next render.
export function refreshBlockInList(
  blocks: readonly ReportBlock[],
  index: number,
): ReportBlock[] {
  return blocks.map((block, i) =>
    i === index ? { ...block, isStatic: true } : block,
  );
}

export function revertBlockInList(
  blocks: readonly ReportBlock[],
  index: number,
): ReportBlock[] {
  return blocks.map((block, i) =>
    i === index && block.dataBinding !== undefined
      ? { ...block, isStatic: false }
      : block,
  );
}

// ─── Live run preview data ────────────────────────────────────────────────────

export interface RunPreviewFinding {
  readonly status?: string | null;
  readonly severity?: string | null;
  readonly category?: string | null;
  readonly section?: string | null;
  readonly collector?: string | null;
  readonly controlName?: string | null;
  readonly checkId?: string | null;
  readonly currentValue?: string | null;
  readonly recommendedValue?: string | null;
  readonly remediation?: string | null;
  readonly frameworkRefs?: readonly string[];
}

export interface RunPreviewRun {
  readonly id?: string;
  readonly tenantId?: string;
  readonly tenantDisplayName?: string | null;
  readonly status?: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly summaryCounts?: Record<string, unknown> | null;
}

export interface RunPreviewScorePoint {
  readonly at?: string;
  readonly current?: number;
  readonly max?: number;
  readonly percentage?: number;
}

export interface RunPreviewData {
  readonly run?: RunPreviewRun;
  readonly baselineRun?: RunPreviewRun;
  readonly findings?: readonly RunPreviewFinding[];
  readonly secureScore?: {
    readonly current?: number;
    readonly max?: number;
    readonly percentage?: number;
    readonly history?: readonly RunPreviewScorePoint[];
  };
}

const SEVERITY_RANK: Readonly<Record<string, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sectionOf(finding: RunPreviewFinding): string {
  return finding.section ?? finding.category ?? finding.collector ?? "Unsectioned";
}

export function filterPreviewFindings(
  block: ReportBlock,
  findings: readonly RunPreviewFinding[],
): RunPreviewFinding[] {
  const settings = block.settings;
  const statuses = stringArray(settings["statuses"]).map((value) => value.toLowerCase());
  const severities = stringArray(settings["severities"]).map((value) => value.toLowerCase());
  const sections = stringArray(settings["sections"]).map((value) => value.toLowerCase());
  const limit =
    typeof settings["limit"] === "number" && Number.isFinite(settings["limit"])
      ? Math.max(1, Math.trunc(settings["limit"]))
      : undefined;
  const filtered = findings.filter((finding) => {
    if (statuses.length > 0 && !statuses.includes(lower(finding.status))) return false;
    if (severities.length > 0 && !severities.includes(lower(finding.severity))) return false;
    if (
      sections.length > 0 &&
      !sections.some((section) =>
        [finding.section, finding.category, finding.collector]
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

function countBy(
  findings: readonly RunPreviewFinding[],
  key: "status" | "severity" | "section",
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const label =
      key === "status"
        ? finding.status ?? "Unknown"
        : key === "severity"
          ? finding.severity ?? "Unrated"
          : sectionOf(finding);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function percent(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

function summaryNumber(
  run: RunPreviewRun | undefined,
  key: string,
  fallback = 0,
): number {
  const value = run?.summaryCounts?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function renderFindingsTable(
  block: ReportBlock,
  data: RunPreviewData | undefined,
) {
  const findings = data?.findings ?? [];
  if (findings.length === 0) {
    return (
      <p className="report-block-hint">
        Live findings load from the selected run.
      </p>
    );
  }
  const rows = filterPreviewFindings(block, findings);
  if (rows.length === 0) {
    return (
      <p className="report-block-hint">No findings match the selected filters.</p>
    );
  }
  return (
    <table className="report-preview-table">
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Severity</th>
          <th scope="col">Section</th>
          <th scope="col">Finding</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 5).map((finding, index) => (
          <tr key={`${finding.controlName ?? finding.checkId ?? "finding"}-${index}`}>
            <td>{finding.status ?? "—"}</td>
            <td>{finding.severity ?? "—"}</td>
            <td>{sectionOf(finding)}</td>
            <td>{finding.controlName ?? finding.checkId ?? "Finding"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderFrameworkCoverage(
  block: ReportBlock,
  data: RunPreviewData | undefined,
) {
  const findings = data?.findings ?? [];
  if (findings.length === 0) {
    return (
      <p className="report-block-hint">
        Framework coverage is resolved from the selected run.
      </p>
    );
  }
  const configured = stringArray(block.settings["frameworks"]).map((value) =>
    value.toLowerCase(),
  );
  const groups = new Map<string, RunPreviewFinding[]>();
  const hasFrameworkRefs = findings.some(
    (finding) => (finding.frameworkRefs ?? []).length > 0,
  );
  for (const finding of findings) {
    const labels = hasFrameworkRefs
      ? (finding.frameworkRefs ?? []).map((ref) => ref.split(/\s+/)[0] ?? ref)
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
  return (
    <ul className="report-progress-list">
      {rows.map(([section, items]) => {
        const pass = items.filter((item) => lower(item.status) === "pass").length;
        return (
          <li key={section} className="report-progress-row">
            <span className="report-progress-label">{section}</span>
            <span className="report-progress-track" aria-hidden="true">
              <span
                className="report-progress-fill"
                style={{ width: `${percent(pass, items.length)}%` }}
              />
            </span>
            <span className="report-progress-value">
              {percent(pass, items.length)}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function renderSecureScoreTrend(block: ReportBlock, data: RunPreviewData | undefined) {
  const history = data?.secureScore?.history ?? [];
  if (history.length > 0) {
    const points =
      typeof block.settings["points"] === "number"
        ? history.slice(-Math.max(1, Math.trunc(block.settings["points"])))
        : history;
    return (
      <ol className="report-score-points">
        {points.map((point, index) => {
          const pct =
            typeof point.percentage === "number"
              ? point.percentage
              : percent(point.current ?? 0, point.max ?? 100);
          return (
            <li key={`${point.at ?? "point"}-${index}`}>
              <span className="report-score-point-date">{point.at ?? "Snapshot"}</span>
              <span className="report-progress-track" aria-hidden="true">
                <span
                  className="report-progress-fill"
                  style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                />
              </span>
              <span className="report-progress-value">{Math.round(pct)}%</span>
            </li>
          );
        })}
      </ol>
    );
  }
  if (data?.findings === undefined || data.findings.length === 0) {
    return (
      <p className="report-block-hint">
        Secure score history is resolved from the selected run.
      </p>
    );
  }
  const pass = data.findings.filter((finding) => lower(finding.status) === "pass").length;
  const score = percent(pass, data.findings.length);
  return (
    <div className="report-score-trend">
      <div className="report-score-value">{score}%</div>
      <div className="report-progress-track" aria-hidden="true">
        <div className="report-progress-fill" style={{ width: `${score}%` }} />
      </div>
      <p className="report-block-hint">
        Latest run · {pass} of {data.findings.length} controls passing
      </p>
    </div>
  );
}

function renderTopRisks(block: ReportBlock, data: RunPreviewData | undefined) {
  const limit =
    typeof block.settings["limit"] === "number"
      ? Math.max(1, Math.trunc(block.settings["limit"]))
      : 5;
  const minSeverity = lower(block.settings["minSeverity"]);
  const minimum = minSeverity === "" ? Number.POSITIVE_INFINITY : SEVERITY_RANK[minSeverity] ?? 4;
  const risks = (data?.findings ?? [])
    .filter((finding) => {
      const status = lower(finding.status);
      if (status !== "fail" && status !== "warning") return false;
      return (SEVERITY_RANK[lower(finding.severity)] ?? 4) <= minimum;
    })
    .sort(
      (a, b) =>
        (SEVERITY_RANK[lower(a.severity)] ?? 4) -
        (SEVERITY_RANK[lower(b.severity)] ?? 4),
    )
    .slice(0, limit);
  if (risks.length === 0) {
    return (
      <p className="report-block-hint">
        Top risks appear once the selected run has failed findings.
      </p>
    );
  }
  return (
    <ol className="report-risk-list">
      {risks.map((risk, index) => (
        <li key={`${risk.controlName ?? risk.checkId ?? "risk"}-${index}`}>
          <span className="report-risk-severity">{risk.severity ?? "—"}</span>
          <span>{risk.controlName ?? risk.checkId ?? "Finding"}</span>
        </li>
      ))}
    </ol>
  );
}

function renderRemediationProgress(
  block: ReportBlock,
  data: RunPreviewData | undefined,
) {
  const findings = data?.findings ?? [];
  if (findings.length === 0) {
    return (
      <p className="report-block-hint">
        Remediation progress is resolved from the selected run.
      </p>
    );
  }
  const groupBy = block.settings["groupBy"];
  const key = groupBy === "severity" || groupBy === "section" ? groupBy : "status";
  const rows = countBy(findings, key);
  return (
    <ul className="report-progress-list">
      {rows.map((row) => (
        <li key={row.label} className="report-progress-row">
          <span className="report-progress-label">{row.label}</span>
          <span className="report-progress-track" aria-hidden="true">
            <span
              className="report-progress-fill"
              style={{ width: `${percent(row.count, findings.length)}%` }}
            />
          </span>
          <span className="report-progress-value">
            {block.settings["showPercentages"] === false
              ? row.count
              : `${percent(row.count, findings.length)}%`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function renderTenantSummary(block: ReportBlock, data: RunPreviewData | undefined) {
  const run = data?.run;
  if (run === undefined) {
    return (
      <p className="report-block-hint">
        Tenant facts are resolved from the selected run.
      </p>
    );
  }
  const facts: Array<[string, string]> = [
    ["Tenant", run.tenantDisplayName ?? run.tenantId ?? "—"],
    ["Run", run.id ?? "—"],
    ["Status", run.status ?? "—"],
    ["Started", run.startedAt ?? "—"],
    ["Finished", run.finishedAt ?? "—"],
  ];
  const configured = stringArray(block.settings["fields"]);
  const shown =
    configured.length === 0
      ? facts
      : facts.filter(([label]) =>
          configured.some((field) => field.toLowerCase() === label.toLowerCase()),
        );
  return (
    <dl className="report-facts">
      {shown.map(([label, value]) => (
        <div key={label} className="report-fact">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function renderRunComparison(block: ReportBlock, data: RunPreviewData | undefined) {
  const current = data?.run;
  const baseline = data?.baselineRun;
  if (current === undefined) {
    return (
      <p className="report-block-hint">
        Select two runs to compare findings and drift.
      </p>
    );
  }
  if (baseline === undefined) {
    return (
      <p className="report-block-hint">
        No baseline run is available yet; the report will compare against the
        previous completed run.
      </p>
    );
  }
  const metrics = ["pass", "fail", "warning"] as const;
  const showUnchanged = block.settings["showUnchanged"] !== false;
  const rows = metrics
    .map((metric) => ({
      metric,
      current: summaryNumber(current, metric),
      baseline: summaryNumber(baseline, metric),
    }))
    .map((row) => ({ ...row, delta: row.current - row.baseline }))
    .filter((row) => showUnchanged || row.delta !== 0);
  return (
    <table className="report-preview-table">
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col">Current</th>
          <th scope="col">Baseline</th>
          <th scope="col">Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.metric}>
            <td>{row.metric}</td>
            <td>{row.current}</td>
            <td>{row.baseline}</td>
            <td className={row.delta === 0 ? "" : row.delta > 0 ? "delta-up" : "delta-down"}>
              {row.delta > 0 ? `+${row.delta}` : row.delta}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function describeBinding(block: ReportBlock): string {
  if (block.isStatic) return "Static content";
  return `Live: ${block.dataBinding?.entity ?? "unbound"}`;
}

function renderBlockBody(block: ReportBlock, data: RunPreviewData | undefined) {
  switch (block.type) {
    case "chart":
      return (
        <p className="report-block-hint">
          Chart ({String(block.settings["chartKind"] ?? "bar")}) ·{" "}
          {describeBinding(block)}
        </p>
      );
    case "score-cards": {
      const metrics = (block.settings["metrics"] as string[] | undefined) ?? [];
      return (
        <p className="report-block-hint">
          Score cards: {metrics.length > 0 ? metrics.join(", ") : "no metrics"} ·{" "}
          {describeBinding(block)}
        </p>
      );
    }
    case "progress-bars": {
      const metrics = (block.settings["metrics"] as string[] | undefined) ?? [];
      return (
        <p className="report-block-hint">
          Progress bars: {metrics.length > 0 ? metrics.join(", ") : "no metrics"} ·{" "}
          {describeBinding(block)}
        </p>
      );
    }
    case "section-divider":
      return <hr className="report-section-divider" aria-label="Section divider" />;
    case "page-break":
      return (
        <p className="report-block-hint" aria-label="Page break">
          — Page break —
        </p>
      );
    case "rich-text":
      return (
        <p className="report-rich-text">
          {String(block.settings["body"] ?? "") || "Empty text block"}
        </p>
      );
    case "findings-table":
      return renderFindingsTable(block, data);
    case "framework-coverage":
      return renderFrameworkCoverage(block, data);
    case "secure-score-trend":
      return renderSecureScoreTrend(block, data);
    case "top-risks":
      return renderTopRisks(block, data);
    case "remediation-progress":
      return renderRemediationProgress(block, data);
    case "tenant-summary":
      return renderTenantSummary(block, data);
    case "run-comparison":
      return renderRunComparison(block, data);
  }
}

export interface BlockCanvasProps {
  readonly blocks: readonly ReportBlock[];
  readonly selectedBlockId?: string | null;
  readonly disabled?: boolean;
  readonly runData?: RunPreviewData;
  readonly onSelect?: (blockId: string) => void;
  readonly onMoveBlock: (index: number, direction: -1 | 1) => void;
  readonly onReorderBlock?: (from: number, to: number) => void;
  readonly onRemoveBlock: (index: number) => void;
  readonly onRefreshBlock: (index: number) => void;
  readonly onRevertBlock: (index: number) => void;
}

export default function BlockCanvas({
  blocks,
  selectedBlockId = null,
  disabled = false,
  runData,
  onSelect,
  onMoveBlock,
  onReorderBlock,
  onRemoveBlock,
  onRefreshBlock,
  onRevertBlock,
}: BlockCanvasProps) {
  if (blocks.length === 0) {
    return (
      <section
        className="report-canvas report-canvas-empty"
        aria-label="Report canvas"
        data-testid="report-canvas-empty"
      >
        <p className="report-canvas-empty-title">Start the report</p>
        <p>
          Add a block from the palette on the left, or pick a starter template
          above. Blocks can be dragged into order.
        </p>
      </section>
    );
  }

  return (
    <section
      className="report-canvas"
      aria-label="Report canvas"
      data-testid="report-canvas"
    >
      {blocks.map((block, index) => {
        const selected = block.id === selectedBlockId;
        return (
          <article
            key={block.id}
            className={`report-block${selected ? " selected" : ""}`}
            data-testid={`report-block-${block.id}`}
            data-block-type={block.type}
            aria-label={`${BLOCK_TYPE_LABELS[block.type]} block: ${block.title}`}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            tabIndex={0}
            draggable={!disabled && onReorderBlock !== undefined}
            onClick={() => onSelect?.(block.id)}
            onKeyDown={(event) => {
              if (!event.altKey) return;
              if (event.key === "ArrowUp") {
                event.preventDefault();
                onMoveBlock(index, -1);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                onMoveBlock(index, 1);
              }
            }}
            onDragStart={(event) => {
              if (disabled || onReorderBlock === undefined) return;
              event.dataTransfer?.setData("text/plain", String(index));
              if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (disabled || onReorderBlock === undefined) return;
              event.preventDefault();
              if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              if (disabled || onReorderBlock === undefined) return;
              event.preventDefault();
              const from = Number(event.dataTransfer?.getData("text/plain"));
              if (Number.isInteger(from)) onReorderBlock(from, index);
            }}
          >
            <header className="report-block-header">
              <span className="report-block-drag" aria-hidden="true" title="Drag to reorder">
                ⠿
              </span>
              <h3>{block.title}</h3>
              <span className="report-block-type">
                {BLOCK_TYPE_LABELS[block.type]}
              </span>
              <span
                className={`report-block-binding${block.isStatic ? "" : " live"}`}
              >
                {describeBinding(block)}
              </span>
            </header>
            <div className="report-block-body">{renderBlockBody(block, runData)}</div>
            <BlockControls
              blockId={block.id}
              blockTitle={block.title}
              isFirst={index === 0}
              isLast={index === blocks.length - 1}
              isLive={!block.isStatic}
              canRevert={block.dataBinding !== undefined}
              disabled={disabled}
              onMoveUp={() => onMoveBlock(index, -1)}
              onMoveDown={() => onMoveBlock(index, 1)}
              onRemove={() => onRemoveBlock(index)}
              onRefresh={() => onRefreshBlock(index)}
              onRevert={() => onRevertBlock(index)}
            />
          </article>
        );
      })}
    </section>
  );
}
