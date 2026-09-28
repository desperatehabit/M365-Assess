/** @vitest-environment jsdom */
// Tests for CveExceptionTable (T-0369, EPIC-019 SPEC.md §3.4).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  CveExceptionTable,
  formatExpiry,
  isCveExceptionExpired,
  type CveException,
} from "./CveExceptionTable";

afterEach(() => {
  cleanup();
});

const NOW = Date.now();
const FUTURE = new Date(NOW + 30 * 86400000).toISOString();
const PAST = new Date(NOW - 86400000).toISOString();

function exception(overrides: Partial<CveException> = {}): CveException {
  return {
    id: "exc-1",
    tenantId: "tenant-1",
    cve: "CVE-2026-1234",
    scope: "all",
    scopeTargetId: null,
    reason: "Vendor patch pending",
    expiresOn: FUTURE,
    createdBy: "operator",
    createdAt: new Date(NOW - 86400000).toISOString(),
    updatedAt: new Date(NOW - 86400000).toISOString(),
    ...overrides,
  };
}

describe("CveExceptionTable (T-0369)", () => {
  it("renders the §3.4 columns CVE, scope, reason, expiry, and creator", () => {
    render(
      <CveExceptionTable
        exceptions={[
          exception(),
          exception({
            id: "exc-2",
            cve: "CVE-2026-5678",
            scope: "device",
            scopeTargetId: "device-7",
            reason: "Isolated lab host",
            createdBy: "admin",
          }),
        ]}
      />,
    );

    for (const header of ["CVE", "Scope", "Reason", "Expires", "Created by"]) {
      expect(screen.getByText(header)).toBeTruthy();
    }
    const first = screen.getByTestId("cve-row-exc-1");
    expect(within(first).getByText("CVE-2026-1234")).toBeTruthy();
    expect(within(first).getByText("Vendor patch pending")).toBeTruthy();
    expect(within(first).getByText("operator")).toBeTruthy();
    const second = screen.getByTestId("cve-row-exc-2");
    expect(within(second).getByText("device")).toBeTruthy();
    expect(within(second).getByText("device-7")).toBeTruthy();
    expect(screen.getByTestId("cve-exception-count").textContent).toContain("2");
  });

  it("keeps expired exceptions listed with an expired flag instead of suppressing them", () => {
    const rows = [exception(), exception({ id: "exc-2", cve: "CVE-2026-0001", expiresOn: PAST })];
    render(<CveExceptionTable exceptions={rows} now={NOW} />);

    expect(screen.getByTestId("cve-row-exc-1")).toBeTruthy();
    const lapsed = screen.getByTestId("cve-row-exc-2");
    expect(lapsed).toBeTruthy();
    expect(lapsed.getAttribute("data-expired")).toBe("true");
    expect(screen.getByTestId("cve-row-exc-1").getAttribute("data-expired")).toBe("false");
    const flag = within(lapsed).getByTestId("cve-expired-exc-2");
    expect(flag.textContent).toMatch(/re-surfaced/i);
    expect(screen.queryByTestId("cve-expired-exc-1")).toBeNull();
  });

  it("fires Add exception, Edit, and Remove actions", () => {
    const onAdd = vi.fn();
    const onAction = vi.fn();
    render(<CveExceptionTable exceptions={[exception()]} onAdd={onAdd} onAction={onAction} />);

    fireEvent.click(screen.getByTestId("add-exception-button"));
    expect(onAdd).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("action-edit-exc-1"));
    expect(onAction).toHaveBeenCalledWith("edit", expect.objectContaining({ id: "exc-1" }));

    fireEvent.click(screen.getByTestId("action-remove-exc-1"));
    expect(onAction).toHaveBeenCalledWith("remove", expect.objectContaining({ id: "exc-1" }));
  });

  it("renders loading, error, and empty states", () => {
    const { unmount } = render(<CveExceptionTable loading exceptions={[]} />);
    expect(screen.getByText(/loading cve exceptions/i)).toBeTruthy();
    unmount();

    render(<CveExceptionTable error="boom" exceptions={[]} />);
    expect(screen.getByRole("alert").textContent).toContain("boom");
    cleanup();

    render(<CveExceptionTable exceptions={[]} />);
    expect(screen.getByTestId("empty-cve-exceptions")).toBeTruthy();
  });

  it("treats an unparseable expiry as not expired and passes it through", () => {
    expect(isCveExceptionExpired({ expiresOn: "not-a-date" }, NOW)).toBe(false);
    expect(isCveExceptionExpired({ expiresOn: FUTURE }, NOW)).toBe(false);
    expect(isCveExceptionExpired({ expiresOn: PAST }, NOW)).toBe(true);
    expect(formatExpiry("not-a-date")).toBe("not-a-date");
    expect(formatExpiry(FUTURE)).not.toBe(FUTURE);
  });

  it("uses kit tokens with zero colour literals", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = (await import("node:path")).default;
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "CveExceptionTable.tsx"),
      "utf8",
    );
    for (const literal of ["#fff", "#000", "rgb(", "rgba("]) {
      expect(source).not.toContain(literal);
    }
    expect(source).toContain("var(--");
  });
});
