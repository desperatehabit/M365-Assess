// T-0762 — Template Library page (EPIC-039 SPEC §3.1, §6, §8).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TemplateLibraryPage from "../src/app/templates/page";
import type { TemplateLibraryItem } from "../src/components/TemplateLibraryTable";

afterEach(() => {
  cleanup();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  vi.restoreAllMocks();
});

beforeEach(() => {
  // jsdom has no URL.createObjectURL; Export only needs it to not throw.
  // Patch the methods so the URL constructor itself keeps working.
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:mock");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

function libraryItem(overrides: Partial<TemplateLibraryItem> = {}): TemplateLibraryItem {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockLibraryApi(items: readonly TemplateLibraryItem[] = [libraryItem()]) {
  return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.startsWith("/v1/template-library") && method === "GET") {
      const type = new URL(url, "http://localhost").searchParams.get("type");
      const filtered = type ? items.filter((item) => item.type === type) : items;
      return jsonResponse({ items: filtered });
    }
    if (url.startsWith("/v1/template-library/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ message: "not found" }, 404);
  });
}

describe("TemplateLibraryPage", () => {
  it("renders the source picker, the §3.1 type checkbox groups, and the table", () => {
    render(<TemplateLibraryPage fetcher={mockLibraryApi() as unknown as typeof fetch} />);

    expect(screen.getByTestId("template-library-page")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Template Library" })).toBeTruthy();
    expect(screen.getByTestId("template-library-source")).toBeTruthy();
    for (const testId of [
      "type-conditional-access",
      "type-intune-configuration",
      "type-intune-compliance",
      "type-intune-protection",
      "type-template-standards",
      "type-group",
      "type-policy",
      "type-ca-templates",
    ]) {
      expect(screen.getByTestId(testId), testId).toBeTruthy();
    }
    expect(screen.getByRole("heading", { name: "Configured Template Libraries" })).toBeTruthy();
  });

  it("lists local items and filters by type through GET /v1/template-library", async () => {
    const fetcher = mockLibraryApi([
      libraryItem(),
      libraryItem({ id: "lib-2", name: "All users group", type: "group" }),
    ]);
    render(<TemplateLibraryPage fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("library-row-lib-1")).toBeTruthy());
    expect(screen.getByTestId("library-row-lib-2")).toBeTruthy();

    fireEvent.click(screen.getByTestId("type-conditional-access"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/v1/template-library?type=group"));
    expect(screen.queryByTestId("library-row-lib-1")).toBeNull();
    expect(screen.getByTestId("library-row-lib-2")).toBeTruthy();

    // The refetch after unchecking queries the remaining types only.
    const conditionalQueries = fetcher.mock.calls.filter((call) =>
      String(call[0]).includes("type=conditional-access"),
    );
    expect(conditionalQueries).toHaveLength(1);
  });

  it("browsing performs no tenant writes (GET only until an action is taken)", async () => {
    const fetcher = mockLibraryApi();
    render(<TemplateLibraryPage fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("library-row-lib-1")).toBeTruthy());

    for (const call of fetcher.mock.calls) {
      expect(call[1]?.method ?? "GET").toBe("GET");
    }
  });

  it("View opens a read-only dialog with the template body", async () => {
    render(<TemplateLibraryPage fetcher={mockLibraryApi() as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("library-row-lib-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("library-view-lib-1"));
    expect(screen.getByTestId("template-library-view-dialog")).toBeTruthy();
    expect(screen.getByTestId("template-library-view-body").textContent).toContain("Require MFA");

    fireEvent.click(screen.getByTestId("template-library-view-close"));
    expect(screen.queryByTestId("template-library-view-dialog")).toBeNull();
  });

  it("Export emits a single template file", async () => {
    render(<TemplateLibraryPage fetcher={mockLibraryApi() as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByTestId("library-row-lib-1")).toBeTruthy());

    const created: string[] = [];
    (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mockImplementation((blob: Blob) => {
      created.push(blob.type);
      return "blob:mock";
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    fireEvent.click(screen.getByTestId("library-export-lib-1"));
    expect(created).toEqual(["application/json"]);
    expect(clickSpy).toHaveBeenCalled();
    expect(screen.getByTestId("template-library-notice").textContent).toContain("Exported");
  });

  it("Clone to tenant defers to the T-0765 drawer when wired", async () => {
    const onClone = vi.fn();
    render(
      <TemplateLibraryPage
        fetcher={mockLibraryApi() as unknown as typeof fetch}
        onClone={onClone}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("library-row-lib-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("library-clone-lib-1"));
    expect(onClone).toHaveBeenCalledWith(expect.objectContaining({ id: "lib-1" }));
  });

  it("hides Delete without templates.write and deletes with it", async () => {
    const fetcher = mockLibraryApi();
    const { rerender } = render(
      <TemplateLibraryPage fetcher={fetcher as unknown as typeof fetch} canWrite={false} />,
    );
    await waitFor(() => expect(screen.getByTestId("library-row-lib-1")).toBeTruthy());
    expect(screen.queryByTestId("library-delete-lib-1")).toBeNull();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    rerender(<TemplateLibraryPage fetcher={fetcher as unknown as typeof fetch} canWrite />);
    fireEvent.click(screen.getByTestId("library-delete-lib-1"));

    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        "/v1/template-library/lib-1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(confirmSpy).toHaveBeenCalled();
  });

  it("surfaces the BFF 403 when Delete is attempted without templates.write", async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.startsWith("/v1/template-library") && method === "GET") {
        return jsonResponse({ items: [libraryItem()] });
      }
      if (url.startsWith("/v1/template-library/") && method === "DELETE") {
        return jsonResponse({ message: "Missing required permission 'templates.write'" }, 403);
      }
      return jsonResponse({ message: "not found" }, 404);
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TemplateLibraryPage fetcher={fetcher as unknown as typeof fetch} canWrite />);
    await waitFor(() => expect(screen.getByTestId("library-row-lib-1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("library-delete-lib-1"));
    await waitFor(() =>
      expect(screen.getByTestId("template-library-error").textContent).toContain("templates.write"),
    );
    expect(confirmSpy).toHaveBeenCalled();
  });
});
