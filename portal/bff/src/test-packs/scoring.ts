// EPIC-036 shared pack scoring (SPEC.md §11.3; T-0701): one normalization for
// every pack, so scores stay comparable across packs with different check
// totals.

/** Decided results for one pack run. */
export interface PackScoreCounts {
  readonly passed: number;
  readonly failed: number;
}

/** Pass share of decided results, 0..100, rounded to one decimal. */
export function scorePackResults({ passed, failed }: PackScoreCounts): number {
  const total = passed + failed;
  return total === 0 ? 0 : Math.round((passed / total) * 1000) / 10;
}
