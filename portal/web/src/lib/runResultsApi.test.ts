import { describe, expect, it, vi } from "vitest";
import { fetchAllRunResults, RUN_RESULTS_MAX_PAGES, RUN_RESULTS_PAGE_LIMIT } from "./runResultsApi";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("fetchAllRunResults (T-0945)", () => {
  it("follows nextCursor until the last page and returns every finding", async () => {
    // 258 findings over three pages: the live run that showed "Findings (100)".
    const all = Array.from({ length: 258 }, (_, i) => ({ id: `f-${i}` }));
    const pages: Record<string, unknown> = {
      "": { items: all.slice(0, 100), issues: [{ message: "Power BI 403" }], total: 258, nextCursor: "c100" },
      c100: { items: all.slice(100, 200), issues: [{ message: "Power BI 403" }], total: 258, nextCursor: "c200" },
      c200: { items: all.slice(200), issues: [{ message: "Power BI 403" }], total: 258, nextCursor: null },
    };
    const fetcher = vi.fn(async (url: string) => {
      const query = new URL(url, "http://portal.test").searchParams;
      return jsonResponse(pages[query.get("cursor") ?? ""]);
    });

    const result = await fetchAllRunResults("run 1", { fetcher: fetcher as unknown as typeof fetch });

    expect(result.items).toHaveLength(258);
    expect(result.items.at(-1)).toEqual({ id: "f-257" });
    expect(result.total).toBe(258);
    // The issue log repeats on every page; it is taken once.
    expect(result.issues).toEqual([{ message: "Power BI 403" }]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const firstUrl = String(fetcher.mock.calls[0]![0]);
    expect(firstUrl).toBe(`/v1/runs/run%201/results?limit=${RUN_RESULTS_PAGE_LIMIT}`);
    expect(String(fetcher.mock.calls[1]![0])).toContain("cursor=c100");
  });

  it("throws with the HTTP status when a page fails", async () => {
    const fetcher = vi.fn(async () => jsonResponse({}, 403));
    await expect(
      fetchAllRunResults("run-1", { fetcher: fetcher as unknown as typeof fetch }),
    ).rejects.toThrow("Run results failed to load: 403");
  });

  it("stops when the cursor repeats or the page cap is reached", async () => {
    const repeating = vi.fn(async () => jsonResponse({ items: [{ id: "x" }], nextCursor: "same" }));
    const repeated = await fetchAllRunResults("run-1", { fetcher: repeating as unknown as typeof fetch });
    expect(repeating).toHaveBeenCalledTimes(2);
    expect(repeated.items).toHaveLength(2);

    let n = 0;
    const endless = vi.fn(async () => jsonResponse({ items: [], nextCursor: `c${n++}` }));
    await fetchAllRunResults("run-1", { fetcher: endless as unknown as typeof fetch });
    expect(endless).toHaveBeenCalledTimes(RUN_RESULTS_MAX_PAGES);
  });

  it("treats a missing items or issues field as empty", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ nextCursor: null }));
    const result = await fetchAllRunResults("run-1", { fetcher: fetcher as unknown as typeof fetch });
    expect(result).toEqual({ items: [], issues: [], total: 0 });
  });
});
