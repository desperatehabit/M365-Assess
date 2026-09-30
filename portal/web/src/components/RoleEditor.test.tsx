/** @vitest-environment jsdom */
// Tests for the Roles page pattern editor and table (T-0753).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  RoleEditor,
  RolesTab,
  RolesTable,
  allowedRoleActions,
  previewRolePatterns,
  type RoleView,
} from "./RoleEditor";

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

const BASE_ROLE: RoleView = {
  id: "readonly",
  name: "Read only",
  builtin: true,
  include: ["*.Read"],
  exclude: ["CIPP.Admin.*"],
  superadminOnly: false,
  usageCount: 3,
};

const CUSTOM_ROLE: RoleView = {
  id: "role-audit",
  name: "Audit",
  builtin: false,
  include: ["Tenant.Read"],
  exclude: ["Remediation.Apply"],
  superadminOnly: false,
  usageCount: 0,
};

describe("RoleEditor (T-0753)", () => {
  it("renders include and exclude pattern chip lists with counts", () => {
    render(<RoleEditor role={CUSTOM_ROLE} />);

    expect(screen.getByText("Include (1)")).toBeTruthy();
    expect(screen.getByText("Exclude (1)")).toBeTruthy();
    expect(within(screen.getByTestId("include-patterns")).getByText("Tenant.Read")).toBeTruthy();
    expect(within(screen.getByTestId("exclude-patterns")).getByText("Remediation.Apply")).toBeTruthy();
  });

  it("is read-only for a base role: no remove controls, disabled name, no save", () => {
    render(<RoleEditor role={BASE_ROLE} onSave={vi.fn()} />);

    expect(screen.getByTestId("base-role-notice")).toBeTruthy();
    expect((screen.getByTestId("role-name") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Remove *.Read from include" })).toBeNull();
    expect(screen.queryByTestId("save-role")).toBeNull();
    // The preview is still available for viewing a base role.
    expect(screen.getByTestId("preview-permissions")).toBeTruthy();
  });

  it("adds and removes patterns for a custom role", () => {
    render(<RoleEditor role={CUSTOM_ROLE} availablePermissions={["Tenant.Read", "Tenant.Standards.ReadWrite"]} />);

    fireEvent.change(screen.getByLabelText("Search permissions"), {
      target: { value: "standards" },
    });
    const suggestion = screen.getByRole("button", { name: "Tenant.Standards.ReadWrite" });
    fireEvent.click(suggestion);

    expect(within(screen.getByTestId("include-patterns")).getByText("Tenant.Standards.ReadWrite")).toBeTruthy();
    expect(screen.getByText("Include (2)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove Tenant.Read from include" }));
    expect(screen.queryByTestId("include-patterns-Tenant.Read")).toBeNull();
    expect(screen.getByText("Include (1)")).toBeTruthy();
  });

  it("previews effective permissions through POST /v1/roles/preview", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        include: ["*.Read"],
        exclude: [],
        permissions: ["Tenant.Read", "Identity.Role.Read"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RoleEditor role={CUSTOM_ROLE} />);
    fireEvent.click(screen.getByTestId("preview-permissions"));

    await waitFor(() => {
      expect(screen.getByTestId("role-preview")).toBeTruthy();
    });
    const preview = within(screen.getByTestId("role-preview"));
    expect(preview.getByText("Effective permissions (2)")).toBeTruthy();
    expect(preview.getByText("Tenant.Read")).toBeTruthy();
    expect(preview.getByText("Identity.Role.Read")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/roles/preview",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({
      include: ["Tenant.Read"],
      exclude: ["Remediation.Apply"],
    });
  });

  it("reports a preview failure instead of an empty panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ message: "registry unavailable" }, 500)),
    );

    render(<RoleEditor role={CUSTOM_ROLE} />);
    fireEvent.click(screen.getByTestId("preview-permissions"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("registry unavailable");
    });
    expect(screen.queryByTestId("role-preview")).toBeNull();
  });

  it("saves the edited patterns", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RoleEditor role={CUSTOM_ROLE} onSave={onSave} />);

    fireEvent.change(screen.getByTestId("role-name"), { target: { value: "Audit team" } });
    fireEvent.click(screen.getByTestId("save-role"));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        name: "Audit team",
        include: ["Tenant.Read"],
        exclude: ["Remediation.Apply"],
      });
    });
  });
});

