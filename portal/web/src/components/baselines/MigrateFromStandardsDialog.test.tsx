// T-0189 — migrate from standards dialog.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MigrateFromStandardsDialog } from "./MigrateFromStandardsDialog";
import type { StandardTemplate } from "../../lib/standardsApi";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function template(overrides: Partial<StandardTemplate> = {}): StandardTemplate {
  return {
    id: "tpl-1",
    name: "Server standard",
    kind: "standards",
    actions: { report: true, alert: false, remediate: false },
    autoRemediate: false,
    settings: [
      { key: "CA-REPORTONLY-001", value: 1 },
      { key: "EXO-SHARING-001", value: 2 },
    ],
    scheduleId: null,
    ...overrides,
  };
}

describe("MigrateFromStandardsDialog", () => {
  it("lists templates with their standard counts", () => {
    render(<MigrateFromStandardsDialog templates={[template()]} />);
    const row = screen.getByTestId("migrate-template-tpl-1");
    expect(row.textContent).toContain("Server standard");
    expect(row.textContent).toContain("2 standards");
  });

  it("hands the chosen template to onMigrate", () => {
    const onMigrate = vi.fn();
    render(<MigrateFromStandardsDialog templates={[template()]} onMigrate={onMigrate} />);
    fireEvent.click(screen.getByTestId("migrate-use-tpl-1"));
    expect(onMigrate).toHaveBeenCalledWith(template());
  });

  it("disables actions while a migration is in flight", () => {
    render(<MigrateFromStandardsDialog templates={[template()]} migratingId="tpl-1" />);
    expect((screen.getByTestId("migrate-use-tpl-1") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("migrate-use-tpl-1").textContent).toContain("Migrating");
    expect((screen.getByTestId("migrate-close") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows loading, error, and empty states", () => {
    const { rerender } = render(<MigrateFromStandardsDialog loading />);
    expect(screen.getByTestId("migrate-loading")).toBeTruthy();

    rerender(<MigrateFromStandardsDialog error="boom" />);
    expect(screen.getByTestId("migrate-error").textContent).toContain("boom");

    rerender(<MigrateFromStandardsDialog templates={[]} />);
    expect(screen.getByTestId("migrate-empty")).toBeTruthy();
  });
});
