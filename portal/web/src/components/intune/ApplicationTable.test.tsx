/** @vitest-environment jsdom */
// Tests for ApplicationTable and the Applications page body (T-0325).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  ApplicationTable,
  ApplicationsPage,
  allowedApplicationActions,
  templateFromApp,
  type IntuneAppDetail,
  type IntuneAppItem,
} from "./ApplicationTable";

const TENANT = "11111111-1111-1111-1111-111111111111";

const APPS: IntuneAppItem[] = [
  {
    id: "app-1",
    displayName: "7-Zip",
    appType: "win32",
    odataType: "#microsoft.graph.win32LobApp",
    platform: "windows",
    publisher: "Igor Pavlov",
    assignedCount: 2,
    publishingState: "published",
    lastModifiedDateTime: "2026-09-20T10:00:00Z",
  },
  {
    id: "app-2",
    displayName: "Company Portal",
    appType: "store",
    odataType: "#microsoft.graph.winGetApp",
    platform: "windows",
    publisher: null,
    assignedCount: 0,
    publishingState: "processing",
    lastModifiedDateTime: null,
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("allowedApplicationActions (T-0325)", () => {
  it("shows every action while permissions are unresolved", () => {
    expect(allowedApplicationActions(undefined)).toEqual(["view", "assign", "update", "cloneToTemplate", "delete", "viewDetected"]);
  });

  it("limits a read-only caller to the read actions", () => {
    expect(allowedApplicationActions(["Endpoint.Application.Read"])).toEqual(["view", "viewDetected"]);
  });

  it("grants write actions for the write permission or Remediation.Apply", () => {
    expect(allowedApplicationActions(["Endpoint.Application.ReadWrite"])).toHaveLength(6);
    expect(allowedApplicationActions(["Remediation.Apply"])).toHaveLength(6);
    expect(allowedApplicationActions(["*"])).toHaveLength(6);
  });

  it("gives an unrelated caller nothing", () => {
    expect(allowedApplicationActions(["Endpoint.Intune.Read"])).toEqual([]);
  });
});

describe("ApplicationTable (T-0325)", () => {
  it("renders the §3.1 columns", () => {
    render(<ApplicationTable apps={APPS} />);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Name", "Type", "Platform", "Assigned", "Publishing state", "Last modified", "Actions"]);
    const row = within(screen.getByTestId("app-row-app-1"));
    expect(row.getByText("7-Zip")).toBeTruthy();
    expect(row.getByText("Win32")).toBeTruthy();
    expect(row.getByText("Windows")).toBeTruthy();
    expect(row.getByText("2")).toBeTruthy();
    expect(row.getByText("Published")).toBeTruthy();
    const other = within(screen.getByTestId("app-row-app-2"));
    expect(other.getByText("Store")).toBeTruthy();
    expect(other.getByText("Unassigned")).toBeTruthy();
    expect(other.getByText("Processing")).toBeTruthy();
    expect(other.getByText("—")).toBeTruthy();
  });

  it("renders every documented row action", () => {
    render(<ApplicationTable apps={[APPS[0]!]} />);
    for (const label of ["View", "Assign", "Update", "Clone to template", "Delete", "View detected"]) {
      expect(screen.getByRole("button", { name: `${label} 7-Zip` })).toBeTruthy();
    }
  });

  it("hides write actions from a read-only caller", () => {
    render(<ApplicationTable apps={[APPS[0]!]} permissions={["Endpoint.Application.Read"]} />);
    expect(screen.queryByRole("button", { name: "Assign 7-Zip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete 7-Zip" })).toBeNull();
    expect(screen.getByRole("button", { name: "View detected 7-Zip" })).toBeTruthy();
  });

  it("disables unavailable actions with their reason instead of calling out", () => {
    const onAction = vi.fn();
    render(<ApplicationTable apps={[APPS[0]!]} unavailable={{ delete: "Deleting an app is not available yet" }} onAction={onAction} />);
    const del = screen.getByRole("button", { name: "Delete 7-Zip" }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.title).toMatch(/not available yet/);
    fireEvent.click(del);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("toggles an inline detail on View and passes other actions up", () => {
    const onAction = vi.fn();
    render(<ApplicationTable apps={APPS} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "View 7-Zip" }));
    expect(within(screen.getByTestId("app-detail-app-1")).getByText("#microsoft.graph.win32LobApp")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View 7-Zip" }));
    expect(screen.queryByTestId("app-detail-app-1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Assign Company Portal" }));
    expect(onAction).toHaveBeenCalledWith("assign", APPS[1]);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("reports apps of unsupported types instead of dropping them silently", () => {
    render(<ApplicationTable apps={APPS} unsupported={[{ appType: "office", count: 2 }, { appType: "other", count: 1 }]} />);
    expect(screen.getByTestId("unsupported-notice").textContent).toMatch(/3 apps.*Office: 2, Other: 1/);
  });

  it("shows loading, error, and empty states", () => {
    const { rerender } = render(<ApplicationTable apps={[]} loading />);
    expect(screen.getByText("Loading applications…")).toBeTruthy();
    rerender(<ApplicationTable apps={[]} error="Graph is down" />);
    expect(screen.getByRole("alert").textContent).toBe("Graph is down");
    rerender(<ApplicationTable apps={[]} />);
    expect(screen.getByText("No applications found.")).toBeTruthy();
  });
});

describe("ApplicationsPage (T-0325)", () => {
  function stubApi() {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("view=detected")) {
        return jsonResponse({
          view: "detected",
          totalCount: 1,
          items: [{ id: "d1", displayName: "Notepad++", version: "8.6", publisher: "Don Ho", platform: "windows", deviceCount: 4, sizeInByte: 1024 }],
          nextCursor: null,
        });
      }
      return jsonResponse({ view: "catalog", tenantId: TENANT, totalCount: 2, items: APPS, unsupported: [], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("loads live app data from the list API", async () => {
    const fetchMock = stubApi();
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("app-row-app-1")).toBeTruthy());
    expect(fetchMock.mock.calls[0]![0]).toBe(`/v1/tenants/${TENANT}/apps`);
  });

  it("sends the type and assignment filters to the API", async () => {
    const fetchMock = stubApi();
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("app-row-app-1")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Filter by type"), { target: { value: "store" } });
    fireEvent.change(screen.getByLabelText("Filter by assignment"), { target: { value: "no" } });
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(`/v1/tenants/${TENANT}/apps?type=store&assigned=false`));
  });

  it("surfaces an API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "auth.forbidden", message: "forbidden: missing Endpoint.Application.Read" }, 403)));
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Endpoint.Application.Read/));
  });

  it("deep-links Assign to the assignment flow", async () => {
    stubApi();
    const navigate = vi.fn();
    render(<ApplicationsPage tenantId={TENANT} navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assign 7-Zip" }));
    expect(navigate).toHaveBeenCalledWith(`/intune/applications/assign?tenantId=${TENANT}&appId=app-1`);
  });

  it("opens the detected drawer from a row and hands a detected app to the upload wizard", async () => {
    const fetchMock = stubApi();
    const navigate = vi.fn();
    render(<ApplicationsPage tenantId={TENANT} navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "View detected 7-Zip" }));
    expect((screen.getByLabelText("Search detected apps") as HTMLInputElement).value).toBe("7-Zip");
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("view=detected&search=7-Zip"))).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Create app from detected Notepad++" }));
    expect(navigate).toHaveBeenCalledWith(
      `/intune/applications/upload?tenantId=${TENANT}&fromDetected=Notepad%2B%2B&publisher=Don+Ho&version=8.6`,
    );
  });

  it("hides Add app and the detected hand-off from a read-only caller", async () => {
    stubApi();
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} permissions={["Endpoint.Application.Read"]} />);
    await screen.findByTestId("app-row-app-1");
    expect(screen.queryByRole("button", { name: "+ Add app" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Detected apps" }));
    await screen.findByTestId("detected-row-d1");
    expect(screen.queryByRole("button", { name: /Create app from detected/ })).toBeNull();
  });
});

