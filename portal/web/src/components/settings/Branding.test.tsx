/** @vitest-environment jsdom */
// T-0729: Branding page with live preview, Logbook, and Advanced Diagnostics.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import BrandingForm, { type BrandingConfig } from "./BrandingForm";
import BrandingPreview from "./BrandingPreview";
import BrandingPage, {
  BRANDING_API_PATH,
  BRANDING_ASSET_API_PATH,
  BRANDING_PREVIEW_API_PATH,
} from "../../app/settings/branding/page";
import LogbookPageView, {
  LOGBOOK_API_PATH,
  buildLogbookQuery,
  logbookExportHref,
} from "../../app/logbook/page";
import AdvancedDiagnosticsPage, {
  DIAGNOSTICS_API_PATH,
} from "../../app/advanced/diagnostics/page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE: BrandingConfig = {
  schemaVersion: "v1",
  colors: { primary: "#123456", secondary: "#654321" },
  logoRef: null,
  coverRef: null,
  watermark: { enabled: false, text: "" },
  footer: { show: true, text: "Sample footer", coverText: "Cover footer" },
  pageNumbers: { show: true },
  presets: [
    { id: "ocean", name: "Ocean", colors: { primary: "#0a4f8a", secondary: "#2e86c1" } },
  ],
  perReportDefaults: {},
};

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function installFetch(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const key = `${method} ${url.split("?")[0]}`;
      const handler = handlers[key];
      if (handler === undefined) throw new Error(`unexpected fetch: ${key}`);
      return handler(url, init);
    }),
  );
}

function brandingHandlers(overrides: Record<string, Handler> = {}): {
  handlers: Record<string, Handler>;
  previewBodies: BrandingConfig[];
} {
  const previewBodies: BrandingConfig[] = [];
  const handlers: Record<string, Handler> = {
    [`GET ${BRANDING_API_PATH}`]: () =>
      jsonResponse({ branding: { ...SAMPLE, logoUrl: null, coverUrl: null } }),
    [`POST ${BRANDING_PREVIEW_API_PATH}`]: (_url, init) => {
      const body = JSON.parse(String(init?.body)) as BrandingConfig;
      previewBodies.push(body);
      return jsonResponse({
        cssOverrides: `<style>:root{--accent: ${body.colors.primary};--secondary: ${body.colors.secondary};}</style>`,
        coverFragment: body.watermark.enabled ? `<div>${body.watermark.text}</div>` : "",
        footerFragment: body.footer.show ? `<style>${body.footer.text}</style>` : "",
      });
    },
    [`PUT ${BRANDING_API_PATH}`]: (_url, init) =>
      jsonResponse({ branding: JSON.parse(String(init?.body)) }),
    ...overrides,
  };
  return { handlers, previewBodies };
}

function FormHarness({
  onUpload,
}: {
  readonly onUpload?: (kind: string, file: File) => void;
}): ReactElement {
  const [value, setValue] = useState<BrandingConfig>(SAMPLE);
  const [kind, setKind] = useState("executive");
  return (
    <div>
      <BrandingForm
        value={value}
        onChange={setValue}
        onUpload={(assetKind, file) => onUpload?.(assetKind, file)}
        reportKind={kind}
        onReportKindChange={setKind}
        onSave={() => undefined}
      />
      <output data-testid="draft-state">{JSON.stringify(value)}</output>
    </div>
  );
}

function draft(): BrandingConfig {
  return JSON.parse(screen.getByTestId("draft-state").textContent ?? "{}") as BrandingConfig;
}

