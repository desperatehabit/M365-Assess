"use client";

// Run detail tabs component (EPIC-003 SPEC.md §3.3, §4.3, §4.4, T-0052).
// Renders Progress, Summary, Findings, Remediation, Artifacts, and Issues.
// Supports status-gated Cancel and Retry actions, artifact downloads via T-0048,
// and progress streaming. T-0925 adds the finding drawer, bulk remediation, and
// the run-scoped Remediation tab. Report theme tokens only with zero colour literals.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { useRunEvents } from "../lib/useRunEvents";
import { getRunStatusLabel } from "./RunsTable";
import type { ProgressEvent } from "@m365-assess/contracts/events";
import { ApplyActionDialog } from "./remediation/ApplyActionDialog";
import { FindingRemediationPanel } from "./remediation/FindingRemediationPanel";
import {
  fetchRemediationHistory,
  fetchRemediationPlan,
  generateRemediationPlan,
  waitForRemediationPlan,
  type RemediationActionItem,
  type RemediationHistoryRow,
  type RemediationPlanResponse,
} from "../lib/remediationApi";

export type RunDetailTabId =
  | "progress"
  | "summary"
  | "findings"
  | "remediation"
  | "artifacts"
  | "issues";

export interface RunSectionDetail {
  readonly id?: string;
  readonly runId?: string;
  readonly tenantId?: string;
  readonly section: string;
  readonly collector?: string | null;
  readonly status: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly completed?: number;
  readonly total?: number;
  readonly message?: string;
  readonly checks?: readonly { id: string; message: string; at?: string }[];
}

export interface RunFindingDetail {
  readonly id: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly status: string; // Pass, Fail, Warning, Review, Skipped, NotLicensed
  readonly severity?: string | null; // Critical, High, Medium, Low
  readonly category?: string | null;
  readonly collector?: string | null;
  readonly controlName?: string | null;
  readonly currentValue?: string | null;
  readonly recommendedValue?: string | null;
  readonly checkId?: string | null;
  readonly evidence?: unknown;
  readonly frameworkRefs?: readonly string[];
  readonly remediationMode?: string | null;
  readonly [key: string]: unknown;
}

export interface RunArtifactDetail {
  readonly name: string;
  readonly path?: string;
  readonly contentType: string;
  readonly size: number;
  readonly redacted?: boolean;
  readonly isRedacted?: boolean;
  readonly extension?: string;
  readonly mtime?: string;
}

export interface RunIssueDetail {
  readonly id?: string;
  readonly timestamp?: string;
  readonly level?: "INFO" | "WARNING" | "ERROR" | string;
  readonly section?: string | null;
  readonly collector?: string | null;
  readonly message: string;
  readonly exception?: string | null;
}

export interface RunSummaryCounts {
  readonly pass: number;
  readonly fail: number;
  readonly warning: number;
  readonly review: number;
  readonly info?: number;
  readonly skipped: number;
  readonly notLicensed: number;
  readonly total: number;
}

export interface RunDetailData {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantDisplayName?: string | null;
  readonly parentRunId?: string | null;
  readonly trigger: string;
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "partial" | string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly sections?: readonly RunSectionDetail[];
  readonly summaryCounts?: RunSummaryCounts | null;
  /** Issue-log entry count from the run detail response (T-0929). */
  readonly issueCount?: number;
  readonly options?: Record<string, unknown> | null;
  readonly artifactPath?: string | null;
  readonly children?: readonly RunDetailData[];
}

export interface RunDetailTabsProps {
  /** Run details */
  readonly run: RunDetailData;
  /** Finding records from /v1/runs/:runId/results */
  readonly findings?: readonly RunFindingDetail[];
  /** Artifacts from /v1/runs/:runId/artifacts */
  readonly artifacts?: readonly RunArtifactDetail[];
  /** Issue log from /v1/runs/:runId/results */
  readonly issues?: readonly RunIssueDetail[];
  /** Controlled active tab */
  readonly activeTab?: RunDetailTabId;
  /** Active tab change callback */
  readonly onTabChange?: (tab: RunDetailTabId) => void;
  /** Default active tab */
  readonly defaultTab?: RunDetailTabId;
  /** Cancel action handler */
  readonly onCancel?: (runId: string) => void | Promise<void>;
  /** Retry action handler */
  readonly onRetry?: (runId: string) => void | Promise<void>;
  /** Artifact download handler */
  readonly onDownloadArtifact?: (runId: string, artifactName: string) => void | Promise<void>;
  /** Whether to stream live progress events */
  readonly streamEvents?: boolean;
  /** Base API URL */
  readonly baseUrl?: string;
  /** Custom class name */
  readonly className?: string;
  /** True when the caller holds `Remediation.Apply` (T-0917). */
  readonly canApply?: boolean;
  /** Plan to open in the Remediation tab (deep link `?planId=`). */
  readonly initialPlanId?: string;
  /** Test seam for the remediation endpoints. */
  readonly fetcher?: typeof fetch;
  /** Reloads the run's findings after a verify or a manual mark. */
  readonly onRefreshResults?: () => void | Promise<void>;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Artifact names are paths relative to the run's artifact folder; the assessment's outputs
// sit in an Assessment_* subfolder (T-0946).
export function artifactBaseName(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash < 0 ? name : name.slice(slash + 1);
}

export function artifactFolder(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash < 0 ? "" : name.slice(0, slash);
}

export function isHtmlArtifact(name: string): boolean {
  return /\.html?$/i.test(name);
}

/** The assessment's HTML report, if the run published one. */
export function findReportArtifact(artifacts: readonly RunArtifactDetail[]): RunArtifactDetail | undefined {
  return (
    artifacts.find((a) => /^_Assessment-Report.*\.html?$/i.test(artifactBaseName(a.name))) ??
    artifacts.find((a) => isHtmlArtifact(a.name))
  );
}

/** Download URL for an artifact; `inline` opens an HTML artifact in the browser (sandboxed by the BFF). */
export function artifactUrl(baseUrl: string, runId: string, name: string, inline = false): string {
  const url = `${baseUrl}/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`;
  return inline ? `${url}?inline=1` : url;
}

export function formatTimestamp(isoString?: string | null): string {
  if (!isoString) return "—";
  try {
    return new Date(isoString).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return isoString;
  }
}

/** Badge colours for a run section; partial means it finished with skips or partial collectors (T-0944). */
export function sectionBadgeTone(status: string): Pick<CSSProperties, "background" | "color" | "border"> {
  switch (status) {
    case "succeeded":
      return { background: "var(--success-soft)", color: "var(--success-text)", border: "1px solid var(--success)" };
    case "failed":
      return { background: "var(--danger-soft)", color: "var(--danger-text)", border: "1px solid var(--danger)" };
    case "partial":
      return { background: "var(--warn-soft)", color: "var(--warn-text)", border: "1px solid var(--warn)" };
    case "running":
      return { background: "var(--accent-soft)", color: "var(--accent-text)", border: "1px solid var(--accent)" };
    default:
      return { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--border)" };
  }
}

export function isRunCancellable(status: string): boolean {
  const s = status.toLowerCase();
  return s === "queued" || s === "running";
}

export function isRunRetryable(status: string, summaryCounts?: RunSummaryCounts | null): boolean {
  const s = status.toLowerCase();
  if (s === "failed" || s === "partial") return true;
  if (s === "succeeded" && summaryCounts && summaryCounts.fail > 0) return true;
  return false;
}

export function calculateComplianceScore(summaryCounts?: RunSummaryCounts | null): number {
  if (!summaryCounts) return 0;
  const evaluated = summaryCounts.pass + summaryCounts.fail + (summaryCounts.warning || 0);
  if (evaluated <= 0) {
    return summaryCounts.pass > 0 ? 100 : 0;
  }
  return Math.round((summaryCounts.pass / evaluated) * 100);
}

// ── T-0925: finding remediation state ────────────────────────────────────────

export type FindingRemediationState = "open" | "remediated" | "verified" | "accepted-risk";

export const REMEDIATION_STATE_LABELS: Record<FindingRemediationState, string> = {
  open: "Open",
  remediated: "Remediated",
  verified: "Verified",
  "accepted-risk": "Accepted risk",
};

/** The check registry id (checkId when the results route supplies it). */
export function findingCheckId(finding: Pick<RunFindingDetail, "id" | "checkId">): string {
  return finding.checkId || finding.id;
}

function baseCheckId(value: string): string {
  return value.replace(/\.\d+$/, "").toLowerCase();
}

/** Matches a finding to an action even across sub-numbered ids (`.1`, `.2`). */
export function sameCheckId(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase() || baseCheckId(left) === baseCheckId(right);
}

/** Statuses that carry a remediation action on the Findings tab. */
export function isRemediableFinding(finding: Pick<RunFindingDetail, "status">): boolean {
  const status = finding.status.toLowerCase();
  return status === "fail" || status === "warning" || status === "review";
}

interface RemediationStateSource {
  readonly state: string;
  readonly result?: Record<string, unknown> | null;
}

function stateFromRecord(record: RemediationStateSource): FindingRemediationState {
  if (record.state.toLowerCase() !== "applied") return "open";
  const verifiedStatus =
    record.result && typeof record.result["verifiedStatus"] === "string"
      ? String(record.result["verifiedStatus"]).toLowerCase()
      : null;
  if (verifiedStatus === "pass") return "verified";
  if (verifiedStatus) return "open";
  return "remediated";
}

/**
 * The finding's remediation state in the run view. A locally recorded mark
 * (manual "Mark as remediated" / "Accept risk") wins, then the plan action,
 * then the tenant action history. A verify that still fails leaves the finding
 * open; a passing verify marks it verified.
 */
export function deriveFindingRemediationState(
  finding: Pick<RunFindingDetail, "id" | "checkId" | "status">,
  actions: readonly RemediationActionItem[] = [],
  history: readonly RemediationHistoryRow[] = [],
  marks: Readonly<Record<string, FindingRemediationState>> = {},
): FindingRemediationState {
  if (finding.status.toLowerCase() === "pass") return "verified";
  const check = findingCheckId(finding);
  const mark = marks[check] ?? marks[check.replace(/\.\d+$/, "")];
  if (mark) return mark;

  const action = actions.find((item) => sameCheckId(item.check, check));
  const actionState = action ? stateFromRecord(action) : "open";
  // An apply/verify recorded in history is newer than a plan action that has
  // not been reloaded yet, so it wins while the action is still planned.
  if (actionState !== "open") return actionState;

  const historyRow = [...history].reverse().find((row) => sameCheckId(row.check, check));
  if (historyRow) return stateFromRecord(historyRow);

  return actionState;
}

export function remediationStateBadgeStyle(state: FindingRemediationState): CSSProperties {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "11px",
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
  switch (state) {
    case "verified":
      return {
        ...base,
        background: "var(--success-soft)",
        color: "var(--success-text)",
        border: "1px solid var(--success)",
      };
    case "remediated":
      return {
        ...base,
        background: "var(--accent-soft)",
        color: "var(--accent-text)",
        border: "1px solid var(--accent)",
      };
    case "accepted-risk":
      return {
        ...base,
        background: "var(--warn-soft)",
        color: "var(--warn-text)",
        border: "1px solid var(--warn)",
      };
    case "open":
    default:
      return {
        ...base,
        background: "var(--danger-soft)",
        color: "var(--danger-text)",
        border: "1px solid var(--danger)",
      };
  }
}

const runCardStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const drawerOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, var(--backdrop, transparent))",
  display: "flex",
  justifyContent: "flex-end",
  zIndex: 45,
};