const DETAIL: IntuneAppDetail = {
  id: "app-1",
  appType: "win32",
  displayName: "7-Zip",
  description: "Archiver",
  publisher: "Igor Pavlov",
  runAsAccount: "system",
  assignmentCount: 2,
  installCommandLine: "7z.exe /S",
  uninstallCommandLine: "uninstall.exe /S",
  deviceRestartBehavior: "suppress",
  applicableArchitectures: ["x64"],
  minimumSupportedWindowsRelease: "21H2",
  detectionRules: [{ type: "file", path: "C:\\Program Files\\7-Zip", fileOrFolderName: "7z.exe", comparisonValue: null }],
};

describe("templateFromApp (T-0843)", () => {
  it("names a Win32 package through %PackageId% and drops empty rule fields", () => {
    const body = templateFromApp(DETAIL, "7-Zip template");
    expect(body).toMatchObject({
      name: "7-Zip template",
      appType: "win32",
      config: { packageId: "%PackageId%", installCommandLine: "7z.exe /S", deviceRestartBehavior: "suppress", applicableArchitectures: ["x64"] },
      variables: [{ name: "PackageId" }],
    });
    expect((body["config"] as { detectionRules: unknown[] }).detectionRules).toEqual([{ type: "file", path: "C:\\Program Files\\7-Zip", fileOrFolderName: "7z.exe" }]);
  });

  it("keeps a Store app's package identifier and needs no variables", () => {
    const body = templateFromApp({ ...DETAIL, appType: "store", packageIdentifier: "9WZDNCRFJ3PZ" }, "CP");
    expect(body).toEqual({
      name: "CP",
      appType: "store",
      config: { displayName: "7-Zip", publisher: "Igor Pavlov", description: "Archiver", runAsAccount: "system", packageIdentifier: "9WZDNCRFJ3PZ" },
      variables: [],
    });
  });
});