describe("BrandingForm (T-0729 §3.2)", () => {
  it("edits every branding field", () => {
    render(<FormHarness />);

    fireEvent.change(screen.getByTestId("branding-primary"), { target: { value: "#111111" } });
    expect(draft().colors.primary).toBe("#111111");

    fireEvent.change(screen.getByTestId("branding-secondary"), { target: { value: "#222222" } });
    expect(draft().colors.secondary).toBe("#222222");

    fireEvent.click(screen.getByTestId("branding-footer-show"));
    expect(draft().footer.show).toBe(false);
    fireEvent.change(screen.getByTestId("branding-footer-text"), { target: { value: "New footer" } });
    expect(draft().footer.text).toBe("New footer");
    fireEvent.change(screen.getByTestId("branding-footer-cover-text"), {
      target: { value: "New cover footer" },
    });
    expect(draft().footer.coverText).toBe("New cover footer");

    fireEvent.click(screen.getByTestId("branding-page-numbers"));
    expect(draft().pageNumbers.show).toBe(false);

    fireEvent.click(screen.getByTestId("branding-watermark-enabled"));
    expect(draft().watermark.enabled).toBe(true);
    fireEvent.change(screen.getByTestId("branding-watermark-text"), {
      target: { value: "CONFIDENTIAL" },
    });
    expect(draft().watermark.text).toBe("CONFIDENTIAL");

    fireEvent.change(screen.getByTestId("branding-default-primary"), {
      target: { value: "#333333" },
    });
    fireEvent.change(screen.getByTestId("branding-default-secondary"), {
      target: { value: "#444444" },
    });
    fireEvent.change(screen.getByTestId("branding-default-footer-text"), {
      target: { value: "Default footer" },
    });
    fireEvent.change(screen.getByTestId("branding-default-watermark-text"), {
      target: { value: "Default watermark" },
    });
    fireEvent.click(screen.getByTestId("branding-default-page-numbers"));
    const defaults = draft().perReportDefaults["executive"];
    expect(defaults.primary).toBe("#333333");
    expect(defaults.secondary).toBe("#444444");
    expect(defaults.footerText).toBe("Default footer");
    expect(defaults.watermarkText).toBe("Default watermark");
    expect(defaults.showPageNumbers).toBe(true);
  });

  it("applies a preset to the draft colours", () => {
    render(<FormHarness />);
    fireEvent.change(screen.getByTestId("branding-preset"), { target: { value: "ocean" } });
    expect(draft().colors).toEqual({ primary: "#0a4f8a", secondary: "#2e86c1" });
  });

  it("routes logo and cover uploads to the upload handler", () => {
    const onUpload = vi.fn();
    render(<FormHarness onUpload={onUpload} />);
    const logo = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
    const cover = new File([new Uint8Array([4, 5, 6])], "cover.png", { type: "image/png" });

    fireEvent.change(screen.getByTestId("branding-logo-upload"), { target: { files: [logo] } });
    fireEvent.change(screen.getByTestId("branding-cover-upload"), { target: { files: [cover] } });

    expect(onUpload).toHaveBeenNthCalledWith(1, "logo", logo);
    expect(onUpload).toHaveBeenNthCalledWith(2, "cover", cover);
  });

  it("shows the validator message for a rejected upload", () => {
    render(
      <BrandingForm
        value={SAMPLE}
        onChange={() => undefined}
        onUpload={() => undefined}
        uploadError="Branding upload must be one of png, jpeg, webp"
      />,
    );
    expect(screen.getByTestId("branding-upload-error").textContent).toContain(
      "Branding upload must be one of png, jpeg, webp",
    );
  });
});

describe("BrandingPreview (T-0729 §4.2)", () => {
  it("renders the draft watermark, footer, page numbers, and server fragments", () => {
    render(
      <BrandingPreview
        draft={{
          ...SAMPLE,
          watermark: { enabled: true, text: "CONFIDENTIAL" },
          footer: { show: true, text: "Footer line", coverText: "" },
        }}
        logoUrl="/v1/branding/assets/logo.png"
        fragments={{
          cssOverrides: "<style>:root{--accent: #123456;}</style>",
          coverFragment: "",
          footerFragment: "",
        }}
      />,
    );
    expect(screen.getByTestId("branding-preview-watermark").textContent).toBe("CONFIDENTIAL");
    expect(screen.getByTestId("branding-preview-footer-text").textContent).toBe("Footer line");
    expect(screen.getByTestId("branding-preview-page-numbers").textContent).toBe("Page 1 of 1");
    expect(screen.getByTestId("branding-preview-logo").getAttribute("src")).toBe(
      "/v1/branding/assets/logo.png",
    );
    expect(screen.getByTestId("branding-preview-fragments").innerHTML).toContain("--accent");
  });
});

