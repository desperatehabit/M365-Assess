import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReportBuilderPage from "../../app/reports/builder/page";
import { V1_BLOCK_TYPES } from "./BlockCanvas";

const DATA_BOUND_TYPES = [
  "findings-table",
  "framework-coverage",
  "secure-score-trend",
  "top-risks",
  "remediation-progress",
  "tenant-summary",
  "run-comparison",
] as const;

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

  it("renders the styled palette, page canvas and settings rail", () => {
    const view = render(<ReportBuilderPage />);
    try {
      const palette = screen.getByTestId("report-palette");
      const canvas = screen.getByTestId("report-canvas-empty");
      const rail = screen.getByTestId("report-settings-rail");

      expect(palette.className).toContain("report-palette");
      expect(screen.getByTestId("report-builder").className).toContain(
        "report-builder",
      );
      expect(canvas.className).toContain("report-canvas");
      expect(canvas.className).toContain("report-canvas-empty");
      expect(rail.className).toContain("report-settings-rail");
      expect(palette.querySelectorAll(".report-palette-button").length).toBe(
        V1_BLOCK_TYPES.length,
      );
      expect(screen.getByTestId("palette-findings-table")).toBeTruthy();
      expect(screen.getByTestId("palette-run-comparison")).toBeTruthy();
      expect(canvas.closest(".report-page")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("adds every data-bound block type from the palette", () => {
    const view = render(<ReportBuilderPage />);
    try {
      for (const type of DATA_BOUND_TYPES) {
        fireEvent.click(screen.getByTestId(`palette-${type}`));
      }
      expect(blockTypesOnCanvas()).toEqual([...DATA_BOUND_TYPES]);
      for (const type of DATA_BOUND_TYPES) {
        const articles = screen
          .getByTestId("report-canvas")
          .querySelectorAll<HTMLElement>(`[data-block-type="${type}"]`);
        expect(articles).toHaveLength(1);
        const blockId = articles[0]!.dataset["testid"]?.replace("report-block-", "");
        expect(screen.getByTestId(`block-controls-${blockId}`)).toBeTruthy();
      }
      expect(screen.getByText(/Live findings load from the selected run/i)).toBeTruthy();
      expect(screen.getByText(/Select two runs to compare findings and drift/i)).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it("reorders blocks by drag and by the keyboard alternative", () => {
    const view = render(<ReportBuilderPage />);
    try {
      fireEvent.click(screen.getByTestId("palette-rich-text"));
      fireEvent.click(screen.getByTestId("palette-findings-table"));
      expect(blockTypesOnCanvas()).toEqual(["rich-text", "findings-table"]);

      const blocks = screen
        .getByTestId("report-canvas")
        .querySelectorAll("[data-block-type]");
      const dataTransfer = {
        effectAllowed: "move",
        dropEffect: "move",
        data: new Map<string, string>(),
        setData(format: string, value: string) {
          this.data.set(format, value);
        },
        getData(format: string) {
          return this.data.get(format) ?? "";
        },
      };
      fireEvent.dragStart(blocks[0]!, { dataTransfer });
      fireEvent.drop(blocks[1]!, { dataTransfer });
      expect(blockTypesOnCanvas()).toEqual(["findings-table", "rich-text"]);

      const canvas = screen.getByTestId("report-canvas");
      const first = canvas.querySelector("[data-block-type='findings-table']")!;
      fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
      expect(blockTypesOnCanvas()).toEqual(["rich-text", "findings-table"]);
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

  it("loads built-in templates as a starting point and saves a copy", async () => {
    const executive = {
      schemaVersion: "v1",
      id: "builtin-executive-summary",
      name: "Executive summary",
      settings: { title: "Executive summary", subtitle: "Board", redact: false },
      pageSetup: { pageSize: "Letter", orientation: "landscape", marginMm: 12 },
      brandingOverrides: { primaryColor: "#123456" },
      blocks: [
        {
          id: "exec-tenant",
          type: "tenant-summary",
          title: "Tenant at a glance",
          static: false,
          dataBinding: { entity: "run-summary" },
          settings: { fields: ["Tenant"] },
        },
        {
          id: "exec-risks",
          type: "top-risks",
          title: "Top risks",
          static: false,
          dataBinding: { entity: "findings" },
          settings: { limit: 5 },
        },
      ],
    };
    const compliance = {
      ...executive,
      id: "builtin-compliance",
      name: "Compliance (per framework)",
      blocks: [
        {
          id: "compliance-coverage",
          type: "framework-coverage",
          title: "Framework coverage",
          static: false,
          dataBinding: { entity: "compliance" },
          settings: { frameworks: [] },
        },
      ],
    };
    let saved: { name?: string; document?: { name?: string } } | undefined;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url);
      if (path === "/v1/report-templates" && init?.method === "POST") {
        saved = JSON.parse(String(init.body));
        return { ok: true, status: 201, json: async () => ({ id: "tpl-copy" }) };
      }
      if (path === "/v1/report-templates") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { id: executive.id, name: executive.name, readOnly: true },
              { id: compliance.id, name: compliance.name, readOnly: true },
            ],
          }),
        };
      }
      if (path === `/v1/report-templates/${executive.id}`) {
        return { ok: true, status: 200, json: async () => ({ readOnly: true, document: executive }) };
      }
      if (path === `/v1/report-templates/${compliance.id}`) {
        return { ok: true, status: 200, json: async () => ({ readOnly: true, document: compliance }) };
      }
      if (path === "/v1/report-templates/tpl-copy") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "tpl-copy",
            document: { ...(saved?.document ?? executive), id: "tpl-copy", name: saved?.name },
          }),
        };
      }
      throw new Error(`unexpected request ${String(init?.method)} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ReportBuilderPage />);
    try {
      fireEvent.click(screen.getByTestId("load-templates"));
      await waitFor(() => {
        expect(
          (screen.getByTestId("template-picker") as HTMLSelectElement).options.length,
        ).toBe(3);
      });
      expect(
        (screen.getByTestId("template-picker") as HTMLSelectElement).textContent,
      ).toContain("(built-in)");

      fireEvent.change(screen.getByTestId("template-picker"), {
        target: { value: executive.id },
      });
      await waitFor(() => {
        expect(blockTypesOnCanvas()).toEqual(["tenant-summary", "top-risks"]);
      });
      expect(screen.getByTestId("builder-status").textContent).toContain("built-in");
      expect(
        (screen.getByTestId("report-setting-title") as HTMLInputElement).value,
      ).toBe("Executive summary");

      // A second built-in loads its own blocks, proving the picker is not a
      // one-template shortcut.
      fireEvent.change(screen.getByTestId("template-picker"), {
        target: { value: compliance.id },
      });
      await waitFor(() => {
        expect(blockTypesOnCanvas()).toEqual(["framework-coverage"]);
      });

      fireEvent.click(screen.getByTestId("save-template"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/v1/report-templates",
          expect.objectContaining({ method: "POST" }),
        );
      });
      expect(fetchMock).not.toHaveBeenCalledWith(
        `/v1/report-templates/${executive.id}`,
        expect.objectContaining({ method: "PATCH" }),
      );
      expect(saved?.name).toBe("Compliance (per framework)");
    } finally {
      view.unmount();
    }
  });

  it("shows a live preview against a selected run", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = String(url);
      if (path === "/v1/runs") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: "run-2",
                tenantId: "t-a",
                tenantDisplayName: "Contoso",
                status: "succeeded",
                startedAt: "2026-02-01T00:00:00.000Z",
                finishedAt: "2026-02-01T00:05:00.000Z",
                summaryCounts: { pass: 10, fail: 4, warning: 2 },
              },
              {
                id: "run-1",
                tenantId: "t-a",
                tenantDisplayName: "Contoso",
                status: "succeeded",
                summaryCounts: { pass: 8, fail: 5, warning: 3 },
              },
            ],
          }),
        };
      }
      if (path === "/v1/runs/run-2/results") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: "f-1",
                status: "Fail",
                severity: "Critical",
                category: "Identity",
                controlName: "Require phishing-resistant MFA",
              },
              {
                id: "f-2",
                status: "Pass",
                severity: "Low",
                category: "Exchange",
                controlName: "Enable DKIM",
              },
            ],
          }),
        };
      }
      if (path === "/v1/tenants/t-a/secure-score/trend") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            snapshots: [
              { at: "2026-01", current: 40, max: 100, percentage: 40 },
              { at: "2026-02", current: 55, max: 100, percentage: 55 },
            ],
          }),
        };
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ReportBuilderPage />);
    try {
      fireEvent.click(screen.getByTestId("palette-findings-table"));
      fireEvent.click(screen.getByTestId("palette-secure-score-trend"));
      fireEvent.click(screen.getByTestId("load-runs"));
      await waitFor(() => {
        expect(screen.getByTestId("live-preview-status").textContent).toContain(
          "2 findings",
        );
      });
      expect(screen.getByText("Require phishing-resistant MFA")).toBeTruthy();
      expect(screen.getByText("Enable DKIM")).toBeTruthy();
      expect(screen.getByText("2026-02")).toBeTruthy();
      expect(screen.getByText("55%")).toBeTruthy();

      const runSelect = screen.getByTestId("preview-run") as HTMLSelectElement;
      expect(runSelect.options.length).toBe(2);
      expect(runSelect.value).toBe("run-2");
    } finally {
      view.unmount();
    }
  });
});
