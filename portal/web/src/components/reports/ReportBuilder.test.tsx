import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReportBuilderPage from "../../app/reports/builder/page";
import { V1_BLOCK_TYPES } from "./BlockCanvas";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function addBlockOfType(type: string) {
  fireEvent.change(screen.getByTestId("add-block-type"), {
    target: { value: type },
  });
  fireEvent.click(screen.getByTestId("add-block"));
}

function blockTypesOnCanvas(): string[] {
  const canvas = screen.getByTestId("report-canvas");
  return Array.from(
    canvas.querySelectorAll("[data-block-type]"),
  ).map((node) => node.getAttribute("data-block-type") ?? "");
}

describe("ReportBuilder", () => {
  it("adds every v1 block type to the canvas", () => {
    const view = render(<ReportBuilderPage />);
    try {
      expect(screen.getByTestId("report-canvas-empty")).toBeTruthy();
      for (const type of V1_BLOCK_TYPES) addBlockOfType(type);
      expect(blockTypesOnCanvas()).toEqual([...V1_BLOCK_TYPES]);
    } finally {
      view.unmount();
    }
  });

  it("moves blocks up and down and removes them", () => {
    const view = render(<ReportBuilderPage />);
    try {
      addBlockOfType("rich-text");
      addBlockOfType("chart");
      expect(blockTypesOnCanvas()).toEqual(["rich-text", "chart"]);

      fireEvent.click(
        screen.getByRole("button", { name: "Move up: New chart" }),
      );
      expect(blockTypesOnCanvas()).toEqual(["chart", "rich-text"]);

      fireEvent.click(
        screen.getByRole("button", { name: "Move down: New chart" }),
      );
      expect(blockTypesOnCanvas()).toEqual(["rich-text", "chart"]);

      fireEvent.click(
        screen.getByRole("button", { name: "Remove: New chart" }),
      );
      expect(blockTypesOnCanvas()).toEqual(["rich-text"]);
    } finally {
      view.unmount();
    }
  });

  it("edits report settings from the rail", () => {
    const view = render(<ReportBuilderPage />);
    try {
      fireEvent.change(screen.getByTestId("report-setting-title"), {
        target: { value: "Quarterly review" },
      });
      expect(
        (screen.getByTestId("report-setting-title") as HTMLInputElement).value,
      ).toBe("Quarterly review");

      fireEvent.change(screen.getByTestId("report-page-size"), {
        target: { value: "Letter" },
      });
      expect(
        (screen.getByTestId("report-page-size") as HTMLSelectElement).value,
      ).toBe("Letter");
    } finally {
      view.unmount();
    }
  });

  it("saves through the template API and reloads the canvas intact", async () => {
    let savedDocument: unknown;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === "POST" && path === "/v1/report-templates") {
        savedDocument = JSON.parse(String(init.body));
        return { ok: true, status: 201, json: async () => ({ id: "tpl-1" }) };
      }
      if (path === "/v1/report-templates/tpl-1") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "tpl-1", document: (savedDocument as { document: unknown }).document }),
        };
      }
      throw new Error(`unexpected request ${String(init?.method)} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ReportBuilderPage />);
    try {
      addBlockOfType("score-cards");
      addBlockOfType("page-break");
      fireEvent.click(screen.getByTestId("save-template"));

      await waitFor(() => {
        expect(screen.getByTestId("builder-status")).toBeTruthy();
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "/v1/report-templates",
        expect.objectContaining({ method: "POST" }),
      );
      expect(fetchMock).toHaveBeenCalledWith("/v1/report-templates/tpl-1");
      expect(blockTypesOnCanvas()).toEqual(["score-cards", "page-break"]);
    } finally {
      view.unmount();
    }
  });

  it("previews through the server render path with a dialog download", async () => {
    const pdf = new Blob(["%PDF-fake"], { type: "application/pdf" });
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe("/v1/reports/render");
      expect(init?.method).toBe("POST");
      return { ok: true, status: 200, blob: async () => pdf };
    });
    vi.stubGlobal("fetch", fetchMock);
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = () => "blob:preview";

    const view = render(<ReportBuilderPage />);
    try {
      addBlockOfType("rich-text");
      fireEvent.click(screen.getByTestId("preview-pdf"));

      await waitFor(() => {
        expect(screen.getByTestId("preview-dialog")).toBeTruthy();
      });
      expect(screen.getByTestId("preview-frame")).toBeTruthy();
      expect(screen.getByTestId("preview-download")).toBeTruthy();
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      view.unmount();
    }
  });

  it("hands scheduling off to the EPIC-007 scheduler surface", () => {
    const view = render(<ReportBuilderPage />);
    try {
      const link = screen.getByTestId("schedule-link");
      expect(link.getAttribute("href")).toContain("/schedules");
    } finally {
      view.unmount();
    }
  });
});
