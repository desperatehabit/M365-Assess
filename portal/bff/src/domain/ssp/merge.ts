// Merges automated findings, the customer questionnaire, and inheritance hints
// into one status per practice (the SSP view).
//
// Precedence: a recorded answer always wins, because the consultant has seen
// the automated evidence and the customer's context. Without one, the automated
// outcome sets the status: all mapped findings passing is "implemented", any
// failure with no pass is "not-implemented", and a mix (or a Warning) is
// "partially-implemented". Review-only or missing results stay "not-assessed",
// which the questionnaire surfaces as needing an answer.
import {
  SSP_IMPLEMENTATION_STATUSES,
  computeSprsScore,
  SSP_PRACTICES,
  type SspAutomatedEvidence,
  type SspAutomatedFinding,
  type SspAutomatedOutcome,
  type SspDocumentView,
  type SspImplementationStatus,
  type SspPractice,
  type SspPracticeResponse,
  type SspPracticeView,
  type SspSummary,
  type SspSystemProfile,
} from "@m365-assess/contracts/ssp";

export interface SspFindingInput {
  readonly checkId: string;
  readonly status: string;
  readonly controlName: string | null;
  readonly currentValue: string | null;
}

export interface BuildSspViewInput {
  readonly tenantId: string;
  readonly practiceChecks: ReadonlyMap<string, readonly string[]>;
  readonly findings: readonly SspFindingInput[];
  readonly runId: string | null;
  readonly responses: readonly SspPracticeResponse[];
  readonly profile: SspSystemProfile | null;
  readonly now?: () => string;
  readonly practices?: readonly SspPractice[];
}

/** Finding check ids are sub-numbered per emitted row ("CA-LEGACYAUTH-001.1"). */
export function baseCheckId(checkId: string): string {
  return checkId.replace(/\.\d+$/, "");
}

export function automatedOutcome(
  checkIds: readonly string[],
  findings: readonly SspAutomatedFinding[],
): SspAutomatedOutcome {
  if (checkIds.length === 0) return "none";
  if (findings.length === 0) return "not-assessed";
  let pass = 0;
  let fail = 0;
  let warning = 0;
  for (const finding of findings) {
    const status = finding.status.toLowerCase();
    if (status === "pass" || status === "info") pass += 1;
    else if (status === "fail") fail += 1;
    else if (status === "warning") warning += 1;
  }
  if (fail > 0) return pass > 0 ? "partial" : "fail";
  if (warning > 0) return "partial";
  if (pass > 0) return "pass";
  return "review";
}

const STATUS_FROM_OUTCOME: Readonly<Record<SspAutomatedOutcome, SspImplementationStatus | "not-assessed">> = {
  pass: "implemented",
  fail: "not-implemented",
  partial: "partially-implemented",
  review: "not-assessed",
  "not-assessed": "not-assessed",
  none: "not-assessed",
};

export function buildSspView(input: BuildSspViewInput): SspDocumentView {
  const practices = input.practices ?? SSP_PRACTICES;
  const findingsByCheck = new Map<string, SspAutomatedFinding[]>();
  for (const finding of input.findings) {
    const key = baseCheckId(finding.checkId);
    const list = findingsByCheck.get(key) ?? [];
    list.push({
      checkId: finding.checkId,
      status: finding.status,
      controlName: finding.controlName,
      currentValue: finding.currentValue,
    });
    findingsByCheck.set(key, list);
  }
  const responses = new Map(input.responses.map((response) => [response.practiceId, response]));

  const views: SspPracticeView[] = practices.map((practice) => {
    const checkIds = input.practiceChecks.get(practice.id) ?? [];
    const findings = checkIds.flatMap((checkId) => findingsByCheck.get(checkId) ?? []);
    const outcome = automatedOutcome(checkIds, findings);
    const automated: SspAutomatedEvidence = { checkIds, findings, outcome, runId: input.runId };
    const response = responses.get(practice.id) ?? null;
    const automatedStatus = STATUS_FROM_OUTCOME[outcome];
    return {
      practice,
      automated,
      response,
      effectiveStatus: response ? response.implementationStatus : automatedStatus,
      effectiveResponsibility: response?.responsibility ?? practice.defaultResponsibility ?? "customer",
      statusSource: response ? "response" : automatedStatus === "not-assessed" ? "none" : "automated",
    };
  });

  return {
    tenantId: input.tenantId,
    profile: input.profile,
    practices: views,
    summary: summarize(views),
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
  };
}

export function summarize(views: readonly SspPracticeView[]): SspSummary {
  const byStatus = Object.fromEntries(
    [...SSP_IMPLEMENTATION_STATUSES, "not-assessed"].map((status) => [status, 0]),
  ) as Record<SspImplementationStatus | "not-assessed", number>;
  let unanswered = 0;
  let level1Total = 0;
  let level1Implemented = 0;
  for (const view of views) {
    byStatus[view.effectiveStatus] += 1;
    if (view.statusSource === "none") unanswered += 1;
    if (view.practice.level1Id) {
      level1Total += 1;
      if (view.effectiveStatus === "implemented" || view.effectiveStatus === "not-applicable") level1Implemented += 1;
    }
  }
  return { total: views.length, byStatus, unanswered, level1Implemented, level1Total, sprs: computeSprsScore(views) };
}
