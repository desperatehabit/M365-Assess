// Sensitivity-label encryption change review (EPIC-030 SPEC.md §3.3, §4.3, §9,
// §11.2; T-0587). §11.2 is resolved to require a mandatory second reviewer for
// any label change that alters encryption settings. This module is the pure
// gate: it detects an encryption-settings change between the before and after
// label state and, when one is present, refuses it unless a second reviewer
// distinct from the requester approved. The caller records the returned
// approval on the resulting CompliancePolicyChange (T-0581) and in the audit
// event. Publishing-policy assignment carries no encryption change, so it never
// trips this gate.
import { AppError } from "../../errors.js";

export const LABEL_ENCRYPTION_REVIEW_REQUIRED = "labels.encryption_review_required";
export const LABEL_ENCRYPTION_REVIEW_NOT_DISTINCT = "labels.encryption_review_not_distinct";

export type LabelChangeAction = "create" | "edit" | "delete" | "publish";

export interface LabelEncryptionSettings {
  readonly enabled?: boolean;
  readonly protectionType?: string | null;
  readonly templateId?: string | null;
  readonly rights?: readonly string[];
  readonly contentExpiration?: string | null;
  readonly offlineAccess?: boolean;
}

export interface LabelEncryptionApproval {
  readonly reviewerId: string;
  readonly approvedAt: string;
  readonly reason?: string;
}

export interface LabelEncryptionReviewInput {
  readonly action: LabelChangeAction;
  readonly requesterId: string;
  readonly before?: LabelEncryptionSettings | null;
  readonly after?: LabelEncryptionSettings | null;
  readonly approval?: LabelEncryptionApproval | null;
}

export interface LabelEncryptionReview {
  readonly requiresSecondReview: boolean;
  readonly encryptionChanged: boolean;
  readonly approved: boolean;
  readonly distinctReviewer: boolean;
  readonly reasons: readonly string[];
  readonly approval: LabelEncryptionApproval | null;
  readonly code: string | null;
}

interface NormalizedEncryption {
  readonly enabled: boolean;
  readonly protectionType: string | null;
  readonly templateId: string | null;
  readonly rights: readonly string[];
  readonly contentExpiration: string | null;
  readonly offlineAccess: boolean;
}

function normalizeEncryption(
  settings: LabelEncryptionSettings | null | undefined,
): NormalizedEncryption | null {
  if (settings === null || settings === undefined) return null;
  const rights = Array.isArray(settings.rights)
    ? settings.rights.map((right) => String(right)).sort()
    : [];
  return {
    enabled: settings.enabled === true,
    protectionType: settings.protectionType ?? null,
    templateId: settings.templateId ?? null,
    rights,
    contentExpiration: settings.contentExpiration ?? null,
    offlineAccess: settings.offlineAccess === true,
  };
}

function hasEncryption(settings: NormalizedEncryption | null): boolean {
  if (settings === null) return false;
  return (
    settings.enabled ||
    settings.protectionType !== null ||
    settings.templateId !== null ||
    settings.rights.length > 0
  );
}

// True when either side of the change carries encryption and the encryption
// settings differ. Clearing encryption on delete counts as a change; a change
// that never touches encryption does not.
export function labelEncryptionChanged(
  before: LabelEncryptionSettings | null | undefined,
  after: LabelEncryptionSettings | null | undefined,
): boolean {
  const normalizedBefore = normalizeEncryption(before);
  const normalizedAfter = normalizeEncryption(after);
  if (!hasEncryption(normalizedBefore) && !hasEncryption(normalizedAfter)) {
    return false;
  }
  return JSON.stringify(normalizedBefore) !== JSON.stringify(normalizedAfter);
}

export function reviewLabelEncryptionChange(
  input: LabelEncryptionReviewInput,
): LabelEncryptionReview {
  const encryptionChanged = labelEncryptionChanged(input.before, input.after);
  if (!encryptionChanged) {
    return {
      requiresSecondReview: false,
      encryptionChanged: false,
      approved: true,
      distinctReviewer: true,
      reasons: [],
      approval: null,
      code: null,
    };
  }

  const requesterId = input.requesterId.trim();
  const approval = input.approval ?? null;
  const reviewerId = approval?.reviewerId?.trim() ?? "";
  if (reviewerId.length === 0) {
    return {
      requiresSecondReview: true,
      encryptionChanged: true,
      approved: false,
      distinctReviewer: false,
      reasons: [
        "changing sensitivity-label encryption settings requires a second reviewer's approval",
      ],
      approval: null,
      code: LABEL_ENCRYPTION_REVIEW_REQUIRED,
    };
  }
  if (reviewerId === requesterId) {
    return {
      requiresSecondReview: true,
      encryptionChanged: true,
      approved: false,
      distinctReviewer: false,
      reasons: ["the second reviewer must be distinct from the requester"],
      approval: null,
      code: LABEL_ENCRYPTION_REVIEW_NOT_DISTINCT,
    };
  }

  const recorded: LabelEncryptionApproval = {
    reviewerId,
    approvedAt: approval?.approvedAt?.trim() ?? "",
    ...(approval?.reason !== undefined ? { reason: approval.reason } : {}),
  };
  return {
    requiresSecondReview: true,
    encryptionChanged: true,
    approved: true,
    distinctReviewer: true,
    reasons: [],
    approval: recorded,
    code: null,
  };
}

// Throws a 409 AppError when the change alters encryption without a valid
// distinct second-reviewer approval. Returns the review (carrying the approval
// to record) when the change is allowed.
export function assertLabelEncryptionReview(
  input: LabelEncryptionReviewInput,
): LabelEncryptionReview {
  const review = reviewLabelEncryptionChange(input);
  if (!review.approved) {
    throw new AppError(
      review.code ?? LABEL_ENCRYPTION_REVIEW_REQUIRED,
      review.reasons.join("; "),
      409,
      [
        {
          field: "encryptionApproval",
          reason: review.code === LABEL_ENCRYPTION_REVIEW_NOT_DISTINCT ? "not_distinct" : "required",
        },
      ],
    );
  }
  return review;
}