describe("BrandingPage (T-0729)", () => {
  it("previews the unsaved draft before saving", async () => {
    const { handlers, previewBodies } = brandingHandlers();
    installFetch(handlers);

    render(<BrandingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("branding-form")).toBeTruthy();
    });
    await waitFor(() => {
      expect(previewBodies.length).toBeGreaterThan(0);
    });

    fireEvent.change(screen.getByTestId("branding-primary"), { target: { value: "#abcdef" } });

    await waitFor(() => {
      expect(previewBodies.some((body) => body.colors.primary === "#abcdef")).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId("branding-preview-fragments").innerHTML).toContain("#abcdef");
    });

    const calls = (
      globalThis.fetch as unknown as { mock: { calls: Array<[unknown, RequestInit | undefined]> } }
    ).mock.calls;
    expect(calls.some(([, init]) => init?.method === "PUT")).toBe(false);

    fireEvent.click(screen.getByTestId("branding-save"));
    await waitFor(() => {
      expect(screen.getByTestId("branding-status").textContent).toBe("Branding saved.");
    });
  });

  it("rejects an invalid upload with the validator's message", async () => {
    const { handlers } = brandingHandlers({
      [`POST ${BRANDING_ASSET_API_PATH}/logo`]: () =>
        jsonResponse(
          {
            code: "branding.unsupported_type",
            message: "Branding upload must be one of png, jpeg, webp",
            details: [{ field: "asset", reason: "branding.unsupported_type" }],
          },
          400,
        ),
    });
    installFetch(handlers);

    render(<BrandingPage />);
    await waitFor(() => {
      expect(screen.getByTestId("branding-form")).toBeTruthy();
    });

    const bad = new File([new Uint8Array([1])], "logo.svg", { type: "image/svg+xml" });
    fireEvent.change(screen.getByTestId("branding-logo-upload"), { target: { files: [bad] } });

    await waitFor(() => {
      expect(screen.getByTestId("branding-upload-error").textContent).toContain(
        "Branding upload must be one of png, jpeg, webp",
      );
    });
  });

  it("previews a valid upload with its resolved URL", async () => {
    const { handlers, previewBodies } = brandingHandlers({
      [`POST ${BRANDING_ASSET_API_PATH}/logo`]: () =>
        jsonResponse(
          { ref: "branding/logo-abc.png", kind: "logo", url: "/v1/branding/assets/logo-abc.png" },
          201,
        ),
    });
    installFetch(handlers);

    render(<BrandingPage />);
    await waitFor(() => {
      expect(screen.getByTestId("branding-form")).toBeTruthy();
    });

    const good = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("branding-logo-upload"), { target: { files: [good] } });

    await waitFor(() => {
      expect(screen.getByTestId("branding-preview-logo").getAttribute("src")).toBe(
        "/v1/branding/assets/logo-abc.png",
      );
    });
    await waitFor(() => {
      expect(previewBodies.some((body) => body.logoRef === "branding/logo-abc.png")).toBe(true);
    });
  });
});

