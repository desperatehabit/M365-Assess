// T-0762 — Configured Template Libraries table (EPIC-039 SPEC §3.1).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  TEMPLATE_TYPE_GROUPS,
  TemplateLibraryTable,
  templateTypeLabel,
  type TemplateLibraryItem,
} from "../src/components/TemplateLibraryTable";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function item(overrides: Partial<TemplateLibraryItem> = {}): TemplateLibraryItem {
  return {
    id: "lib-1",
    name: "Require MFA",
    type: "conditional-access",
    body: JSON.stringify({ displayName: "Require MFA" }),
    source: "local",
    repoId: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const handlers = {
  onView: vi.fn(),
  onClone: vi.fn(),
  onExport: vi.fn(),
  onDelete: vi.fn(),
};

describe("TemplateLibraryTable", () => {
  it("renders the §3.1 columns and row actions", () => {
    render(<TemplateLibraryTable items={[item()]} canWrite {...handlers} />);

    const row = screen.getByTestId("library-row-lib-1");
    expect(row.textContent).toContain("Require MFA");
    expect(screen.getByTestId("library-type-lib-1").textContent).toBe("Conditional Access");
    expect(screen.getByTestId("library-source-lib-1").textContent).toBe("local");
    expect(screen.getByTestId("library-view-lib-1").textContent).toBe("View");
    expect(screen.getByTestId("library-clone-lib-1").textContent).toBe("Clone to tenant");
    expect(screen.getByTestId("library-export-lib-1").textContent).toBe("Export");
    expect(screen.getByTestId("library-delete-lib-1").textContent).toBe("Delete");
  });

  it("gates the destructive Delete action on templates.write", () => {
    const { rerender } = render(<TemplateLibraryTable items={[item()]} canWrite={false} {...handlers} />);
    expect(screen.queryByTestId("library-delete-lib-1")).toBeNull();

    rerender(<TemplateLibraryTable items={[item()]} canWrite {...handlers} />);
    expect(screen.getByTestId("library-delete-lib-1")).toBeTruthy();
  });

  it("wires the four row actions", () => {
    render(<TemplateLibraryTable items={[item()]} canWrite {...handlers} />);

    fireEvent.click(screen.getByTestId("library-view-lib-1"));
    expect(handlers.onView).toHaveBeenCalledWith(expect.objectContaining({ id: "lib-1" }));
    fireEvent.click(screen.getByTestId("library-clone-lib-1"));
    expect(handlers.onClone).toHaveBeenCalledWith(expect.objectContaining({ id: "lib-1" }));
    fireEvent.click(screen.getByTestId("library-export-lib-1"));
    expect(handlers.onExport).toHaveBeenCalledWith(expect.objectContaining({ id: "lib-1" }));
    fireEvent.click(screen.getByTestId("library-delete-lib-1"));
    expect(handlers.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "lib-1" }));
  });

  it("shows an empty state with no items", () => {
    render(<TemplateLibraryTable items={[]} />);
    expect(screen.getByTestId("template-library-empty")).toBeTruthy();
  });

  it("covers the §3.1 checkbox groups", () => {
    const labels = TEMPLATE_TYPE_GROUPS.map((group) => group.label);
    for (const label of [
      "Conditional Access",
      "Intune Configuration",
      "Intune Compliance",
      "Intune Protection",
      "Template Standards",
      "Group",
      "Policy",
      "CA Templates",
    ]) {
      expect(labels).toContain(label);
    }
    expect(templateTypeLabel("conditional-access")).toBe("Conditional Access");
    expect(templateTypeLabel("group")).toBe("Group");
    expect(templateTypeLabel("unregistered")).toBe("unregistered");
  });
});
