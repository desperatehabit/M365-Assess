// Run results client (T-0945).
//
// GET /v1/runs/{runId}/results is cursor-paginated (default 100 findings per page) and
// returns `nextCursor` until the last page. Callers that read only the first page show
// a truncated run, so every caller goes through fetchAllRunResults, which follows the
// cursor and returns the complete finding set with the run's issue log.

/** The page size requested; the BFF caps `limit` at 1000. */
export const RUN_RESULTS_PAGE_LIMIT = 1000;

/** Stops a misbehaving cursor from looping forever. */
export const RUN_RESULTS_MAX_PAGES = 100;

export interface RunResultsPage<TFinding, TIssue> {
  readonly items?: readonly TFinding[];
  readonly issues?: readonly TIssue[];
  readonly total?: number;
  readonly nextCursor?: string | null;
}

export interface RunResults<TFinding, TIssue> {
  readonly items: TFinding[];
  readonly issues: TIssue[];
  /** The total the BFF reported, or the number of findings read. */
  readonly total: number;
}

export interface FetchAllRunResultsOptions {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}

/**
 * Reads every page of a run's findings. The issue log is the same on every page, so
 * it is taken from the first. Throws on a non-OK response with the HTTP status.
 */
export async function fetchAllRunResults<TFinding = unknown, TIssue = unknown>(
  runId: string,
  options: FetchAllRunResultsOptions = {},
): Promise<RunResults<TFinding, TIssue>> {
  const { baseUrl = "", fetcher = fetch, signal } = options;
  const items: TFinding[] = [];
  let issues: TIssue[] | null = null;
  let total: number | null = null;
  let cursor: string | null = null;
  const seen = new Set<string>();

  for (let pageCount = 0; pageCount < RUN_RESULTS_MAX_PAGES; pageCount++) {
    const params = new URLSearchParams({ limit: String(RUN_RESULTS_PAGE_LIMIT) });
    if (cursor) params.set("cursor", cursor);
    const response = await fetcher(
      `${baseUrl}/v1/runs/${encodeURIComponent(runId)}/results?${params.toString()}`,
      signal ? { signal } : undefined,
    );
    if (!response.ok) {
      throw new Error(`Run results failed to load: ${response.status}`);
    }
    const page = (await response.json()) as RunResultsPage<TFinding, TIssue>;
    if (Array.isArray(page.items)) items.push(...page.items);
    if (issues === null) issues = Array.isArray(page.issues) ? [...page.issues] : [];
    if (total === null && typeof page.total === "number") total = page.total;

    const next = page.nextCursor ?? null;
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }

  return { items, issues: issues ?? [], total: total ?? items.length };
}
