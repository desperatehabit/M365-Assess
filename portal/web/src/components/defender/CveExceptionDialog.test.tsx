/** @vitest-environment jsdom */
// Tests for CveExceptionDialog (T-0369, EPIC-019 SPEC.md §3.4 and §11.3).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  CveExceptionDialog,
  normalizeCveExceptionForm,
  validateCveExceptionForm,
  type CveExceptionFormValues,
} from "./CveExceptionDialog";
import type { CveException } from "./CveExceptionTable";

afterEach(() => {
  cleanup();
});

const NOW = Date.now();
const FUTURE_DATE = new Date(NOW + 30 * 86400000).toISOString().slice(0, 10);
const PAST_DATE = new Date(NOW - 86400000).toISOString().slice(0, 10);
const FUTURE_ISO = new Date(NOW + 30 * 86400000).toISOString();

const EXISTING: CveException = {
  id: "exc-1",
  tenantId: "tenant-1",
  cve: "CVE-2026-1234",
  scope: "device",
  scopeTargetId: "device-7",
  reason: "Vendor patch pending",
  expiresOn: FUTURE_ISO,
  createdBy: "operator",
  createdAt: new Date(NOW - 86400000).toISOString(),
  updatedAt: new Date(NOW - 86400000).toISOString(),
};

function fillValid(scope: "all" | "device" | "software" = "all"): void {
  fireEvent.change(screen.getByTestId("input-cve"), { target: { value: "CVE-2026-1234" } });
  fireEvent.change(screen.getByTestId("input-scope"), { target: { value: scope } });
  if (scope !== "all") {
    fireEvent.change(screen.getByTestId("input-scope-target"), { target: { value: "device-7" } });
  }
  fireEvent.change(screen.getByTestId("input-reason"), { target: { value: "Vendor patch pending" } });
  fireEvent.change(screen.getByTestId("input-expires"), { target: { value: FUTURE_DATE } });
}

