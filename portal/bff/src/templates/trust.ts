// Community template trust model (EPIC-039 SPEC.md §9 risk "untrusted
// community templates", §11 open question 2; T-0764).
//
// A community repo/bundle is browsable and cloneable only after an admin opts
// it in, and each bundle carries a signature plus a review state
// (`unreviewed | reviewed | signed`). Clone refuses an unverified bundle unless
// an admin explicitly overrides the opt-in (§3.3, §4.1: "never auto-apply").
// Verification failure is a structured error, never a silent pass. The T-0761
// TemplateRepo carries the `signed`, `reviewState`, and `trusted` fields; this
// module is the single place that interprets them.
import { AppError } from "../errors.js";
import type { TemplateRepoReviewState } from "@m365-assess/db";

export const TEMPLATE_BUNDLE_UNTRUSTED = "template.bundle.untrusted";
export const TEMPLATE_BUNDLE_UNVERIFIED = "template.bundle.unverified";

/** The T-0761 trust fields, narrowed to what verification reads. */
export interface BundleTrust {
  readonly signed: boolean;
  readonly reviewState: TemplateRepoReviewState;
  readonly trusted: boolean;
}

export interface TrustedRepo extends BundleTrust {
  readonly url: string;
}

/** A read model for the TrustBadge: where the bundle came from and how far it is reviewed. */
export interface BundleTrustView {
  readonly source: string;
  readonly author: string | null;
  readonly reviewState: TemplateRepoReviewState;
  readonly signed: boolean;
  readonly trusted: boolean;
  readonly verified: boolean;
}

/** A bundle is verified only when it is both signed and fully reviewed. */
export function isBundleVerified(trust: BundleTrust): boolean {
  return trust.signed && trust.reviewState === "signed";
}

/**
 * Derives the publishing owner from a repo source: the first path segment of an
 * http(s) URL or the `owner/repo` shorthand. Returns null when no owner is
 * present; the value is displayed as text, never as HTML (SPEC §9 risk).
 */
export function authorFromSource(source: string): string | null {
  const trimmed = source.trim();
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (shorthand?.[1]) return shorthand[1];
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
    return segments.length >= 2 ? (segments[0] ?? null) : null;
  } catch {
    return null;
  }
}

/** Projects a repo's trust fields into the source/author/review view the badge renders. */
export function describeBundleTrust(repo: TrustedRepo): BundleTrustView {
  return {
    source: repo.url,
    author: authorFromSource(repo.url),
    reviewState: repo.reviewState,
    signed: repo.signed,
    trusted: repo.trusted,
    verified: isBundleVerified(repo),
  };
}

/** Browsing (listing or indexing) requires the admin opt-in. */
export function assertRepoBrowsable(repo: BundleTrust): void {
  if (!repo.trusted) {
    throw new AppError(
      TEMPLATE_BUNDLE_UNTRUSTED,
      "community template repo is not opted in; an admin must opt in before browsing",
      403,
      [{ field: "trusted", reason: "opt_in_required" }],
    );
  }
}

export interface CloneTrustOptions {
  /** Admin override: clone without the opt-in and verification gates (SPEC §3.3). */
  readonly allowUnverified?: boolean;
}

/**
 * Clone requires the opt-in and a verified bundle. An admin can explicitly
 * override the gate; the override is the only path past it and is the caller's
 * responsibility to audit.
 */
export function assertBundleCloneable(repo: BundleTrust, options: CloneTrustOptions = {}): void {
  if (options.allowUnverified === true) return;
  assertRepoBrowsable(repo);
  if (!isBundleVerified(repo)) {
    throw new AppError(
      TEMPLATE_BUNDLE_UNVERIFIED,
      "community template bundle is not signed and reviewed; an admin must verify it or explicitly override",
      422,
      [
        {
          field: "reviewState",
          reason: "unverified",
          reviewState: repo.reviewState,
          signed: repo.signed,
        },
      ],
    );
  }
}
