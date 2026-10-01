// T-0764 — TrustBadge (EPIC-039 SPEC §9, §11).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  TrustBadge,
  isVerified,
  reviewStateLabel,
  type TrustBadgeData,
} from "../src/components/TrustBadge";

afterEach(() => {
  cleanup();
});

function trust(overrides: Partial<TrustBadgeData> = {}): TrustBadgeData {
  return {
    source: "https://github.com/owner/repo",
    author: "owner",
    reviewState: "unreviewed",
    signed: false,
    trusted: true,
    ...overrides,
  };
}

describe("TrustBadge", () => {
  it("renders the source, author, and review state", () => {
    render(<TrustBadge trust={trust({ reviewState: "reviewed" })} id="repo-1" />);

    expect(screen.getByTestId("trust-badge-repo-1")).toBeTruthy();
    expect(screen.getByTestId("trust-badge-review-repo-1").textContent).toBe("Reviewed");
    expect(screen.getByTestId("trust-badge-author-repo-1").textContent).toBe("owner");
    expect(screen.getByTestId("trust-badge-source-repo-1").textContent).toBe(
      "https://github.com/owner/repo",
    );
  });

  it("marks a signed, fully reviewed bundle as verified", () => {
    render(<TrustBadge trust={trust({ signed: true, reviewState: "signed" })} />);

    expect(screen.getByTestId("trust-badge-review").textContent).toBe("Signed");
    expect(screen.getByTestId("trust-badge-verified").textContent).toBe("Verified");
    expect(isVerified(trust({ signed: true, reviewState: "signed" }))).toBe(true);
    expect(isVerified(trust({ signed: true, reviewState: "reviewed" }))).toBe(false);
  });

  it("falls back when the author is unknown and flags a repo that is not opted in", () => {
    render(<TrustBadge trust={trust({ author: null, trusted: false })} />);

    expect(screen.getByTestId("trust-badge-author").textContent).toBe("Unknown author");
    expect(screen.getByTestId("trust-badge-optin").textContent).toBe("Not opted in");
  });

  it("labels every review state", () => {
    expect(reviewStateLabel("unreviewed")).toBe("Unreviewed");
    expect(reviewStateLabel("reviewed")).toBe("Reviewed");
    expect(reviewStateLabel("signed")).toBe("Signed");
  });
});