describe("previewRolePatterns (T-0753)", () => {
  it("returns the resolved permissions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ include: ["*"], exclude: [], permissions: ["CIPP.Admin"] }),
      ),
    );
    await expect(previewRolePatterns(["*"], [])).resolves.toEqual({
      include: ["*"],
      exclude: [],
      permissions: ["CIPP.Admin"],
    });
  });
});

describe("allowedRoleActions (T-0753)", () => {
  it("shows every action while permissions are unresolved", () => {
    expect(allowedRoleActions(CUSTOM_ROLE, undefined)).toEqual(["view", "clone", "edit", "delete"]);
  });

  it("never offers Edit or Delete for a base role", () => {
    expect(allowedRoleActions(BASE_ROLE, undefined)).toEqual(["view", "clone"]);
  });

  it("limits a read-only caller to View", () => {
    expect(allowedRoleActions(CUSTOM_ROLE, ["CIPP.Roles.Read"])).toEqual(["view"]);
  });
});

describe("RolesTable (T-0753)", () => {
  it("renders the §3.2 columns and pattern counts", () => {
    render(<RolesTable roles={[BASE_ROLE, CUSTOM_ROLE]} />);

    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual(["Name", "Type", "Permissions", "Users", "Actions"]);
    expect(within(screen.getByTestId("role-row-readonly")).getByTestId("role-type-readonly").textContent).toBe("Base");
    expect(within(screen.getByTestId("role-row-role-audit")).getByTestId("role-type-role-audit").textContent).toBe("Custom");
    expect(screen.getByTestId("role-permissions-readonly").textContent).toBe("1 include / 1 exclude");
    expect(screen.getByTestId("role-users-readonly").textContent).toBe("3");
  });

  it("blocks deleting a custom role that is in use", () => {
    render(<RolesTable roles={[{ ...CUSTOM_ROLE, usageCount: 2 }]} />);
    const del = screen.getByRole("button", { name: "Delete Audit" }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.title).toMatch(/In use by 2/);
  });

  it("allows deleting an unused custom role and wires the action", () => {
    const onAction = vi.fn();
    render(<RolesTable roles={[CUSTOM_ROLE]} onAction={onAction} />);
    const del = screen.getByRole("button", { name: "Delete Audit" }) as HTMLButtonElement;
    expect(del.disabled).toBe(false);
    fireEvent.click(del);
    expect(onAction).toHaveBeenCalledWith("delete", CUSTOM_ROLE);
  });

  it("hides Edit and Delete from a read-only caller", () => {
    render(<RolesTable roles={[CUSTOM_ROLE]} permissions={["CIPP.Roles.Read"]} />);
    expect(screen.queryByRole("button", { name: "Edit Audit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Audit" })).toBeNull();
    expect(screen.getByRole("button", { name: "View Audit" })).toBeTruthy();
  });
});

describe("RolesTab (T-0753)", () => {
  it("loads roles and opens the editor read-only for a base role", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ items: [BASE_ROLE, CUSTOM_ROLE] })),
    );
    render(<RolesTab />);

    await waitFor(() => {
      expect(screen.getByTestId("role-row-readonly")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "View Read only" }));
    expect(screen.getByTestId("base-role-notice")).toBeTruthy();
    expect(screen.queryByTestId("save-role")).toBeNull();
  });

  it("clones a base role into a custom role", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && String(url).endsWith("/clone")) {
        return Promise.resolve(
          jsonResponse({ ...CUSTOM_ROLE, id: "clone-1", name: "Read only (copy)" }, 201),
        );
      }
      return Promise.resolve(jsonResponse({ items: [BASE_ROLE] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RolesTab />);

    await waitFor(() => {
      expect(screen.getByTestId("role-row-readonly")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Clone Read only" }));

    await waitFor(() => {
      expect(screen.getByText(/Cloned Read only to Read only \(copy\)/)).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledWith("/v1/roles/readonly/clone", expect.objectContaining({ method: "POST" }));
  });
});
