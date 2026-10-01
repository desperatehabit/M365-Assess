// T-0701 — shared pack scoring. Asserts the one normalization scores packs
// with different check totals on the same 0..100 scale.

import { describe, expect, it } from "vitest";
import { scorePackResults } from "./scoring.js";

describe("scorePackResults", () => {
  it("normalizes identically for packs with different check totals", () => {
    expect(scorePackResults({ passed: 1, failed: 1 })).toBe(
      scorePackResults({ passed: 10, failed: 10 }),
    );
    expect(scorePackResults({ passed: 2, failed: 1 })).toBe(
      scorePackResults({ passed: 20, failed: 10 }),
    );
    expect(scorePackResults({ passed: 3, failed: 0 })).toBe(
      scorePackResults({ passed: 300, failed: 0 }),
    );
  });

  it("scores the pass share on a 0..100 scale rounded to one decimal", () => {
    expect(scorePackResults({ passed: 1, failed: 1 })).toBe(50);
    expect(scorePackResults({ passed: 2, failed: 1 })).toBe(66.7);
    expect(scorePackResults({ passed: 1, failed: 2 })).toBe(33.3);
  });

  it("scores all-pass and all-fail packs at the extremes", () => {
    expect(scorePackResults({ passed: 166, failed: 0 })).toBe(100);
    expect(scorePackResults({ passed: 0, failed: 140 })).toBe(0);
  });

  it("returns 0 when no results are decided", () => {
    expect(scorePackResults({ passed: 0, failed: 0 })).toBe(0);
  });

  it("compares the CIS and E8 pack sizes on the same scale", () => {
    // CIS maps 166 checks and E8 maps 140: the same pass ratio must score the
    // same for both packs.
    const cis = scorePackResults({ passed: 83, failed: 83 });
    const e8 = scorePackResults({ passed: 70, failed: 70 });
    expect(cis).toBe(50);
    expect(e8).toBe(50);
    expect(cis).toBe(e8);
  });
});