const drawerStyle: CSSProperties = {
  width: "min(640px, 100vw)",
  height: "100%",
  overflowY: "auto",
  background: "var(--bg-elev)",
  borderLeft: "1px solid var(--border)",
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const drawerButtonStyle: CSSProperties = {
  padding: "6px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
};

const drawerPrimaryButtonStyle: CSSProperties = {
  ...drawerButtonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const drawerDisabledButtonStyle: CSSProperties = {
  ...drawerPrimaryButtonStyle,
  opacity: 0.4,
  cursor: "not-allowed",
};

const drawerFieldLabelStyle: CSSProperties = {
  fontSize: "11px",
  color: "var(--text-soft)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: "4px",
};

const drawerCodeStyle: CSSProperties = {
  margin: 0,
  padding: "10px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: "180px",
  overflowY: "auto",
};

export function RunDetailTabs(props: RunDetailTabsProps): ReactElement {
  const {
    run: initialRun,
    findings = [],
    artifacts = [],
    issues = [],
    activeTab: controlledTab,
    onTabChange,
    defaultTab = "summary",
    onCancel,
    onRetry,
    onDownloadArtifact,
    streamEvents = true,
    baseUrl = "",
    className,
    canApply = false,
    initialPlanId = "",
    fetcher,
    onRefreshResults,
  } = props;

  const [internalTab, setInternalTab] = useState<RunDetailTabId>(defaultTab);
  const currentTab = controlledTab !== undefined ? controlledTab : internalTab;

  const handleSelectTab = useCallback(
    (tab: RunDetailTabId) => {
      if (controlledTab === undefined) {
        setInternalTab(tab);
      }
      onTabChange?.(tab);
    },
    [controlledTab, onTabChange]
  );

  const [run, setRun] = useState<RunDetailData>(initialRun);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [findingSearch, setFindingSearch] = useState("");
  const [findingStatusFilter, setFindingStatusFilter] = useState("all");

  React.useEffect(() => {
    setRun(initialRun);
  }, [initialRun]);

  // Handle live progress events if stream is active and run is running
  const handleProgressEvent = useCallback((event: ProgressEvent) => {
    if (event.runId !== initialRun.id) return;

    setRun((prev) => {
      const nextRun = { ...prev, status: event.state };
      if (event.section) {
        const sections = Array.from(prev.sections || []);
        const sIdx = sections.findIndex((s) => s.section === event.section);
        const checkItem = event.message
          ? { id: event.eventId, message: event.message, at: event.at }
          : undefined;

        if (sIdx >= 0) {
          const s = sections[sIdx];
          sections[sIdx] = {
            ...s,
            status: event.sectionState || s.status,
            completed: event.completed ?? s.completed,
            total: event.total ?? s.total,
            message: event.message ?? s.message,
            checks: checkItem ? [...(s.checks || []), checkItem] : s.checks,
          };
        } else {
          sections.push({
            section: event.section,
            status: event.sectionState || "running",
            completed: event.completed,
            total: event.total,
            message: event.message,
            checks: checkItem ? [checkItem] : [],
          });
        }
        nextRun.sections = sections;
      }
      return nextRun;
    });
  }, [initialRun.id]);

  useRunEvents({
    runId: run.id,
    enabled: streamEvents && isRunCancellable(run.status),
    baseUrl,
    onEvent: handleProgressEvent,
  });

  const toggleSection = (sectionName: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [sectionName]: !prev[sectionName],
    }));
  };

  const handleCancel = async () => {
    if (!onCancel || cancelling) return;
    setCancelling(true);
    try {
      await onCancel(run.id);
    } finally {
      setCancelling(false);
    }
  };

  const handleRetry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry(run.id);
    } finally {
      setRetrying(false);
    }
  };

  const cancellable = isRunCancellable(run.status);
  const retryable = isRunRetryable(run.status, run.summaryCounts);
  const complianceScore = calculateComplianceScore(run.summaryCounts);
  // The detail response exposes the issue count even before /results arrives (T-0929).
  const issueCount = Math.max(issues.length, run.issueCount ?? 0);

  // ── T-0925: finding drawer, bulk selection and run remediation ─────────────
  const [drawerFindingId, setDrawerFindingId] = useState<string | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const [selectedFindingIds, setSelectedFindingIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [planId, setPlanId] = useState(initialPlanId);
  const [plan, setPlan] = useState<RemediationPlanResponse | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly RemediationHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [applyActions, setApplyActions] = useState<readonly RemediationActionItem[] | null>(null);
  const [verifyingActionId, setVerifyingActionId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<string, FindingRemediationState>>({});

  const planStorageKey = `m365_assess_run_plan_${run.id}`;
  const marksStorageKey = `m365_assess_run_marks_${run.id}`;

  // A different run must not inherit the previous run's plan, selection or marks.
  useEffect(() => {
    setPlan(null);
    setHistory([]);
    setHistoryError(null);
    setApplyActions(null);
    setDrawerFindingId(null);
    setSelectedFindingIds(new Set<string>());
    setMarks({});
    setPlanError(null);
    setStatusMessage(null);
  }, [run.id]);

  // Restore the plan id chosen for this run and any locally recorded marks.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const storedPlan = window.sessionStorage.getItem(planStorageKey);
      setPlanId(initialPlanId || storedPlan || "");
      const storedMarks = window.sessionStorage.getItem(marksStorageKey);
      if (storedMarks) {
        const parsed: unknown = JSON.parse(storedMarks);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          setMarks(parsed as Record<string, FindingRemediationState>);
        }
      }
    } catch {
      // Private mode or a quota error: the plan and marks stay for this page only.
    }
  }, [planStorageKey, marksStorageKey, initialPlanId]);

  const rememberPlan = useCallback(
    (id: string) => {
      try {
        window.sessionStorage.setItem(planStorageKey, id);
      } catch {
        // See above.
      }
    },
    [planStorageKey],
  );

  const loadPlan = useCallback(
    async (id: string): Promise<RemediationPlanResponse | null> => {
      if (!id) return null;
      setPlanLoading(true);
      setPlanError(null);
      try {
        const loaded = await fetchRemediationPlan(id, fetcher);
        setPlan(loaded);
        return loaded;
      } catch (err) {
        setPlanError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setPlanLoading(false);
      }
    },
    [fetcher],
  );

  const loadHistory = useCallback(async (): Promise<void> => {
    if (!run.tenantId) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const page = await fetchRemediationHistory(run.tenantId, { limit: 100 }, fetcher);
      setHistory(page.items ?? []);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setHistoryLoading(false);
    }
  }, [run.tenantId, fetcher]);

  const ensurePlan = useCallback(async (): Promise<RemediationPlanResponse | null> => {
    if (plan) return plan;
    if (planId) return await loadPlan(planId);
    setPlanLoading(true);
    setPlanError(null);
    try {
      const created = await generateRemediationPlan(
        { tenantId: run.tenantId, runId: run.id },
        fetcher,
      );
      const loaded = await waitForRemediationPlan(created.planId, fetcher);
      setPlanId(created.planId);
      setPlan(loaded);
      rememberPlan(created.planId);
      return loaded;
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setPlanLoading(false);
    }
  }, [plan, planId, loadPlan, run.tenantId, run.id, fetcher, rememberPlan]);

  // The run's Remediation tab reads the same plan/history routes as the
  // top-level Remediation page, so an action taken in either view is visible.
  useEffect(() => {
    if (currentTab !== "remediation") return;
    void loadHistory();
    if (planId) void loadPlan(planId);
  }, [currentTab, planId, loadHistory, loadPlan]);

  const findingState = useCallback(
    (finding: RunFindingDetail): FindingRemediationState =>
      deriveFindingRemediationState(finding, plan?.actions ?? [], history, marks),
    [plan, history, marks],
  );

  const actionForFinding = useCallback(
    (finding: RunFindingDetail): RemediationActionItem | null => {
      if (!plan) return null;
      const check = findingCheckId(finding);
      return plan.actions.find((action) => sameCheckId(action.check, check)) ?? null;
    },
    [plan],
  );

  const panelActionFor = useCallback(
    (finding: RunFindingDetail): RemediationActionItem | null => {
      const action = actionForFinding(finding);
      if (action) return action;
      if (finding.remediationMode !== "manual") return null;
      return {
        id: `manual-${finding.id}`,
        check: findingCheckId(finding),
        command: "",
        target: null,
        mode: "manual",
        classification: "manual",
        state: "planned",
      };
    },
    [actionForFinding],
  );

  const remediationSummary = useMemo(() => {
    const counts: Record<FindingRemediationState, number> = {
      open: 0,
      remediated: 0,
      verified: 0,
      "accepted-risk": 0,
    };
    let total = 0;
    let done = 0;
    for (const finding of findings) {
      if (!isRemediableFinding(finding)) continue;
      total += 1;
      const state = findingState(finding);
      counts[state] += 1;
      if (state !== "open") done += 1;
    }
    return { counts, total, done, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
  }, [findings, findingState]);

  const runHistory = useMemo(() => {
    if (findings.length === 0) return [];
    return history.filter((row) =>
      findings.some((finding) => sameCheckId(row.check, findingCheckId(finding))),
    );
  }, [history, findings]);

  // Filtered findings list (used by the table and the bulk selection).
  const filteredFindings = useMemo(() => {
    return findings.filter((f) => {
      const matchSearch =
        findingSearch.trim() === "" ||
        (f.controlName && f.controlName.toLowerCase().includes(findingSearch.toLowerCase())) ||
        (f.category && f.category.toLowerCase().includes(findingSearch.toLowerCase()));
      const matchStatus =
        findingStatusFilter === "all" || f.status.toLowerCase() === findingStatusFilter.toLowerCase();
      return matchSearch && matchStatus;
    });
  }, [findings, findingSearch, findingStatusFilter]);

  const selectableFindings = useMemo(
    () => filteredFindings.filter((finding) => isRemediableFinding(finding)),
    [filteredFindings],
  );

  const selectedCount = useMemo(
    () => findings.filter((finding) => selectedFindingIds.has(finding.id)).length,
    [findings, selectedFindingIds],
  );

  const allSelectableSelected =
    selectableFindings.length > 0 &&
    selectableFindings.every((finding) => selectedFindingIds.has(finding.id));

  const toggleFindingSelection = (findingId: string): void => {
    setSelectedFindingIds((previous) => {
      const next = new Set(previous);
      if (next.has(findingId)) next.delete(findingId);
      else next.add(findingId);
      return next;
    });
  };

  const toggleSelectAll = (): void => {
    setSelectedFindingIds((previous) => {
      const next = new Set(previous);
      if (allSelectableSelected) {
        for (const finding of selectableFindings) next.delete(finding.id);
      } else {
        for (const finding of selectableFindings) next.add(finding.id);
      }
      return next;
    });
  };

  const markFinding = (finding: RunFindingDetail, state: FindingRemediationState): void => {
    const check = findingCheckId(finding);
    const keys = check === check.replace(/\.\d+$/, "") ? [check] : [check, check.replace(/\.\d+$/, "")];
    setMarks((previous) => {
      const next = { ...previous };
      for (const key of keys) next[key] = state;
      try {
        window.sessionStorage.setItem(marksStorageKey, JSON.stringify(next));
      } catch {
        // Page-local mark only.
      }
      return next;
    });
    const label = finding.controlName || check;
    setStatusMessage(
      state === "accepted-risk"
        ? `${label} marked as accepted risk.`
        : `${label} marked as remediated.`,
    );
  };

  const openRemediateFor = async (finding: RunFindingDetail): Promise<void> => {
    if (!canApply) {
      setStatusMessage("Applying remediation requires Remediation.Apply.");
      return;
    }
    setStatusMessage(null);
    const loaded = await ensurePlan();
    if (!loaded) return;
    const check = findingCheckId(finding);
    const action = loaded.actions.find((item) => sameCheckId(item.check, check));
    if (!action) {
      setStatusMessage(`No remediation action is defined for ${check}.`);
      return;
    }
    setApplyActions([action]);
  };

  const openRemediateSelected = async (): Promise<void> => {
    if (!canApply) {
      setStatusMessage("Applying remediation requires Remediation.Apply.");
      return;
    }
    const selected = findings.filter(
      (finding) => selectedFindingIds.has(finding.id) && isRemediableFinding(finding),
    );
    if (selected.length === 0) return;
    setStatusMessage(null);
    const loaded = await ensurePlan();
    if (!loaded) return;
    const actions = selected
      .map((finding) => {
        const check = findingCheckId(finding);
        return loaded.actions.find((item) => sameCheckId(item.check, check));
      })
      .filter((action): action is RemediationActionItem => action !== undefined);
    if (actions.length === 0) {
      setStatusMessage("The plan has no remediation actions for the selected findings.");
      return;
    }
    setApplyActions(actions);
  };

  const handleApplied = (): void => {
    if (planId) void loadPlan(planId);
    void loadHistory();
    void onRefreshResults?.();
  };

  const handleVerify = async (
    action: RemediationActionItem,
    finding?: RunFindingDetail,
  ): Promise<void> => {
    setVerifyingActionId(action.id);
    setStatusMessage(null);
    try {
      const send = fetcher ?? fetch;
      const response = await send(
        `/v1/remediation/actions/${encodeURIComponent(action.id)}/verify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section: finding?.category ?? "" }),
        },
      );
      if (!response.ok) {
        let detail = response.statusText;
        try {
          const body = (await response.json()) as { message?: string };
          if (body?.message) detail = body.message;
        } catch {
          // Non-JSON error body; keep the status text.
        }
        throw new Error(`Verification failed: ${response.status} ${detail}`);
      }
      setStatusMessage("Verification queued. The finding updates when the check finishes.");
      if (planId) await loadPlan(planId);
      await loadHistory();
      void onRefreshResults?.();
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifyingActionId(null);
    }
  };

  const refreshRemediation = (): void => {
    if (planId) void loadPlan(planId);
    void loadHistory();
    void onRefreshResults?.();
  };

  const closeDrawer = useCallback(() => {
    setDrawerFindingId(null);
  }, []);

  // Drawer focus trap, Escape to close, and focus restore to the row.
  useEffect(() => {
    if (!drawerFindingId) return undefined;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    drawerCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (document.querySelector('[data-testid="apply-action-dialog"]')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;
      const root = drawerRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [drawerFindingId, closeDrawer]);

  const drawerFinding = drawerFindingId
    ? findings.find((finding) => finding.id === drawerFindingId) ?? null
    : null;
  const drawerAction = drawerFinding ? panelActionFor(drawerFinding) : null;
  const drawerState = drawerFinding ? findingState(drawerFinding) : "open";
  const drawerIsManual =
    drawerFinding?.remediationMode === "manual" ||
    drawerAction?.mode === "manual" ||
    drawerAction?.classification === "manual";

  // Framework rollups calculated from findings
  const frameworkRollup = useMemo(() => {
    const map = new Map<string, { total: number; pass: number }>();
    for (const f of findings) {
      const frameworks = f.frameworkRefs && f.frameworkRefs.length > 0 ? f.frameworkRefs : ["Default Baseline"];
      const isPass = f.status.toLowerCase() === "pass";
      for (const fw of frameworks) {
        const curr = map.get(fw) || { total: 0, pass: 0 };
        curr.total += 1;
        if (isPass) curr.pass += 1;
        map.set(fw, curr);
      }
    }
    return Array.from(map.entries()).map(([framework, stat]) => ({
      framework,
      total: stat.total,
      pass: stat.pass,
      percentage: stat.total > 0 ? Math.round((stat.pass / stat.total) * 100) : 0,
    }));
  }, [findings]);

  return (
    <div
      className={className}
      data-testid="run-detail-tabs-root"
      style={{
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        color: "var(--text)",
        display: "flex",
        flexDirection: "column",
        gap: "24px",
      }}
    >
      {/* Header Bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "16px",
          paddingBottom: "16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "6px" }}>
            <h1
              style={{
                margin: 0,
                fontSize: "24px",
                fontWeight: 700,
                fontFamily: "var(--font-display, var(--font-sans))",
              }}
            >
              {run.tenantDisplayName || run.tenantId}
            </h1>
            <span
              data-testid="run-detail-status-badge"
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px 10px",
                borderRadius: "999px",
                fontSize: "12px",
                fontWeight: 600,
                whiteSpace: "nowrap",
                background:
                  run.status === "succeeded"
                    ? "var(--success-soft)"
                    : run.status === "failed"
                      ? "var(--danger-soft)"
                      : run.status === "partial"
                        ? "var(--warn-soft)"
                        : run.status === "running"
                          ? "var(--accent-soft)"
                          : "var(--surface)",
                color:
                  run.status === "succeeded"
                    ? "var(--success-text)"
                    : run.status === "failed"
                      ? "var(--danger-text)"
                      : run.status === "partial"
                        ? "var(--warn-text)"
                        : run.status === "running"
                          ? "var(--accent-text)"
                          : "var(--text-soft)",
                border:
                  run.status === "succeeded"
                    ? "1px solid var(--success)"
                    : run.status === "failed"
                      ? "1px solid var(--danger)"
                      : run.status === "partial"
                        ? "1px solid var(--warn)"
                        : run.status === "running"
                          ? "1px solid var(--accent)"
                          : "1px solid var(--border)",
              }}
            >
              {getRunStatusLabel(run.status)}
            </span>
            {issueCount > 0 && (
              <button
                type="button"
                data-testid="run-detail-issue-count"
                onClick={() => handleSelectTab("issues")}
                style={{
                  padding: "2px 10px",
                  borderRadius: "999px",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                  background: "var(--surface)",
                  color: "var(--text-soft)",
                  border: "1px solid var(--border)",
                }}
              >
                {issueCount} {issueCount === 1 ? "issue" : "issues"}
              </button>
            )}
          </div>

          <div
            style={{
              fontSize: "13px",
              color: "var(--muted)",
              display: "flex",
              flexWrap: "wrap",
              gap: "16px",
            }}
          >
            <span>
              <strong>Run ID:</strong> <code style={{ fontFamily: "var(--font-mono, monospace)" }}>{run.id}</code>
            </span>
            <span>
              <strong>Trigger:</strong> {run.trigger}
            </span>
            <span>
              <strong>Started:</strong> {formatTimestamp(run.startedAt)}
            </span>
            <span>
              <strong>Finished:</strong> {formatTimestamp(run.finishedAt)}
            </span>
          </div>
        </div>

        {/* Action Buttons: Cancel and Retry */}
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          {cancellable && onCancel && (
            <button
              type="button"
              data-testid="detail-cancel-button"
              onClick={handleCancel}
              disabled={cancelling}
              style={{
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: 600,
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                border: "1px solid var(--danger)",
                borderRadius: "var(--radius, 6px)",
                cursor: cancelling ? "not-allowed" : "pointer",
                opacity: cancelling ? 0.6 : 1,
              }}
            >
              {cancelling ? "Cancelling..." : "Cancel Run"}
            </button>
          )}

          {retryable && onRetry && (
            <button
              type="button"
              data-testid="detail-retry-button"
              onClick={handleRetry}
              disabled={retrying}
              style={{
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: 600,
                background: "var(--accent-soft)",
                color: "var(--accent-text)",
                border: "1px solid var(--accent)",
                borderRadius: "var(--radius, 6px)",
                cursor: retrying ? "not-allowed" : "pointer",
                opacity: retrying ? 0.6 : 1,
              }}
            >
              {retrying ? "Retrying..." : "Retry Failed"}
            </button>
          )}
        </div>
      </div>

      {/* Tabs Navigation */}
      <div
        role="tablist"
        aria-label="Run Detail Tabs"
        style={{
          display: "flex",
          gap: "8px",
          borderBottom: "1px solid var(--border)",
          paddingBottom: "2px",
        }}
      >
        {(
          [
            { id: "summary", label: "Summary" },
            { id: "progress", label: "Progress" },
            { id: "findings", label: `Findings (${findings.length})` },
            { id: "remediation", label: "Remediation" },
            { id: "artifacts", label: `Artifacts (${artifacts.length})` },
            { id: "issues", label: `Issues (${issueCount})` },
          ] as const
        ).map((tab) => {
          const isActive = currentTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              id={`tab-${tab.id}`}
              data-testid={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.id}`}
              onClick={() => handleSelectTab(tab.id)}
              style={{
                padding: "8px 16px",
                fontSize: "14px",
                fontWeight: 600,
                color: isActive ? "var(--accent-text)" : "var(--muted)",
                background: isActive ? "var(--accent-soft)" : "transparent",
                border: "none",
                borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                borderRadius: "var(--radius, 6px) var(--radius, 6px) 0 0",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB PANEL 1: Summary */}
      {currentTab === "summary" && (
        <div
          role="tabpanel"
          id="tabpanel-summary"
          aria-labelledby="tab-summary"
          data-testid="tabpanel-summary"
          style={{ display: "flex", flexDirection: "column", gap: "24px" }}
        >
          {/* Top Row: Score Card + KPI Strip */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "240px 1fr",
              gap: "20px",
              alignItems: "stretch",
            }}
          >
            {/* Score Card */}
            <div
              data-testid="summary-score-card"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius, 10px)",
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                textAlign: "center",
                boxShadow: "var(--shadow-card)",
              }}
            >
              <div
                style={{
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "var(--muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  marginBottom: "8px",
                }}
              >
                Compliance Score
              </div>
              <div
                data-testid="score-card-hero"
                style={{
                  fontSize: "52px",
                  fontWeight: 800,
                  lineHeight: 1,
                  background: "var(--accent-grad, var(--accent))",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  color: "var(--accent)",
                  fontFamily: "var(--font-display, var(--font-sans))",
                  margin: "8px 0",
                }}
              >
                {complianceScore}%
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
                {run.summaryCounts?.pass ?? 0} pass / {run.summaryCounts?.total ?? 0} total checks
              </div>
            </div>

            {/* KPI Strip */}
            <div
              className="kpi-strip"
              data-testid="kpi-strip"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(7, 1fr)",
                gap: "12px",
              }}
            >
              {[
                {
                  label: "Pass",
                  count: run.summaryCounts?.pass ?? 0,
                  bg: "var(--success-soft)",
                  color: "var(--success-text)",
                  border: "var(--success)",
                  testId: "kpi-pass",
                },
                {
                  label: "Fail",
                  count: run.summaryCounts?.fail ?? 0,
                  bg: "var(--danger-soft)",
                  color: "var(--danger-text)",
                  border: "var(--danger)",
                  testId: "kpi-fail",
                },
                {
                  label: "Warning",
                  count: run.summaryCounts?.warning ?? 0,
                  bg: "var(--warn-soft)",
                  color: "var(--warn-text)",
                  border: "var(--warn)",
                  testId: "kpi-warning",
                },
                {
                  label: "Review",
                  count: run.summaryCounts?.review ?? 0,
                  bg: "var(--accent-soft)",
                  color: "var(--accent-text)",
                  border: "var(--accent)",
                  testId: "kpi-review",
                },
                {
                  label: "Info",
                  count: run.summaryCounts?.info ?? 0,
                  bg: "var(--surface)",
                  color: "var(--text-soft)",
                  border: "var(--border)",
                  testId: "kpi-info",
                },
                {
                  label: "Skipped",
                  count: run.summaryCounts?.skipped ?? 0,
                  bg: "var(--surface)",
                  color: "var(--muted)",
                  border: "var(--border)",
                  testId: "kpi-skipped",
                },
                {
                  label: "Not Licensed",
                  count: run.summaryCounts?.notLicensed ?? 0,
                  bg: "var(--surface)",
                  color: "var(--accent-text)",
                  border: "var(--border)",
                  testId: "kpi-not-licensed",
                },
              ].map((kpi) => (
                <div
                  key={kpi.label}
                  data-testid={kpi.testId}
                  style={{
                    background: kpi.bg,
                    border: `1px solid ${kpi.border}`,
                    borderRadius: "var(--radius, 8px)",
                    padding: "16px 12px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{
                      fontSize: "24px",
                      fontWeight: 700,
                      color: kpi.color,
                      lineHeight: 1.2,
                    }}
                  >
                    {kpi.count}
                  </div>
                  <div
                    style={{
                      fontSize: "12px",
                      fontWeight: 600,
                      color: kpi.color,
                      marginTop: "4px",
                    }}
                  >
                    {kpi.label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Framework Rollup */}
          <div
            data-testid="framework-rollup"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius, 10px)",
              padding: "20px",
            }}
          >
            <h3 style={{ margin: "0 0 16px 0", fontSize: "16px", fontWeight: 600 }}>Framework Rollup</h3>
            {frameworkRollup.length === 0 ? (
              <div style={{ color: "var(--muted)", fontSize: "13px" }}>
                No framework compliance data available for this run.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {frameworkRollup.map((fw) => (
                  <div key={fw.framework}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: "13px",
                        fontWeight: 500,
                        marginBottom: "4px",
                      }}
                    >
                      <span>{fw.framework}</span>
                      <span>
                        {fw.pass} / {fw.total} passed ({fw.percentage}%)
                      </span>
                    </div>
                    <div
                      style={{
                        height: "8px",
                        background: "var(--track)",
                        borderRadius: "999px",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${fw.percentage}%`,
                          background: "var(--accent)",
                          boxShadow: "var(--bar-glow)",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB PANEL 2: Progress */}
      {currentTab === "progress" && (
        <div
          role="tabpanel"
          id="tabpanel-progress"
          aria-labelledby="tab-progress"
          data-testid="tabpanel-progress"
          style={{ display: "flex", flexDirection: "column", gap: "16px" }}
        >
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius, 10px)",
              padding: "20px",
            }}
          >
            <h3 style={{ margin: "0 0 16px 0", fontSize: "16px", fontWeight: 600 }}>
              Section Progress ({run.sections?.length ?? 0} sections)
            </h3>

            {!run.sections || run.sections.length === 0 ? (
              <div style={{ color: "var(--muted)", fontSize: "14px" }}>No section progress recorded yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {run.sections.map((sec) => {
                  const isExpanded = !!expandedSections[sec.section];
                  const hasChecks = sec.checks && sec.checks.length > 0;

                  return (
                    <div
                      key={sec.section}
                      data-testid={`progress-section-${sec.section}`}
                      style={{
                        background: "var(--bg-elev)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius, 8px)",
                        padding: "12px 16px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <div>
                          <span style={{ fontWeight: 600, fontSize: "14px", color: "var(--text)" }}>
                            {sec.section}
                          </span>
                          {sec.message && (
                            <div style={{ fontSize: "12px", color: "var(--text-soft)", marginTop: "2px" }}>
                              {sec.message}
                            </div>
                          )}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <span
                            style={{
                              padding: "2px 8px",
                              borderRadius: "999px",
                              fontSize: "12px",
                              fontWeight: 600,
                              textTransform: "capitalize",
                              ...sectionBadgeTone(sec.status),
                            }}
                          >
                            {sec.status}
                          </span>

                          {hasChecks && (
                            <button
                              type="button"
                              data-testid={`toggle-checks-${sec.section}`}
                              onClick={() => toggleSection(sec.section)}
                              aria-expanded={isExpanded}
                              style={{
                                background: "transparent",
                                border: "none",
                                color: "var(--accent-text)",
                                fontSize: "12px",
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                            >
                              {isExpanded ? "Hide checks" : `Checks (${sec.checks!.length})`}
                            </button>
                          )}
                        </div>
                      </div>

                      {isExpanded && hasChecks && (
                        <ul
                          data-testid={`checks-list-${sec.section}`}
                          style={{
                            marginTop: "10px",
                            paddingTop: "8px",
                            borderTop: "1px dashed var(--border)",
                            listStyle: "none",
                            paddingLeft: 0,
                            margin: "10px 0 0 0",
                            display: "flex",
                            flexDirection: "column",
                            gap: "6px",
                          }}
                        >
                          {sec.checks!.map((c) => (
                            <li
                              key={c.id}
                              style={{
                                fontSize: "12px",
                                color: "var(--text-soft)",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                              }}
                            >
                              <span style={{ color: "var(--accent)", fontSize: "8px" }}>●</span>
                              <span>{c.message}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB PANEL 3: Findings */}
      {currentTab === "findings" && (
        <div
          role="tabpanel"
          id="tabpanel-findings"
          aria-labelledby="tab-findings"
          data-testid="tabpanel-findings"
          style={{ display: "flex", flexDirection: "column", gap: "16px" }}
        >
          {/* Controls: Search, status filter and bulk remediation */}
          <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder="Search findings by control or category..."
              aria-label="Search findings"
              data-testid="findings-search-input"
              value={findingSearch}
              onChange={(e) => setFindingSearch(e.target.value)}
              style={{
                flex: 1,
                minWidth: "220px",
                padding: "8px 12px",
                background: "var(--input-bg, var(--surface))",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius, 6px)",
                color: "var(--text)",
                fontSize: "14px",
              }}
            />
            <select
              data-testid="findings-status-filter"
              aria-label="Filter findings by status"
              value={findingStatusFilter}
              onChange={(e) => setFindingStatusFilter(e.target.value)}
              style={{
                padding: "8px 12px",
                background: "var(--input-bg, var(--surface))",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius, 6px)",
                color: "var(--text)",
                fontSize: "14px",
              }}
            >
              <option value="all">All statuses</option>
              <option value="fail">Fail</option>
              <option value="pass">Pass</option>
              <option value="warning">Warning</option>
              <option value="review">Review</option>
              <option value="skipped">Skipped</option>
            </select>
            <button
              type="button"
              data-testid="remediate-selected"
              disabled={selectedCount === 0 || !canApply || planLoading}
              title={canApply ? undefined : "Requires Remediation.Apply"}
              onClick={() => void openRemediateSelected()}
              style={
                selectedCount > 0 && canApply
                  ? drawerPrimaryButtonStyle
                  : drawerDisabledButtonStyle
              }
            >
              {planLoading
                ? "Planning…"
                : `Remediate selected${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
            </button>
            {selectedCount > 0 && (
              <button
                type="button"
                data-testid="clear-finding-selection"
                onClick={() => setSelectedFindingIds(new Set<string>())}
                style={drawerButtonStyle}
              >
                Clear selection
              </button>
            )}
            {(run.status === "succeeded" || run.status === "partial") && !(run.children && run.children.length > 0) && (
              <a
                href={`/remediation?tenantId=${encodeURIComponent(run.tenantId)}&runId=${encodeURIComponent(run.id)}`}
                data-testid="plan-remediation-link"
                style={{
                  padding: "8px 14px",
                  border: "1px solid var(--accent)",
                  borderRadius: "var(--radius, 6px)",
                  color: "var(--accent)",
                  fontSize: "14px",
                  fontWeight: 600,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                Plan remediation
              </a>
            )}
          </div>

          {statusMessage && (
            <div role="status" data-testid="findings-status" style={{ fontSize: "13px", color: "var(--text-soft)" }}>
              {statusMessage}
            </div>
          )}
          {planError && (
            <div
              role="alert"
              data-testid="findings-plan-error"
              style={{
                padding: "10px 12px",
                background: "var(--danger-soft)",
                border: "1px solid var(--danger)",
                borderRadius: "var(--radius, 6px)",
                color: "var(--danger-text)",
                fontSize: "13px",
              }}
            >
              {planError}
            </div>
          )}

          {/* Findings Table */}
          {filteredFindings.length === 0 ? (
            <div
              data-testid="findings-empty"
              style={{
                padding: "36px",
                textAlign: "center",
                color: "var(--muted)",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius, 8px)",
              }}
            >
              No findings recorded for this run.
            </div>
          ) : (
            <div
              style={{
                overflowX: "auto",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius, 8px)",
                background: "var(--surface)",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-elev)" }}>
                    <th style={{ padding: "10px 14px", textAlign: "left", width: "32px" }}>
                      <input
                        type="checkbox"
                        aria-label="Select all remediable findings"
                        data-testid="findings-select-all"
                        checked={allSelectableSelected}
                        disabled={selectableFindings.length === 0}
                        onChange={toggleSelectAll}
                      />
                    </th>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>Status</th>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>Severity</th>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>Control</th>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>Category</th>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>Values</th>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>Remediation</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFindings.map((finding) => {
                    const state = findingState(finding);
                    const remediable = isRemediableFinding(finding);
                    const selected = selectedFindingIds.has(finding.id);
                    return (
                      <tr
                        key={finding.id}
                        data-testid={`finding-row-${finding.id}`}
                        tabIndex={0}
                        aria-label={`Open finding ${finding.controlName || finding.id}`}
                        onClick={() => setDrawerFindingId(finding.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setDrawerFindingId(finding.id);
                          }
                        }}
                        style={{
                          borderBottom: "1px solid var(--border)",
                          cursor: "pointer",
                          background: selected
                            ? "var(--accent-soft)"
                            : drawerFindingId === finding.id
                              ? "var(--bg-elev)"
                              : undefined,
                        }}
                      >
                        <td
                          style={{ padding: "10px 14px" }}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select ${finding.controlName || finding.id} for remediation`}
                            data-testid={`finding-select-${finding.id}`}
                            checked={selected}
                            disabled={!remediable}
                            onChange={() => toggleFindingSelection(finding.id)}
                            onKeyDown={(event) => event.stopPropagation()}
                          />
                        </td>
                        <td style={{ padding: "10px 14px" }}>
                          <span
                            style={{
                              padding: "2px 6px",
                              borderRadius: "999px",
                              fontSize: "11px",
                              fontWeight: 600,
                              textTransform: "capitalize",
                              background:
                                finding.status.toLowerCase() === "pass"
                                  ? "var(--success-soft)"
                                  : finding.status.toLowerCase() === "fail"
                                    ? "var(--danger-soft)"
                                    : "var(--warn-soft)",
                              color:
                                finding.status.toLowerCase() === "pass"
                                  ? "var(--success-text)"
                                  : finding.status.toLowerCase() === "fail"
                                    ? "var(--danger-text)"
                                    : "var(--warn-text)",
                              border:
                                finding.status.toLowerCase() === "pass"
                                  ? "1px solid var(--success)"
                                  : finding.status.toLowerCase() === "fail"
                                    ? "1px solid var(--danger)"
                                    : "1px solid var(--warn)",
                            }}
                          >
                            {finding.status}
                          </span>
                        </td>
                        <td style={{ padding: "10px 14px", fontWeight: 600, color: "var(--text-soft)" }}>
                          {finding.severity || "—"}
                        </td>
                        <td style={{ padding: "10px 14px", fontWeight: 500, color: "var(--text)" }}>
                          {finding.controlName || finding.id}
                        </td>
                        <td style={{ padding: "10px 14px", color: "var(--muted)" }}>
                          {finding.category || "General"}
                        </td>
                        <td style={{ padding: "10px 14px", color: "var(--text-soft)", fontSize: "12px" }}>
                          {finding.currentValue && <div>Current: {finding.currentValue}</div>}
                          {finding.recommendedValue && <div>Expected: {finding.recommendedValue}</div>}
                        </td>
                        <td style={{ padding: "10px 14px" }}>
                          <span
                            data-testid={`finding-state-${finding.id}`}
                            style={remediationStateBadgeStyle(state)}
                          >
                            {REMEDIATION_STATE_LABELS[state]}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB PANEL 4: Remediation (T-0925) */}
      {currentTab === "remediation" && (
        <div
          role="tabpanel"
          id="tabpanel-remediation"
          aria-labelledby="tab-remediation"
          data-testid="tabpanel-remediation"
          style={{ display: "flex", flexDirection: "column", gap: "20px" }}
        >
          <div style={runCardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>Remediation progress</h3>
                <div style={{ fontSize: "13px", color: "var(--text-soft)" }}>
                  {remediationSummary.done} of {remediationSummary.total} failing findings resolved
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button type="button" data-testid="remediation-refresh" onClick={refreshRemediation} style={drawerButtonStyle}>
                  Refresh
                </button>
                <button
                  type="button"
                  data-testid="generate-run-plan"
                  disabled={!canApply || planLoading}
                  title={canApply ? undefined : "Requires Remediation.Apply"}
                  onClick={() => void ensurePlan()}
                  style={canApply ? drawerPrimaryButtonStyle : drawerDisabledButtonStyle}
                >
                  {planLoading ? "Loading plan…" : plan ? "Reload plan" : "Generate plan"}
                </button>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: "12px",
              }}
            >
              {(
                [
                  { state: "open", testId: "run-progress-open" },
                  { state: "remediated", testId: "run-progress-remediated" },
                  { state: "verified", testId: "run-progress-verified" },
                  { state: "accepted-risk", testId: "run-progress-accepted-risk" },
                ] as const
              ).map((card) => (
                <div
                  key={card.state}
                  data-testid={card.testId}
                  style={{
                    padding: "12px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius, 8px)",
                    background: "var(--bg-elev)",
                  }}
                >
                  <div style={{ fontSize: "22px", fontWeight: 700 }}>{remediationSummary.counts[card.state]}</div>
                  <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
                    {REMEDIATION_STATE_LABELS[card.state]}
                  </div>
                </div>
              ))}
            </div>

            <div
              role="progressbar"
              aria-label="Remediation progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={remediationSummary.percent}
              data-testid="run-remediation-progressbar"
              style={{ height: "8px", background: "var(--track)", borderRadius: "999px", overflow: "hidden" }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${remediationSummary.percent}%`,
                  background: "var(--accent)",
                }}
              />
            </div>
            <div style={{ fontSize: "12px", color: "var(--text-soft)" }} data-testid="run-progress-percent">
              {remediationSummary.percent}% resolved
            </div>

            {statusMessage && (
              <div role="status" data-testid="remediation-status" style={{ fontSize: "13px", color: "var(--text-soft)" }}>
                {statusMessage}
              </div>
            )}
            {planError && (
              <div role="alert" data-testid="remediation-plan-error" style={{ padding: "10px 12px", background: "var(--danger-soft)", border: "1px solid var(--danger)", borderRadius: "6px", color: "var(--danger-text)", fontSize: "13px" }}>
                {planError}
              </div>
            )}
          </div>

          <div style={runCardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>Run plan</h3>
              <a
                data-testid="open-remediation-page-link"
                href={`/remediation?tenantId=${encodeURIComponent(run.tenantId)}&runId=${encodeURIComponent(run.id)}${
                  planId ? `&planId=${encodeURIComponent(planId)}` : ""
                }`}
                style={{ fontSize: "13px", fontWeight: 600, color: "var(--accent-text)" }}
              >
                Open Remediation page
              </a>
            </div>

            {planLoading && !plan && (
              <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Loading the run's plan…</div>
            )}

            {plan ? (
              <>
                <div style={{ fontSize: "12px", color: "var(--text-soft)", fontFamily: "var(--font-mono, monospace)" }}>
                  Plan {plan.plan.id} · {plan.plan.mode} · created {formatTimestamp(plan.plan.createdAt)}
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table aria-label="Run remediation actions" style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border)" }}>
                        <th style={{ padding: "8px 10px", textAlign: "left" }}>Check</th>
                        <th style={{ padding: "8px 10px", textAlign: "left" }}>Finding</th>
                        <th style={{ padding: "8px 10px", textAlign: "left" }}>Mode</th>
                        <th style={{ padding: "8px 10px", textAlign: "left" }}>State</th>
                        <th style={{ padding: "8px 10px", textAlign: "left" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.actions.map((action) => (
                        <tr key={action.id} data-testid={`run-plan-action-${action.id}`} style={{ borderBottom: "1px solid var(--border)" }}>
                          <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono, monospace)", fontSize: "12px" }}>
                            {action.check}
                          </td>
                          <td style={{ padding: "8px 10px" }}>{action.finding || "—"}</td>
                          <td style={{ padding: "8px 10px" }}>{action.mode}</td>
                          <td style={{ padding: "8px 10px" }}>
                            <span data-testid={`run-plan-state-${action.id}`} style={remediationStateBadgeStyle(stateFromRecord(action))}>
                              {REMEDIATION_STATE_LABELS[stateFromRecord(action)]}
                            </span>
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            <div style={{ display: "inline-flex", gap: "6px", flexWrap: "wrap" }}>
                              {action.mode === "auto" && (
                                <button
                                  type="button"
                                  data-testid={`run-plan-apply-${action.id}`}
                                  disabled={!canApply || action.state !== "planned"}
                                  title={canApply ? undefined : "Requires Remediation.Apply"}
                                  onClick={() => canApply && setApplyActions([action])}
                                  style={canApply && action.state === "planned" ? drawerPrimaryButtonStyle : drawerDisabledButtonStyle}
                                >
                                  Apply
                                </button>
                              )}
                              {action.state === "applied" && (
                                <button
                                  type="button"
                                  data-testid={`run-plan-verify-${action.id}`}
                                  disabled={verifyingActionId === action.id}
                                  onClick={() => void handleVerify(action)}
                                  style={drawerButtonStyle}
                                >
                                  {verifyingActionId === action.id ? "Verifying…" : "Verify"}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              !planLoading && (
                <div data-testid="remediation-no-plan" style={{ color: "var(--text-soft)", fontSize: "13px" }}>
                  No plan for this run yet. Select findings on the Findings tab and choose
                  Remediate selected, or generate a plan.
                </div>
              )
            )}
          </div>

          <div style={runCardStyle}>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>Action history</h3>
            <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
              Actions recorded against this run's findings. The same history backs the Remediation page.
            </div>
            {historyLoading && <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Loading history…</div>}
            {historyError && (
              <div role="alert" style={{ padding: "10px 12px", background: "var(--danger-soft)", border: "1px solid var(--danger)", borderRadius: "6px", color: "var(--danger-text)", fontSize: "13px" }}>
                {historyError}
              </div>
            )}
            {!historyLoading && runHistory.length === 0 ? (
              <div data-testid="run-history-empty" style={{ color: "var(--text-soft)", fontSize: "13px" }}>
                No remediation actions have been recorded for this run.
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table aria-label="Run remediation action history" style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)" }}>
                      <th style={{ padding: "8px 10px", textAlign: "left" }}>Check</th>
                      <th style={{ padding: "8px 10px", textAlign: "left" }}>State</th>
                      <th style={{ padding: "8px 10px", textAlign: "left" }}>When</th>
                      <th style={{ padding: "8px 10px", textAlign: "left" }}>Actor</th>
                      <th style={{ padding: "8px 10px", textAlign: "left" }}>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runHistory.map((row) => (
                      <tr key={row.id} data-testid={`run-history-${row.id}`} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "8px 10px", fontFamily: "var(--font-mono, monospace)", fontSize: "12px" }}>
                          {row.check}
                        </td>
                        <td style={{ padding: "8px 10px" }}>
                          <span data-testid={`run-history-state-${row.id}`} style={remediationStateBadgeStyle(stateFromRecord(row))}>
                            {REMEDIATION_STATE_LABELS[stateFromRecord(row)]}
                          </span>
                        </td>
                        <td style={{ padding: "8px 10px" }}>{formatTimestamp(row.timestamp)}</td>
                        <td style={{ padding: "8px 10px" }}>{row.actor || "—"}</td>
                        <td style={{ padding: "8px 10px" }}>
                          {row.result && typeof row.result["verifiedStatus"] === "string"
                            ? `Verified: ${String(row.result["verifiedStatus"])}`
                            : row.error || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB PANEL 5: Artifacts */}
      {currentTab === "artifacts" && (
        <div
          role="tabpanel"
          id="tabpanel-artifacts"
          aria-labelledby="tab-artifacts"
          data-testid="tabpanel-artifacts"
          style={{ display: "flex", flexDirection: "column", gap: "16px" }}
        >
          {artifacts.length === 0 ? (
            <div
              data-testid="artifacts-empty"
              style={{
                padding: "36px",
                textAlign: "center",
                color: "var(--muted)",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius, 8px)",
              }}
            >
              No artifacts published for this run.
            </div>
          ) : (
            <>
            {(() => {
              const report = findReportArtifact(artifacts);
              if (!report) return null;
              return (
                <div
                  data-testid="artifact-report-bar"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    flexWrap: "wrap",
                    padding: "12px 16px",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius, 8px)",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: "14px", color: "var(--text)" }}>Assessment report</div>
                    <div style={{ fontSize: "12px", color: "var(--muted)", wordBreak: "break-all" }}>
                      {artifactBaseName(report.name)}
                    </div>
                  </div>
                  <a
                    href={artifactUrl(baseUrl, run.id, report.name, true)}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="open-report"
                    style={{
                      padding: "6px 12px",
                      fontSize: "13px",
                      fontWeight: 600,
                      background: "var(--accent)",
                      color: "var(--on-accent)",
                      border: "1px solid var(--accent)",
                      borderRadius: "var(--radius, 6px)",
                      textDecoration: "none",
                    }}
                  >
                    Open report
                  </a>
                </div>
              );
            })()}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                gap: "16px",
              }}
            >
              {artifacts.map((artifact) => {
                const isRedacted = artifact.isRedacted || artifact.redacted;
                const downloadUrl = artifactUrl(baseUrl, run.id, artifact.name);
                const folder = artifactFolder(artifact.name);

                return (
                  <div
                    key={artifact.name}
                    data-testid={`artifact-card-${artifact.name}`}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius, 8px)",
                      padding: "16px",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      gap: "12px",
                      boxShadow: "var(--shadow-card)",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginBottom: "4px",
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: "14px",
                            color: "var(--text)",
                            wordBreak: "break-all",
                          }}
                        >
                          {artifactBaseName(artifact.name)}
                        </span>
                        {isRedacted && (
                          <span
                            data-testid={`artifact-redacted-badge-${artifact.name}`}
                            style={{
                              padding: "1px 6px",
                              borderRadius: "999px",
                              fontSize: "11px",
                              fontWeight: 600,
                              background: "var(--accent-soft)",
                              color: "var(--accent-text)",
                              border: "1px solid var(--accent)",
                            }}
                          >
                            Redacted
                          </span>
                        )}
                      </div>

                      <div
                        style={{
                          fontSize: "12px",
                          color: "var(--muted)",
                          display: "flex",
                          flexDirection: "column",
                          gap: "2px",
                          fontFamily: "var(--font-mono, monospace)",
                        }}
                      >
                        {folder && (
                          <span data-testid={`artifact-folder-${artifact.name}`} style={{ wordBreak: "break-all" }}>
                            Folder: {folder}
                          </span>
                        )}
                        <span data-testid={`artifact-content-type-${artifact.name}`}>
                          Type: {artifact.contentType}
                        </span>
                        <span>Size: {formatFileSize(artifact.size)}</span>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: "8px" }}>
                    {isHtmlArtifact(artifact.name) && (
                      <a
                        href={artifactUrl(baseUrl, run.id, artifact.name, true)}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid={`open-artifact-${artifact.name}`}
                        style={{
                          flex: 1,
                          padding: "6px 12px",
                          fontSize: "13px",
                          fontWeight: 600,
                          background: "transparent",
                          color: "var(--accent-text)",
                          border: "1px solid var(--accent)",
                          borderRadius: "var(--radius, 6px)",
                          textDecoration: "none",
                          textAlign: "center",
                        }}
                      >
                        Open
                      </a>
                    )}
                    <a
                      href={downloadUrl}
                      download={artifactBaseName(artifact.name)}
                      data-testid={`download-artifact-${artifact.name}`}
                      onClick={(e) => {
                        if (onDownloadArtifact) {
                          e.preventDefault();
                          void onDownloadArtifact(run.id, artifact.name);
                        }
                      }}
                      style={{
                        padding: "6px 12px",
                        fontSize: "13px",
                        fontWeight: 600,
                        background: "var(--accent)",
                        color: "var(--on-accent)",
                        border: "1px solid var(--accent)",
                        borderRadius: "var(--radius, 6px)",
                        textDecoration: "none",
                        textAlign: "center",
                        cursor: "pointer",
                        display: "inline-block",
                        flex: 1,
                      }}
                    >
                      Download
                    </a>
                    </div>
                  </div>
                );
              })}
            </div>
            </>
          )}
        </div>
      )}

      {/* TAB PANEL 5: Issues */}
      {currentTab === "issues" && (
        <div
          role="tabpanel"
          id="tabpanel-issues"
          aria-labelledby="tab-issues"
          data-testid="tabpanel-issues"
          style={{ display: "flex", flexDirection: "column", gap: "16px" }}
        >
          {run.status === "partial" && (
            <div
              data-testid="issues-partial-banner"
              style={{
                padding: "12px 16px",
                background: "var(--warn-soft)",
                border: "1px solid var(--warn)",
                borderRadius: "var(--radius, 8px)",
                color: "var(--warn-text)",
                fontSize: "13px",
                fontWeight: 600,
              }}
            >
              This run is partial: some requested sections errored or did not run. The issues below
              explain what did not complete.
            </div>
          )}
          {issues.length === 0 ? (
            <div
              data-testid="issues-empty"
              style={{
                padding: "36px",
                textAlign: "center",
                color: "var(--muted)",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius, 8px)",
              }}
            >
              No issues or errors recorded for this run.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {issues.map((issue, idx) => (
                <div
                  key={issue.id || `issue-${idx}`}
                  data-testid={`issue-item-${idx}`}
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius, 8px)",
                    padding: "16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: "999px",
                          fontSize: "11px",
                          fontWeight: 700,
                          background:
                            issue.level === "ERROR"
                              ? "var(--danger-soft)"
                              : issue.level === "WARNING"
                                ? "var(--warn-soft)"
                                : "var(--surface)",
                          color:
                            issue.level === "ERROR"
                              ? "var(--danger-text)"
                              : issue.level === "WARNING"
                                ? "var(--warn-text)"
                                : "var(--text-soft)",
                          border:
                            issue.level === "ERROR"
                              ? "1px solid var(--danger)"
                              : issue.level === "WARNING"
                                ? "1px solid var(--warn)"
                                : "1px solid var(--border)",
                        }}
                      >
                        {issue.level || "ERROR"}
                      </span>
                      {issue.section && (
                        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-soft)" }}>
                          Section: {issue.section}
                        </span>
                      )}
                    </div>
                    {issue.timestamp && (
                      <span style={{ fontSize: "12px", color: "var(--muted)" }}>
                        {formatTimestamp(issue.timestamp)}
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: "14px", color: "var(--text)", fontWeight: 500 }}>
                    {issue.message}
                  </div>

                  {issue.exception && (
                    <pre
                      style={{
                        margin: "4px 0 0 0",
                        padding: "8px 12px",
                        background: "var(--bg-elev)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius, 6px)",
                        fontSize: "11px",
                        fontFamily: "var(--font-mono, monospace)",
                        color: "var(--danger-text)",
                        overflowX: "auto",
                      }}
                    >
                      {issue.exception}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Finding detail drawer (T-0925): details + remediation panel */}
      {drawerFinding && (
        <div
          style={drawerOverlayStyle}
          data-testid="finding-drawer-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeDrawer();
          }}
        >
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="finding-drawer-title"
            data-testid="finding-drawer"
            style={drawerStyle}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
              <div>
                <h2 id="finding-drawer-title" style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>
                  {drawerFinding.controlName || drawerFinding.id}
                </h2>
                <div style={{ marginTop: "4px", fontSize: "12px", color: "var(--text-soft)", fontFamily: "var(--font-mono, monospace)" }}>
                  {findingCheckId(drawerFinding)}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span data-testid="finding-drawer-state" style={remediationStateBadgeStyle(drawerState)}>
                  {REMEDIATION_STATE_LABELS[drawerState]}
                </span>
                <button ref={drawerCloseRef} type="button" data-testid="finding-drawer-close" onClick={closeDrawer} style={drawerButtonStyle}>
                  Close
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
              <div>
                <div style={drawerFieldLabelStyle}>Current value</div>
                <div data-testid="finding-drawer-current">{drawerFinding.currentValue || "—"}</div>
              </div>
              <div>
                <div style={drawerFieldLabelStyle}>Recommended value</div>
                <div data-testid="finding-drawer-recommended">{drawerFinding.recommendedValue || "—"}</div>
              </div>
            </div>

            <div>
              <div style={drawerFieldLabelStyle}>Evidence</div>
              <pre data-testid="finding-drawer-evidence" style={drawerCodeStyle}>
                {drawerFinding.evidence
                  ? JSON.stringify(drawerFinding.evidence, null, 2)
                  : "No evidence recorded for this finding."}
              </pre>
            </div>

            <div>
              <div style={drawerFieldLabelStyle}>Framework mappings</div>
              <div data-testid="finding-drawer-frameworks" style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {drawerFinding.frameworkRefs && drawerFinding.frameworkRefs.length > 0 ? (
                  drawerFinding.frameworkRefs.map((framework) => (
                    <span
                      key={framework}
                      style={{
                        padding: "2px 8px",
                        borderRadius: "999px",
                        border: "1px solid var(--border)",
                        background: "var(--surface)",
                        fontSize: "12px",
                        color: "var(--text-soft)",
                      }}
                    >
                      {framework}
                    </span>
                  ))
                ) : (
                  <span style={{ fontSize: "13px", color: "var(--text-soft)" }}>No framework mapping recorded.</span>
                )}
              </div>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: "16px" }}>
              <h3 style={{ margin: "0 0 10px", fontSize: "15px", fontWeight: 600 }}>Remediation</h3>
              <FindingRemediationPanel
                check={findingCheckId(drawerFinding)}
                action={drawerAction}
                fetcher={fetcher}
                onCopyPlan={() => setStatusMessage("Remediation plan copied.")}
                onCopySteps={() => setStatusMessage("Manual steps copied.")}
              />
            </div>

            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              {!drawerIsManual && drawerFinding.status.toLowerCase() !== "pass" && (
                <button
                  type="button"
                  data-testid="drawer-remediate"
                  disabled={!canApply || planLoading}
                  title={canApply ? undefined : "Requires Remediation.Apply"}
                  onClick={() => void openRemediateFor(drawerFinding)}
                  style={canApply ? drawerPrimaryButtonStyle : drawerDisabledButtonStyle}
                >
                  {planLoading ? "Planning…" : "Remediate"}
                </button>
              )}
              {!drawerIsManual && drawerAction?.state === "applied" && (
                <button
                  type="button"
                  data-testid="drawer-verify"
                  disabled={verifyingActionId === drawerAction.id}
                  onClick={() => void handleVerify(drawerAction, drawerFinding)}
                  style={drawerButtonStyle}
                >
                  {verifyingActionId === drawerAction.id ? "Verifying…" : "Verify"}
                </button>
              )}
              {drawerIsManual && drawerState !== "remediated" && drawerState !== "verified" && (
                <button
                  type="button"
                  data-testid="drawer-mark-remediated"
                  onClick={() => markFinding(drawerFinding, "remediated")}
                  style={drawerPrimaryButtonStyle}
                >
                  Mark as remediated
                </button>
              )}
              {drawerFinding.status.toLowerCase() !== "pass" && drawerState !== "accepted-risk" && (
                <button
                  type="button"
                  data-testid="drawer-accept-risk"
                  onClick={() => markFinding(drawerFinding, "accepted-risk")}
                  style={drawerButtonStyle}
                >
                  Accept risk
                </button>
              )}
              {!canApply && (
                <span style={{ fontSize: "12px", color: "var(--text-soft)" }}>
                  Applying remediation requires Remediation.Apply.
                </span>
              )}
            </div>

            {statusMessage && (
              <div role="status" data-testid="drawer-status" style={{ fontSize: "13px", color: "var(--text-soft)" }}>
                {statusMessage}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Apply confirmation, shared with the Remediation page's route (T-0925). */}
      {applyActions && (plan || planId) && (
        <ApplyActionDialog
          planId={plan?.plan.id ?? planId}
          tenantId={run.tenantId}
          actions={applyActions}
          fetcher={fetcher}
          onApplied={handleApplied}
          onClose={() => setApplyActions(null)}
        />
      )}
    </div>
  );
}