describe("CveExceptionDialog validation (T-0369)", () => {
  it("renders the §11.3 scope selector with all, device, and software defaulting to all", () => {
    render(<CveExceptionDialog onSubmit={vi.fn()} onClose={vi.fn()} />);
    const scope = screen.getByTestId("input-scope") as HTMLSelectElement;
    const options = Array.from(scope.querySelectorAll("option")).map((o) => o.value);
    expect(options).toEqual(["all", "device", "software"]);
    expect(scope.value).toBe("all");
  });

  it("rejects a submit without the mandatory expiry", () => {
    const onSubmit = vi.fn();
    render(<CveExceptionDialog onSubmit={onSubmit} onClose={vi.fn()} />);
    fillValid();
    fireEvent.change(screen.getByTestId("input-expires"), { target: { value: "" } });

    fireEvent.click(screen.getByTestId("cve-dialog-submit"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("cve-dialog-error").textContent).toMatch(/expiry is required/i);
  });

  it("rejects a past expiry", () => {
    const onSubmit = vi.fn();
    render(<CveExceptionDialog onSubmit={onSubmit} onClose={vi.fn()} />);
    fillValid();
    fireEvent.change(screen.getByTestId("input-expires"), { target: { value: PAST_DATE } });

    fireEvent.click(screen.getByTestId("cve-dialog-submit"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("cve-dialog-error").textContent).toMatch(/in the future/i);
  });

  it("requires a target for device and software scopes", () => {
    const onSubmit = vi.fn();
    render(<CveExceptionDialog onSubmit={onSubmit} onClose={vi.fn()} />);
    fillValid("device");
    fireEvent.change(screen.getByTestId("input-scope-target"), { target: { value: "  " } });

    fireEvent.click(screen.getByTestId("cve-dialog-submit"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("cve-dialog-error").textContent).toMatch(/target is required/i);
  });

  it("forbids a target when scope is all", () => {
    expect(
      validateCveExceptionForm(
        {
          cve: "CVE-2026-1234",
          scope: "all",
          scopeTargetId: "device-7",
          reason: "Vendor patch pending",
          expiresOn: FUTURE_ISO,
        },
        NOW,
      ),
    ).toMatch(/must be empty/i);
  });

  it("rejects a malformed CVE and a missing reason", () => {
    expect(
      validateCveExceptionForm(
        { cve: "CVE-BAD", scope: "all", scopeTargetId: "", reason: "x", expiresOn: FUTURE_ISO },
        NOW,
      ),
    ).toMatch(/cve must look like/i);
    expect(
      validateCveExceptionForm(
        { cve: "CVE-2026-1234", scope: "all", scopeTargetId: "", reason: "  ", expiresOn: FUTURE_ISO },
        NOW,
      ),
    ).toMatch(/reason is required/i);
    expect(
      validateCveExceptionForm(
        { cve: "CVE-2026-1234", scope: "bogus", scopeTargetId: "", reason: "x", expiresOn: FUTURE_ISO },
        NOW,
      ),
    ).toMatch(/scope must be/i);
  });

  it("submits a normalized payload for a valid add", () => {
    const onSubmit = vi.fn();
    render(<CveExceptionDialog onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("input-cve"), { target: { value: "cve-2026-1234" } });
    fireEvent.change(screen.getByTestId("input-reason"), { target: { value: "Vendor patch pending" } });
    fireEvent.change(screen.getByTestId("input-expires"), { target: { value: FUTURE_DATE } });

    fireEvent.click(screen.getByTestId("cve-dialog-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]?.[0] as CveExceptionFormValues;
    expect(payload.cve).toBe("CVE-2026-1234");
    expect(payload.scope).toBe("all");
    expect(payload.scopeTargetId).toBeNull();
    expect(payload.reason).toBe("Vendor patch pending");
    expect(new Date(payload.expiresOn).getTime()).toBeGreaterThan(Date.now());
  });

  it("keeps a device target on submit and locks the CVE in edit mode", () => {
    const onSubmit = vi.fn();
    render(<CveExceptionDialog initial={EXISTING} onSubmit={onSubmit} onClose={vi.fn()} />);

    const cve = screen.getByTestId("input-cve") as HTMLInputElement;
    expect(cve.disabled).toBe(true);
    expect(cve.value).toBe("CVE-2026-1234");
    expect((screen.getByTestId("input-scope") as HTMLSelectElement).value).toBe("device");
    expect((screen.getByTestId("input-scope-target") as HTMLInputElement).value).toBe("device-7");

    fireEvent.click(screen.getByTestId("cve-dialog-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]?.[0] as CveExceptionFormValues;
    expect(payload.scope).toBe("device");
    expect(payload.scopeTargetId).toBe("device-7");
  });

  it("closes on cancel and surfaces server errors", () => {
    const onClose = vi.fn();
    render(<CveExceptionDialog serverError="HTTP 409 conflict" onSubmit={vi.fn()} onClose={onClose} />);
    expect(screen.getByTestId("cve-dialog-error").textContent).toContain("HTTP 409");
    fireEvent.click(screen.getByTestId("cve-dialog-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("normalizes dates and uppercases the CVE", () => {
    const values = normalizeCveExceptionForm({
      cve: "cve-2026-1234",
      scope: "software",
      scopeTargetId: "  app-9  ",
      reason: "  Vendor patch pending  ",
      expiresOn: FUTURE_DATE,
    });
    expect(values.cve).toBe("CVE-2026-1234");
    expect(values.scopeTargetId).toBe("app-9");
    expect(values.reason).toBe("Vendor patch pending");
    expect(values.expiresOn).toBe(new Date(`${FUTURE_DATE}T00:00:00Z`).toISOString());
  });

  it("uses kit tokens with zero colour literals", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = (await import("node:path")).default;
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "CveExceptionDialog.tsx"),
      "utf8",
    );
    for (const literal of ["#fff", "#000", "rgb(", "rgba("]) {
      expect(source).not.toContain(literal);
    }
    expect(source).toContain("var(--");
  });
});
