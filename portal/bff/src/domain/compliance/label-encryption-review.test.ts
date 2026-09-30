import { describe, expect, it } from "vitest";
import {
  LABEL_ENCRYPTION_REVIEW_NOT_DISTINCT,
  LABEL_ENCRYPTION_REVIEW_REQUIRED,
  assertLabelEncryptionReview,
  labelEncryptionChanged,
  reviewLabelEncryptionChange,
  type LabelEncryptionSettings,
} from "./label-encryption-review.js";

const ENCRYPTED: LabelEncryptionSettings = {
  enabled: true,
  protectionType: "Template",
  templateId: "template-1",
  rights: ["principal-a:VIEW", "principal-b:EDIT"],
};

describe("label-encryption-review (T-0587)", () => {
  it("does not require review when encryption settings are untouched", () => {
    const review = reviewLabelEncryptionChange({
      action: "edit",
      requesterId: "user-1",
      before: ENCRYPTED,
      after: { ...ENCRYPTED },
    });
    expect(review.encryptionChanged).toBe(false);
    expect(review.requiresSecondReview).toBe(false);
    expect(review.approved).toBe(true);
  });

  it("does not require review for a non-encryption edit", () => {
    expect(
      labelEncryptionChanged(null, { enabled: false }),
    ).toBe(false);
    expect(
      labelEncryptionChanged(undefined, { enabled: false, rights: [] }),
    ).toBe(false);
  });

  it("requires review when encryption is enabled on create", () => {
    const review = reviewLabelEncryptionChange({
      action: "create",
      requesterId: "user-1",
      before: null,
      after: ENCRYPTED,
    });
    expect(review.encryptionChanged).toBe(true);
    expect(review.requiresSecondReview).toBe(true);
    expect(review.approved).toBe(false);
    expect(review.code).toBe(LABEL_ENCRYPTION_REVIEW_REQUIRED);
  });

  it("requires review when an encrypted label is edited or deleted", () => {
    expect(
      labelEncryptionChanged(ENCRYPTED, { ...ENCRYPTED, rights: ["principal-a:VIEW"] }),
    ).toBe(true);
    expect(labelEncryptionChanged(ENCRYPTED, null)).toBe(true);
  });

  it("refuses a change without an approval", () => {
    const review = reviewLabelEncryptionChange({
      action: "edit",
      requesterId: "user-1",
      before: ENCRYPTED,
      after: { ...ENCRYPTED, enabled: false },
    });
    expect(review.approved).toBe(false);
    expect(review.reasons.join(" ")).toContain("second reviewer");
  });

  it("refuses a self-approval from the requester", () => {
    const review = reviewLabelEncryptionChange({
      action: "edit",
      requesterId: "user-1",
      before: ENCRYPTED,
      after: { ...ENCRYPTED, enabled: false },
      approval: { reviewerId: "user-1", approvedAt: "2026-09-30T00:00:00.000Z" },
    });
    expect(review.approved).toBe(false);
    expect(review.distinctReviewer).toBe(false);
    expect(review.code).toBe(LABEL_ENCRYPTION_REVIEW_NOT_DISTINCT);
  });

  it("approves a change with a distinct second reviewer and records the approval", () => {
    const review = reviewLabelEncryptionChange({
      action: "edit",
      requesterId: "user-1",
      before: ENCRYPTED,
      after: { ...ENCRYPTED, enabled: false },
      approval: {
        reviewerId: "user-2",
        approvedAt: "2026-09-30T00:00:00.000Z",
        reason: "reviewed the impact",
      },
    });
    expect(review.approved).toBe(true);
    expect(review.distinctReviewer).toBe(true);
    expect(review.encryptionChanged).toBe(true);
    expect(review.approval).toMatchObject({
      reviewerId: "user-2",
      approvedAt: "2026-09-30T00:00:00.000Z",
      reason: "reviewed the impact",
    });
  });

  it("fails without a distinct approval and passes with one", () => {
    expect(() =>
      assertLabelEncryptionReview({
        action: "create",
        requesterId: "user-1",
        before: null,
        after: ENCRYPTED,
      }),
    ).toThrowError(
      expect.objectContaining({ code: LABEL_ENCRYPTION_REVIEW_REQUIRED, status: 409 }),
    );

    expect(() =>
      assertLabelEncryptionReview({
        action: "create",
        requesterId: "user-1",
        before: null,
        after: ENCRYPTED,
        approval: { reviewerId: "user-1", approvedAt: "2026-09-30T00:00:00.000Z" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: LABEL_ENCRYPTION_REVIEW_NOT_DISTINCT, status: 409 }),
    );

    const allowed = assertLabelEncryptionReview({
      action: "create",
      requesterId: "user-1",
      before: null,
      after: ENCRYPTED,
      approval: { reviewerId: "user-2", approvedAt: "2026-09-30T00:00:00.000Z" },
    });
    expect(allowed.approved).toBe(true);
  });

  it("never requires review for publishing-policy assignment", () => {
    const review = reviewLabelEncryptionChange({
      action: "publish",
      requesterId: "user-1",
      before: ENCRYPTED,
      after: ENCRYPTED,
    });
    expect(review.requiresSecondReview).toBe(false);
    expect(review.approved).toBe(true);
  });
});
