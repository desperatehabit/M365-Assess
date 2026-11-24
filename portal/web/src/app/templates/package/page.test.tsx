/** @vitest-environment jsdom */

// T-0869 - the Template Package Manager page reads the package list and posts
// an imported bundle through the live BFF endpoints.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import TemplatePackageManagerPage from "./page";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const PACKAGE = {
  id: "pkg-1",
  name: "contoso-baselines",
  version: "1.2.0",
  source: "local",
  itemCount: 1,
  importedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Template Package Manager page", () => {
  it("lists installed packages", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ items: [PACKAGE], totalCount: 1 }));
    render(<TemplatePackageManagerPage fetcher={fetcher as unknown as typeof fetch} />);

    expect(await screen.findByText("contoso-baselines")).toBeTruthy();
    expect(screen.getByText("1.2.0")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith("/v1/template-packages");
  });

  it("imports a bundle and reloads the list", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ package: { id: "pkg-2", name: "imported", version: "2.0.0" }, items: [{}] });
      }
      return jsonResponse({ items: [PACKAGE], totalCount: 1 });
    });
    render(<TemplatePackageManagerPage fetcher={fetcher as unknown as typeof fetch} />);
    await screen.findByText("contoso-baselines");

    fireEvent.change(screen.getByTestId("template-package-bundle"), {
      target: {
        value: JSON.stringify({
          formatVersion: 1,
          name: "imported",
          version: "2.0.0",
          contents: [],
        }),
      },
    });
    fireEvent.click(screen.getByTestId("template-package-import-button"));

    await waitFor(() => {
      expect(screen.getByTestId("template-package-notice").textContent).toContain("Imported imported");
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/template-packages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reports invalid JSON without calling the API", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ items: [], totalCount: 0 }));
    render(<TemplatePackageManagerPage fetcher={fetcher as unknown as typeof fetch} />);
    await screen.findByTestId("template-package-empty");

    fireEvent.change(screen.getByTestId("template-package-bundle"), { target: { value: "{" } });
    fireEvent.click(screen.getByTestId("template-package-import-button"));

    expect((await screen.findByTestId("template-package-error")).textContent).toContain(
      "must be valid JSON",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
