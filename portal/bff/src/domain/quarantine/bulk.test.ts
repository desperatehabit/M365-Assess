// T-0425 — bulk quarantine release/delete domain logic: the cap, the
// all-or-nothing selection validation, and the confirmation count model.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUARANTINE_BULK_CAP,
  QUARANTINE_BULK_CAP_EXCEEDED,
  QUARANTINE_BULK_CONFIRM_REQUIRED,
  QUARANTINE_BULK_EMPTY_SELECTION,
  QUARANTINE_BULK_INVALID,
  buildQuarantineBulkConfirmation,
  parseQuarantineBulkAction,
  requireQuarantineBulkConfirmation,
  resolveQuarantineBulkCap,
  validateQuarantineBulkSelection,
} from "./bulk.js";

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `message-${index + 1}`);
}

describe("quarantine bulk domain (T-0425)", () => {
  it("defaults the cap and rejects a non-positive or non-integer configured cap", () => {
    expect(resolveQuarantineBulkCap()).toBe(DEFAULT_QUARANTINE_BULK_CAP);
    expect(resolveQuarantineBulkCap(25)).toBe(25);
    expect(() => resolveQuarantineBulkCap(0)).toThrow(
      expect.objectContaining({ code: QUARANTINE_BULK_INVALID }),
    );
    expect(() => resolveQuarantineBulkCap(-1)).toThrow(
      expect.objectContaining({ code: QUARANTINE_BULK_INVALID }),
    );
    expect(() => resolveQuarantineBulkCap(1.5)).toThrow(
      expect.objectContaining({ code: QUARANTINE_BULK_INVALID }),
    );
  });

  it("parses the bulk action aliases and rejects unknown actions", () => {
    expect(parseQuarantineBulkAction("release")).toBe("release");
    expect(parseQuarantineBulkAction("release-to-all")).toBe("releaseAll");
    expect(parseQuarantineBulkAction("releaseAll")).toBe("releaseAll");
    expect(parseQuarantineBulkAction("delete")).toBe("delete");
    expect(() => parseQuarantineBulkAction("forward")).toThrow(
      expect.objectContaining({ code: QUARANTINE_BULK_INVALID }),
    );
    expect(() => parseQuarantineBulkAction("")).toThrow(
      expect.objectContaining({ code: QUARANTINE_BULK_INVALID }),
    );
  });

  it("accepts a selection at the cap and rejects a batch over the cap without truncating", () => {
    const atCap = validateQuarantineBulkSelection("release", ids(5), 5);
    expect(atCap.count).toBe(5);
    expect(atCap.cap).toBe(5);
    expect(atCap.messageIds).toHaveLength(5);

    let caught: unknown;
    try {
      validateQuarantineBulkSelection("delete", ids(6), 5);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: QUARANTINE_BULK_CAP_EXCEEDED });
    expect((caught as Error).message).toContain("6");
    expect((caught as Error).message).toContain("5");
  });

  it("rejects an empty selection and a malformed id list", () => {
    expect(() => validateQuarantineBulkSelection("release", [])).toThrow(
      expect.objectContaining({ code: QUARANTINE_BULK_EMPTY_SELECTION }),
    );
    expect(() => validateQuarantineBulkSelection("release", "message-1")).toThrow(
      expect.objectContaining({ code: QUARANTINE_BULK_INVALID }),
    );
    expect(() => validateQuarantineBulkSelection("release", ["message-1", ""])).toThrow(
      expect.objectContaining({ code: QUARANTINE_BULK_INVALID }),
    );
  });

  it("rejects duplicate message ids rather than silently collapsing them", () => {
    expect(() => validateQuarantineBulkSelection("delete", ["message-1", "message-1"])).toThrow(
      expect.objectContaining({ code: QUARANTINE_BULK_INVALID }),
    );
  });

  it("builds a confirmation count model showing count, cap, and remaining", () => {
    const selection = validateQuarantineBulkSelection("releaseAll", ids(3), 10);
    const confirmation = buildQuarantineBulkConfirmation(selection);
    expect(confirmation).toMatchObject({
      action: "releaseAll",
      count: 3,
      cap: 10,
      remaining: 7,
      requiresConfirmation: true,
      confirmed: false,
    });
    expect(confirmation.warning).toContain("audited");
  });

  it("proceeds only on confirm and names the count in the refusal", () => {
    const selection = validateQuarantineBulkSelection("delete", ids(4), 10);
    expect(() => requireQuarantineBulkConfirmation(selection, undefined)).toThrow(
      expect.objectContaining({ code: QUARANTINE_BULK_CONFIRM_REQUIRED }),
    );
    expect(() => requireQuarantineBulkConfirmation(selection, false)).toThrow(
      expect.objectContaining({ code: QUARANTINE_BULK_CONFIRM_REQUIRED }),
    );

    let message = "";
    try {
      requireQuarantineBulkConfirmation(selection, false);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("4");

    const confirmed = requireQuarantineBulkConfirmation(selection, true);
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.count).toBe(4);
  });
});
