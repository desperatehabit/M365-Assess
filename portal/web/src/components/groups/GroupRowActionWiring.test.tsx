/** @vitest-environment jsdom */

// T-0883 — every Groups row action reaches a real page or BFF route with the right method,
// path, and body, and shows a real success or error state. fetch is stubbed at the network
// edge so the method/path/body assertions run through groupsApi and the dialogs unchanged.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const push = vi.fn();
let routeParams: Record<string, string> = { id: "grp-1" };
let routeQuery = "tenantId=tenant-1";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useParams: () => routeParams,
  useSearchParams: () => new URLSearchParams(routeQuery),
}));

vi.mock("../../lib/useCurrentTenant", () => ({
  useCurrentTenantId: () => "tenant-1",
  resolveTenantId: (q: string | null | undefined, current: string | null) => q?.trim() || current || "",
}));

import GroupsPage from "../../app/identity/groups/page";
import EditGroupPage from "../../app/identity/groups/[id]/edit/page";
import BulkMembershipPage from "../../app/identity/groups/[id]/bulk/page";
import type { GroupItem } from "../../lib/groupsApi";

function group(overrides: Partial<GroupItem> = {}): GroupItem {
  return {
    id: "grp-1",
    name: "Finance Team",
    displayName: "Finance Team",
    description: "Finance staff",
    type: "m365",
    groupType: "m365",
    membershipCount: 5,
    ownerCount: 1,
    hiddenFromAddressListsEnabled: false,
    deliveryManagementEnabled: false,
    dynamicRule: "",
    isDynamic: false,
    mail: "finance@example.invalid",
    ...overrides,
  };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

type Responder = (call: Call) => { status?: number; json: unknown } | undefined;

let calls: Call[] = [];
let responder: Responder = () => undefined;

function listPage(items: GroupItem[], nextCursor: string | null = null) {
  return { tenantId: "tenant-1", totalCount: items.length, items, nextCursor };
}

beforeEach(() => {
  calls = [];
  routeParams = { id: "grp-1" };
  routeQuery = "tenantId=tenant-1";
  push.mockReset();
  responder = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://bff.invalid");
      const call: Call = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname + url.search,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const answer = responder(call) ?? { json: listPage([group()]) };
      const status = answer.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => answer.json,
      } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIST_PATH = "/v1/tenants/tenant-1/groups?limit=1000";
const writes = () => calls.filter((c) => c.method !== "GET");

async function renderList() {
  render(<GroupsPage />);
  await screen.findByTestId("group-row-grp-1");
}

describe("Groups row actions: navigation (T-0883)", () => {
  it("loads the groups through the BFF list route", async () => {
    await renderList();
    expect(calls[0]).toMatchObject({ method: "GET", path: LIST_PATH });
  });

  it("Edit navigates to the edit page under the group id", async () => {
    await renderList();
    fireEvent.click(screen.getByTestId("action-edit-grp-1"));
    expect(push).toHaveBeenCalledWith("/identity/groups/grp-1/edit?tenantId=tenant-1");
  });

  it("Manage members and Manage owners open the bulk page on the matching role", async () => {
    await renderList();
    fireEvent.click(screen.getByTestId("action-manageMembers-grp-1"));
    expect(push).toHaveBeenLastCalledWith("/identity/groups/grp-1/bulk?tenantId=tenant-1&role=members");
    fireEvent.click(screen.getByTestId("action-manageOwners-grp-1"));
    expect(push).toHaveBeenLastCalledWith("/identity/groups/grp-1/bulk?tenantId=tenant-1&role=owners");
  });

  it("View opens the detail drawer", async () => {
    await renderList();
    fireEvent.click(screen.getByTestId("action-view-grp-1"));
    expect(screen.getByTestId("group-detail-drawer")).toBeTruthy();
  });

  it("Convert says it is not available instead of doing nothing, and sends no write", async () => {
    await renderList();
    fireEvent.click(screen.getByTestId("action-convert-grp-1"));
    expect(screen.getByTestId("groups-notice").textContent).toContain("Convert is not available");
    expect(push).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });
});

describe("Groups row actions: Delete (T-0883)", () => {
  it("requires the exact group name, then DELETEs with confirmName and reloads the list", async () => {
    await renderList();
    fireEvent.click(screen.getByTestId("action-delete-grp-1"));
    const submit = screen.getByTestId("group-delete-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("group-delete-confirm-input"), { target: { value: "Finance" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("group-delete-confirm-input"), { target: { value: "Finance Team" } });
    expect(submit.disabled).toBe(false);

    responder = (call) =>
      call.method === "DELETE"
        ? { json: { success: true, plan: { diff: [] }, result: { deleted: true, id: "grp-1" } } }
        : { json: listPage([]) };
    fireEvent.click(submit);

    expect(await screen.findByTestId("group-delete-success")).toBeTruthy();
    expect(writes()).toEqual([
      {
        method: "DELETE",
        path: "/v1/tenants/tenant-1/groups/grp-1",
        body: { confirmName: "Finance Team", preview: false },
      },
    ]);
    // The list is read again, and the deleted group is gone from the table.
    await waitFor(() => expect(screen.queryByTestId("group-row-grp-1")).toBeNull());
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("previews the delete with preview: true and shows the plan, without deleting", async () => {
    await renderList();
    fireEvent.click(screen.getByTestId("action-delete-grp-1"));
    responder = (call) =>
      call.method === "DELETE"
        ? { json: { action: "delete", diff: ["Delete group 'Finance Team' (grp-1)"], dryRun: true } }
        : undefined;
    fireEvent.click(screen.getByTestId("group-delete-preview"));
    const plan = await screen.findByTestId("group-delete-plan");
    expect(plan.textContent).toContain("Delete group 'Finance Team' (grp-1)");
    expect(writes()).toEqual([
      {
        method: "DELETE",
        path: "/v1/tenants/tenant-1/groups/grp-1",
        body: { confirmName: "Finance Team", preview: true },
      },
    ]);
    expect(screen.queryByTestId("group-delete-success")).toBeNull();
  });

  it("shows the BFF error and no success when the delete fails", async () => {
    await renderList();
    fireEvent.click(screen.getByTestId("action-delete-grp-1"));
    fireEvent.change(screen.getByTestId("group-delete-confirm-input"), { target: { value: "Finance Team" } });
    responder = (call) =>
      call.method === "DELETE"
        ? { status: 502, json: { code: "worker.failed", message: "Graph refused the delete" } }
        : undefined;
    fireEvent.click(screen.getByTestId("group-delete-submit"));
    expect((await screen.findByTestId("group-delete-error")).textContent).toContain("Graph refused the delete");
    expect(screen.queryByTestId("group-delete-success")).toBeNull();
    // The group is still listed and no reload was triggered.
    expect(screen.getByTestId("group-row-grp-1")).toBeTruthy();
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("Cancel closes the dialog without a write", async () => {
    await renderList();
    fireEvent.click(screen.getByTestId("action-delete-grp-1"));
    fireEvent.click(screen.getByTestId("group-delete-cancel"));
    expect(screen.queryByTestId("group-delete-dialog")).toBeNull();
    expect(writes()).toHaveLength(0);
  });
});

describe("Groups row actions: Hide from GAL and Delivery management (T-0883)", () => {
  it("Hide from GAL renders the dialog from the row's state and POSTs the gal route", async () => {
    await renderList();
    fireEvent.click(screen.getByTestId("action-gal-grp-1"));
    const dialog = screen.getByTestId("gal-delivery-dialog");
    expect(within(dialog).getByText("Hide from GAL")).toBeTruthy();
    expect((screen.getByTestId("input-hide-gal") as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByTestId("input-hide-gal"));
    responder = (call) =>
      call.method === "POST"
        ? { json: { success: true, plan: {}, before: {}, after: {}, auditEvent: { action: "group.gal" } } }
        : { json: listPage([group({ hiddenFromAddressListsEnabled: true })]) };
    fireEvent.click(screen.getByTestId("btn-apply"));

    expect(await screen.findByTestId("apply-result")).toBeTruthy();
    expect(writes()).toEqual([
      {
        method: "POST",
        path: "/v1/tenants/tenant-1/groups/grp-1/gal",
        body: { hiddenFromAddressListsEnabled: true, preview: false },
      },
    ]);
    // The list is reloaded so the Hidden from GAL column reflects the change.
    await waitFor(() => expect(screen.getByTestId("group-row-grp-1").textContent).toContain("Yes"));
  });

  it("Hide from GAL starts checked for a group that is already hidden", async () => {
    responder = () => ({ json: listPage([group({ hiddenFromAddressListsEnabled: true })]) });
    await renderList();
    fireEvent.click(screen.getByTestId("action-gal-grp-1"));
    expect((screen.getByTestId("input-hide-gal") as HTMLInputElement).checked).toBe(true);
  });

  it("Hide from GAL previews with ?preview=true and shows an error when the apply fails", async () => {
    await renderList();
    fireEvent.click(screen.getByTestId("action-gal-grp-1"));
    fireEvent.click(screen.getByTestId("input-hide-gal"));

    responder = (call) =>
      call.method === "POST"
        ? { json: { target: "gal", dryRun: true, diff: ["Set HiddenFromAddressListsEnabled: False -> True"] } }
        : undefined;
    fireEvent.click(screen.getByTestId("btn-preview"));
    expect((await screen.findByTestId("preview-diff")).textContent).toContain("False -> True");
    expect(writes()[0]).toEqual({
      method: "POST",
      path: "/v1/tenants/tenant-1/groups/grp-1/gal?preview=true",
      body: { hiddenFromAddressListsEnabled: true, preview: true },
    });

    responder = (call) =>
      call.method === "POST" ? { status: 502, json: { code: "worker.failed", message: "EXO session failed" } } : undefined;
    fireEvent.click(screen.getByTestId("btn-apply"));
    expect((await screen.findByTestId("error-message")).textContent).toContain("EXO session failed");
    expect(screen.queryByTestId("apply-result")).toBeNull();
  });

  it("Delivery management POSTs the delivery route with the sender-auth flag and send-on-behalf list", async () => {
    responder = () => ({ json: listPage([group({ deliveryManagementEnabled: true })]) });
    await renderList();
    fireEvent.click(screen.getByTestId("action-delivery-grp-1"));
    expect(within(screen.getByTestId("gal-delivery-dialog")).getByText("Delivery Management")).toBeTruthy();
    // The dialog starts from the row's delivery-management state.
    expect((screen.getByTestId("input-require-sender-auth") as HTMLInputElement).checked).toBe(true);

    fireEvent.change(screen.getByTestId("input-send-on-behalf"), { target: { value: "alice@example.invalid" } });
    fireEvent.click(screen.getByTestId("btn-add-send-on-behalf"));

    responder = (call) =>
      call.method === "POST" ? { json: { success: true, plan: {}, before: {}, after: {}, auditEvent: { action: "group.delivery" } } } : undefined;
    fireEvent.click(screen.getByTestId("btn-apply"));

    expect(await screen.findByTestId("apply-result")).toBeTruthy();
    expect(writes()).toEqual([
      {
        method: "POST",
        path: "/v1/tenants/tenant-1/groups/grp-1/delivery",
        body: {
          requireSenderAuthenticationEnabled: true,
          grantSendOnBehalfTo: ["alice@example.invalid"],
          preview: false,
        },
      },
    ]);
  });

  it("Delivery management shows the BFF error when the apply fails", async () => {
    await renderList();
    fireEvent.click(screen.getByTestId("action-delivery-grp-1"));
    responder = (call) =>
      call.method === "POST" ? { status: 400, json: { code: "validation.failed", message: "grantSendOnBehalfTo must be an array" } } : undefined;
    fireEvent.click(screen.getByTestId("btn-apply"));
    expect((await screen.findByTestId("error-message")).textContent).toContain("grantSendOnBehalfTo must be an array");
    expect(screen.queryByTestId("apply-result")).toBeNull();
  });
});

describe("Groups row actions: Edit page (T-0883)", () => {
  it("finds the group by following the list cursor and PATCHes the preview, then the apply, and returns to the list", async () => {
    responder = (call) => {
      if (call.method === "GET" && call.path.includes("cursor=page-2")) {
        return { json: listPage([group()]) };
      }
      if (call.method === "GET") {
        return { json: listPage([group({ id: "grp-0", name: "Other" })], "page-2") };
      }
      if (call.method === "PATCH" && (call.body as { preview?: boolean }).preview) {
        return { json: { action: "edit", targetName: "Finance Team 2", diff: ["Change displayName: 'Finance Team' -> 'Finance Team 2'"], valid: true, dryRun: true, requiresConfirmation: false } };
      }
      return { json: { success: true, plan: { action: "edit", diff: [], valid: true, dryRun: false, requiresConfirmation: false }, result: {} } };
    };

    render(<EditGroupPage />);
    const name = (await screen.findByTestId("input-group-name")) as HTMLInputElement;
    expect(name.value).toBe("Finance Team");
    // An existing group's GAL / delivery settings are not edited here.
    expect(screen.queryByTestId("input-hidden-gal")).toBeNull();
    expect(screen.queryByTestId("input-delivery-mgmt")).toBeNull();

    fireEvent.change(name, { target: { value: "Finance Team 2" } });
    fireEvent.click(screen.getByTestId("btn-preview-plan"));
    expect((await screen.findByTestId("diff-item-0")).textContent).toContain("Finance Team 2");

    fireEvent.click(screen.getByTestId("btn-confirm-apply"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/identity/groups?tenantId=tenant-1"));

    expect(writes()).toEqual([
      {
        method: "PATCH",
        path: "/v1/tenants/tenant-1/groups/grp-1",
        body: { displayName: "Finance Team 2", description: "Finance staff", preview: true },
      },
      {
        method: "PATCH",
        path: "/v1/tenants/tenant-1/groups/grp-1",
        body: { displayName: "Finance Team 2", description: "Finance staff", preview: false },
      },
    ]);
  });

  it("discards a stale preview when a field changes after it", async () => {
    responder = (call) =>
      call.method === "PATCH"
        ? { json: { action: "edit", targetName: "x", diff: ["Change displayName"], valid: true, dryRun: true, requiresConfirmation: false } }
        : undefined;
    render(<EditGroupPage />);
    const name = (await screen.findByTestId("input-group-name")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "A" } });
    fireEvent.click(screen.getByTestId("btn-preview-plan"));
    await screen.findByTestId("plan-diff-preview");
    fireEvent.change(name, { target: { value: "B" } });
    expect(screen.queryByTestId("plan-diff-preview")).toBeNull();
    expect(screen.queryByTestId("btn-confirm-apply")).toBeNull();
  });

  it("shows the BFF error and does not navigate when the save fails", async () => {
    responder = (call) => {
      if (call.method === "PATCH" && (call.body as { preview?: boolean }).preview) {
        return { json: { action: "edit", targetName: "x", diff: ["Change displayName"], valid: true, dryRun: true, requiresConfirmation: false } };
      }
      if (call.method === "PATCH") {
        return { status: 403, json: { code: "forbidden", message: "forbidden: missing groups.write permission" } };
      }
      return undefined;
    };
    render(<EditGroupPage />);
    fireEvent.change(await screen.findByTestId("input-group-name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("btn-preview-plan"));
    fireEvent.click(await screen.findByTestId("btn-confirm-apply"));
    expect((await screen.findByTestId("form-error")).textContent).toContain("missing groups.write");
    expect(push).not.toHaveBeenCalled();
  });

  it("does not offer Confirm & Apply when the preview has no changes", async () => {
    responder = (call) =>
      call.method === "PATCH"
        ? { json: { action: "edit", targetName: "Finance Team", diff: [], valid: true, dryRun: true, requiresConfirmation: false } }
        : undefined;
    render(<EditGroupPage />);
    await screen.findByTestId("input-group-name");
    fireEvent.click(screen.getByTestId("btn-preview-plan"));
    expect(await screen.findByTestId("plan-no-changes")).toBeTruthy();
    expect((screen.getByTestId("btn-confirm-apply") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a not-found error for an unknown group id", async () => {
    routeParams = { id: "grp-missing" };
    render(<EditGroupPage />);
    expect((await screen.findByTestId("edit-group-error")).textContent).toContain("grp-missing");
    expect(screen.queryByTestId("group-form")).toBeNull();
  });
});

describe("Groups row actions: bulk page role (T-0883)", () => {
  it("opens on Owners for ?role=owners and on Members otherwise", async () => {
    routeQuery = "tenantId=tenant-1&role=owners";
    render(<BulkMembershipPage />);
    expect((screen.getByTestId("select-bulk-role") as HTMLSelectElement).value).toBe("owners");
    cleanup();

    routeQuery = "tenantId=tenant-1&role=members";
    render(<BulkMembershipPage />);
    expect((screen.getByTestId("select-bulk-role") as HTMLSelectElement).value).toBe("members");
  });
});