describe("Logbook (T-0729 §3.5, §4.4)", () => {
  const entry = {
    id: "evt-1",
    timestamp: "2026-09-25T14:30:00.000Z",
    actor: "user-1",
    actorType: "user",
    tenantId: "tenant-1",
    action: "branding.update",
    targetType: "branding",
    targetId: "default",
    result: "success" as const,
    error: null,
    correlationId: "corr-1",
  };

  it("builds filter query strings and the CSV export link", () => {
    const filters = {
      actor: "user-1",
      action: "",
      tenant: "tenant-1",
      result: "failure" as const,
      from: "2026-09-01",
      to: "",
    };
    expect(buildLogbookQuery(filters)).toBe(
      "actor=user-1&tenant=tenant-1&result=failure&from=2026-09-01",
    );
    expect(logbookExportHref(filters)).toBe(
      `${LOGBOOK_API_PATH}?actor=user-1&tenant=tenant-1&result=failure&from=2026-09-01&format=csv`,
    );
  });

  it("renders filters, search, detail with correlation id, and export", async () => {
    let lastUrl = "";
    installFetch({
      [`GET ${LOGBOOK_API_PATH}`]: (url) => {
        lastUrl = url;
        return jsonResponse({ items: [entry], nextCursor: null, totalCount: 1 });
      },
    });

    render(<LogbookPageView />);

    await waitFor(() => {
      expect(screen.getByTestId("logbook-row-evt-1")).toBeTruthy();
    });
    expect(screen.getByTestId("logbook-filter-actor")).toBeTruthy();
    expect(screen.getByTestId("logbook-filter-action")).toBeTruthy();
    expect(screen.getByTestId("logbook-filter-tenant")).toBeTruthy();
    expect(screen.getByTestId("logbook-filter-result")).toBeTruthy();
    expect(screen.getByTestId("logbook-filter-from")).toBeTruthy();
    expect(screen.getByTestId("logbook-filter-to")).toBeTruthy();
    expect(screen.getByTestId("logbook-row-evt-1").textContent).toContain("corr-1");
    expect(screen.getByTestId("logbook-export").getAttribute("href")).toContain("format=csv");

    fireEvent.change(screen.getByTestId("logbook-filter-actor"), { target: { value: "user-1" } });
    fireEvent.click(screen.getByTestId("logbook-search"));

    await waitFor(() => {
      expect(lastUrl).toContain("actor=user-1");
    });
    await waitFor(() => {
      expect(screen.getByTestId("logbook-export").getAttribute("href")).toContain("actor=user-1");
    });

    fireEvent.click(screen.getByTestId("logbook-detail-evt-1"));
    expect(screen.getByTestId("logbook-detail-panel-evt-1").textContent).toContain("corr-1");
  });
});

describe("Advanced diagnostics (T-0729 §3.5)", () => {
  it("renders health, cache, and timers", async () => {
    installFetch({
      [`GET ${DIAGNOSTICS_API_PATH}`]: () =>
        jsonResponse({
          health: {
            status: "healthy",
            serviceVersion: "2.14.0",
            storage: { reachable: true, status: "ok", schemaVersion: 63 },
            queue: { reachable: true, status: "ok", depth: 3 },
            queueDepth: 3,
            workerCount: 4,
            lastRunAt: "2026-09-25T14:30:00.000Z",
          },
          cache: { configured: true, entries: 12 },
          timers: [
            {
              name: "standards",
              cron: "0 0 */12 * * *",
              type: "standards",
              timezone: "UTC",
              command: "Invoke-StandardsRun",
              lastRunAt: "2026-09-25T00:00:00.000Z",
              nextRunAt: "2026-09-25T12:00:00.000Z",
            },
          ],
        }),
    });

    render(<AdvancedDiagnosticsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("diagnostics-health")).toBeTruthy();
    });
    expect(screen.getByTestId("diagnostics-health").textContent).toContain("2.14.0");
    expect(screen.getByTestId("diagnostics-health").textContent).toContain("Connected (v63)");
    expect(screen.getByTestId("diagnostics-cache").textContent).toContain("12");
    expect(screen.getByTestId("diagnostics-timers").textContent).toContain("standards");
    expect(screen.getByTestId("diagnostics-timer-standards").textContent).toContain(
      "2026-09-25T12:00:00.000Z",
    );
  });
});

describe("Theme tokens (05-programming.md §4)", () => {
  it("uses only theme tokens and no colour literals in the new surfaces", () => {
    const files = [
      "src/components/settings/BrandingForm.tsx",
      "src/components/settings/BrandingPreview.tsx",
      "src/app/settings/branding/page.tsx",
      "src/app/logbook/page.tsx",
      "src/app/advanced/diagnostics/page.tsx",
    ];
    for (const relative of files) {
      const code = readFileSync(join(process.cwd(), relative), "utf8");
      expect(code, `${relative} contains a hex colour literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${relative} contains an rgb colour literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${relative} contains an hsl colour literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });
});