describe("ApplicationsPage row actions (T-0843)", () => {
  type Call = { url: string; method: string; body: unknown };
  function stubApi(overrides: (call: Call) => Response | undefined = () => undefined) {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const call = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        const custom = overrides(call);
        if (custom) return custom;
        if (call.url.endsWith("/apps/app-1") && call.method === "GET") return jsonResponse(DETAIL);
        if (call.url.endsWith("/apps/app-1") && call.method === "PATCH") {
          const preview = (call.body as { preview: boolean }).preview;
          return jsonResponse({ applied: !preview, plan: { changedFields: ["displayName"], before: DETAIL, after: { ...DETAIL, displayName: "7-Zip 24" } } });
        }
        if (call.url.endsWith("/apps/app-1") && call.method === "DELETE") return jsonResponse({ applied: true });
        if (call.url.endsWith("/v1/app-templates")) return jsonResponse({ id: "tpl-1", name: (call.body as { name: string }).name }, 201);
        return jsonResponse({ view: "catalog", tenantId: TENANT, totalCount: 2, items: APPS, unsupported: [], nextCursor: null });
      }),
    );
    return calls;
  }

  it("renders no pending actions any more", async () => {
    stubApi();
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} />);
    await screen.findByTestId("app-row-app-1");
    for (const label of ["Update", "Clone to template", "Delete"]) {
      expect((screen.getByRole("button", { name: `${label} 7-Zip` }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("updates an app through preview then save", async () => {
    const calls = stubApi();
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Update 7-Zip" }));
    const dialog = await screen.findByRole("dialog", { name: "Update app" });
    const name = await within(dialog).findByDisplayValue("7-Zip");
    expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: "7-Zip 24" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect((await within(dialog).findByRole("status", { name: "Update preview" })).textContent).toMatch(/displayName/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Update app" })).toBeNull());
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.body)).toEqual([
      { changes: { displayName: "7-Zip 24" }, preview: true },
      { changes: { displayName: "7-Zip 24" }, preview: false },
    ]);
    expect((await screen.findByRole("status", { name: "Notice" })).textContent).toBe("Updated 7-Zip 24.");
  });

  it("deletes with the typed name and warns about assignments", async () => {
    const calls = stubApi();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("7-Zip");
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete 7-Zip" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(prompt.mock.calls[0]![0]).toMatch(/2 assignment/);
    expect(calls.find((c) => c.method === "DELETE")!.body).toEqual({ confirmName: "7-Zip" });
    expect((await screen.findByRole("status", { name: "Notice" })).textContent).toBe("Deleted 7-Zip.");
    prompt.mockRestore();
  });

  it("does nothing when the delete prompt is cancelled", async () => {
    const calls = stubApi();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete 7-Zip" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    prompt.mockRestore();
  });

  it("surfaces the API's refusal of a mistyped name", async () => {
    stubApi((call) =>
      call.method === "DELETE" ? jsonResponse({ code: "intune.app.confirmation_required", message: "type the app name '7-Zip' to confirm deletion" }, 400) : undefined,
    );
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("7-zip");
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete 7-Zip" }));
    expect((await screen.findByRole("status", { name: "Notice" })).textContent).toMatch(/to confirm deletion/);
    prompt.mockRestore();
  });

  it("clones an app to an application template", async () => {
    const calls = stubApi();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("7-Zip standard");
    render(<ApplicationsPage tenantId={TENANT} navigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Clone to template 7-Zip" }));
    expect((await screen.findByRole("status", { name: "Notice" })).textContent).toMatch(/Saved '7-Zip standard'.*PackageId/);
    const post = calls.find((c) => c.url.endsWith("/v1/app-templates"))!;
    expect(post.body).toMatchObject({ name: "7-Zip standard", appType: "win32", config: { packageId: "%PackageId%" } });
    prompt.mockRestore();
  });
});


describe("kit tokens (T-0843)", () => {
  it("uses kit tokens, not literal colours, in the table and the detected drawer", async () => {
    const { container } = render(<ApplicationTable apps={APPS} unsupported={[{ appType: "office", count: 1 }]} error={null} />);
    fireEvent.click(screen.getByRole("button", { name: "View 7-Zip" }));
    for (const style of container.innerHTML.match(/style="[^"]*"/g) ?? []) {
      expect(/#[0-9a-fA-F]{3,6}\b/.test(style), style).toBe(false);
    }
  });
});
