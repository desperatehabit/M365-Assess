/** @vitest-environment jsdom */

// Contacts UI (EPIC-023 SPEC.md §3.1; T-0445): table columns/filters/row
// actions and the bulk import dialog with per-row results from the T-0444
// import API.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  EMPTY_CONTACTS_FILTERS,
  ContactsTable,
  buildContactsQuery,
  type ContactItem,
  type ContactsFilters,
} from "./ContactsTable";
import { ContactImportDialog, countCsvRows } from "./ContactImportDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE_CONTACTS: ContactItem[] = [
  {
    id: "contact-1",
    displayName: "Vendor Sales",
    externalAddress: "vendor@example.invalid",
    type: "mailContact",
    hiddenFromGal: false,
    lastModified: "2026-09-20T00:00:00.000Z",
  },
  {
    id: "contact-2",
    displayName: "Former Partner",
    externalAddress: "partner@example.invalid",
    type: "mailUser",
    hiddenFromGal: true,
    lastModified: "2026-08-15T00:00:00.000Z",
  },
];

const BASE_FILTERS: ContactsFilters = EMPTY_CONTACTS_FILTERS;

const IMPORT_REPORT = {
  tenantId: "tenant-1",
  preview: false,
  rows: [
    {
      row: 1,
      displayName: "Vendor Sales",
      externalAddress: "vendor@example.invalid",
      status: "created",
      reason: null,
      contactId: "contact-1",
    },
    {
      row: 2,
      displayName: "Bad Row",
      externalAddress: "not-an-address",
      status: "failed",
      reason: "Invalid external address",
      contactId: null,
    },
  ],
  summary: {
    total: 2,
    created: 1,
    skippedDuplicate: 0,
    invalid: 0,
    failed: 1,
    ready: 0,
  },
};

describe("buildContactsQuery", () => {
  it("maps every §3.1 filter onto the T-0442 query parameters", () => {
    const query = buildContactsQuery(
      { search: "vendor", type: "mailUser", hidden: "hidden" },
      { cursor: "abc", limit: 100 },
    );
    const params = new URLSearchParams(query);
    expect(params.get("search")).toBe("vendor");
    expect(params.get("type")).toBe("mailUser");
    expect(params.get("hidden")).toBe("true");
    expect(params.get("cursor")).toBe("abc");
    expect(params.get("limit")).toBe("100");
  });

  it("maps the visible filter to hidden=false and omits empty filters", () => {
    const visible = new URLSearchParams(buildContactsQuery({ hidden: "visible" }));
    expect(visible.get("hidden")).toBe("false");
    const empty = new URLSearchParams(buildContactsQuery({ search: "", type: "", hidden: "" }));
    expect(empty.toString()).toBe("");
  });
});

describe("countCsvRows", () => {
  it("counts data rows, excluding the header", () => {
    expect(countCsvRows("displayName,externalAddress\na@example.invalid")).toBe(1);
    expect(countCsvRows("displayName,externalAddress\na@example.invalid\nb@example.invalid\n")).toBe(2);
    expect(countCsvRows("displayName,externalAddress")).toBe(0);
    expect(countCsvRows("")).toBe(0);
  });
});

describe("ContactsTable", () => {
  it("renders a loading placeholder while loading", () => {
    render(<ContactsTable loading={true} filters={BASE_FILTERS} />);
    expect(screen.getByTestId("contacts-loading")).toBeTruthy();
  });

  it("renders an error message when the load fails", () => {
    render(<ContactsTable error="Failed to load contacts: HTTP 403" filters={BASE_FILTERS} />);
    expect(screen.getByTestId("contacts-error").textContent).toContain("Failed to load contacts");
  });

  it("renders an empty state when no contacts match", () => {
    render(<ContactsTable contacts={[]} filters={BASE_FILTERS} />);
    expect(screen.getByTestId("empty-contacts-state")).toBeTruthy();
  });

  it("renders the §3.1 columns and row values", () => {
    render(<ContactsTable contacts={SAMPLE_CONTACTS} filters={BASE_FILTERS} />);

    const table = screen.getByRole("table", { name: "Contacts" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers).toEqual([
      "Display name",
      "External address",
      "Type",
      "Hidden from GAL",
      "Last modified",
      "Actions",
    ]);

    const row = screen.getByTestId("contact-row-contact-1");
    expect(within(row).getByText("Vendor Sales")).toBeTruthy();
    expect(row.textContent).toContain("vendor@example.invalid");
    expect(row.textContent).toContain("Mail contact");
    expect(row.textContent).toContain("Visible");
    expect(row.textContent).toContain("2026");

    const hiddenRow = screen.getByTestId("contact-row-contact-2");
    expect(hiddenRow.textContent).toContain("Mail user");
    expect(screen.getByTestId("contact-hidden-badge-contact-2").textContent).toContain("Hidden");
  });

  it("reports every §3.1 filter change back to the page", () => {
    const onFiltersChange = vi.fn();
    render(
      <ContactsTable contacts={SAMPLE_CONTACTS} filters={BASE_FILTERS} onFiltersChange={onFiltersChange} />,
    );

    fireEvent.change(screen.getByTestId("filter-search"), { target: { value: "vendor" } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...BASE_FILTERS, search: "vendor" });

    fireEvent.change(screen.getByTestId("filter-type"), { target: { value: "mailUser" } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...BASE_FILTERS, type: "mailUser" });

    fireEvent.change(screen.getByTestId("filter-hidden"), { target: { value: "hidden" } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...BASE_FILTERS, hidden: "hidden" });
  });

  it("wires every §3.1 row action to the page", () => {
    const onAction = vi.fn();
    render(<ContactsTable contacts={SAMPLE_CONTACTS} filters={BASE_FILTERS} onAction={onAction} />);

    fireEvent.click(screen.getByTestId("contact-view-contact-1"));
    expect(onAction).toHaveBeenLastCalledWith("view", SAMPLE_CONTACTS[0]);

    fireEvent.click(screen.getByTestId("contact-edit-contact-1"));
    expect(onAction).toHaveBeenLastCalledWith("edit", SAMPLE_CONTACTS[0]);

    fireEvent.click(screen.getByTestId("contact-hide-contact-1"));
    expect(onAction).toHaveBeenLastCalledWith("hideFromGal", SAMPLE_CONTACTS[0]);

    fireEvent.click(screen.getByTestId("contact-clone-contact-1"));
    expect(onAction).toHaveBeenLastCalledWith("cloneToTemplate", SAMPLE_CONTACTS[0]);

    fireEvent.click(screen.getByTestId("contact-delete-contact-1"));
    expect(onAction).toHaveBeenLastCalledWith("delete", SAMPLE_CONTACTS[0]);
  });

  it("flips the hide action label for contacts already hidden from the GAL", () => {
    render(<ContactsTable contacts={SAMPLE_CONTACTS} filters={BASE_FILTERS} />);
    expect(screen.getByTestId("contact-hide-contact-2").textContent).toContain("Show in GAL");
  });

  it("disables write actions the caller cannot use (RBAC)", () => {
    render(<ContactsTable contacts={SAMPLE_CONTACTS} filters={BASE_FILTERS} canWrite={false} />);
    expect((screen.getByTestId("contact-edit-contact-1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("contact-hide-contact-1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("contact-delete-contact-1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("contact-view-contact-1") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("contact-clone-contact-1") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("ContactImportDialog", () => {
  it("uploads a CSV and renders per-row pass/fail results from the import API", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(IMPORT_REPORT));
    render(
      <ContactImportDialog tenantId="tenant-1" open={true} onClose={() => undefined} fetcher={fetcher as unknown as typeof fetch} />,
    );

    fireEvent.change(screen.getByTestId("contact-import-file"), {
      target: {
        files: [new File(["displayName,externalAddress\nVendor Sales,vendor@example.invalid"], "contacts.csv", { type: "text/csv" })],
      },
    });

    await waitFor(() => expect(screen.getByTestId("contact-import-csv-count").textContent).toContain("1 contact"));
    fireEvent.click(screen.getByTestId("contact-import-submit"));

    await waitFor(() => expect(screen.getByTestId("contact-import-results")).toBeTruthy());
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/tenants/tenant-1/contacts/import",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { csv?: string; preview?: boolean };
    expect(body.csv).toContain("Vendor Sales,vendor@example.invalid");
    expect(body.preview).toBe(false);

    expect(screen.getByTestId("contact-import-summary").textContent).toContain("1 created");
    expect(screen.getByTestId("contact-import-summary").textContent).toContain("1 failed");

    const createdRow = screen.getByTestId("contact-import-row-1");
    expect(createdRow.textContent).toContain("created");
    expect(createdRow.textContent).toContain("contact-1");

    const failedRow = screen.getByTestId("contact-import-row-2");
    expect(failedRow.textContent).toContain("failed");
    expect(failedRow.textContent).toContain("Invalid external address");
  });

  it("shows an error banner when the import API rejects the upload", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: "csv must be a non-empty string" }, 400));
    render(
      <ContactImportDialog tenantId="tenant-1" open={true} onClose={() => undefined} fetcher={fetcher as unknown as typeof fetch} />,
    );

    fireEvent.change(screen.getByTestId("contact-import-csv-input"), {
      target: { value: "displayName,externalAddress\na@example.invalid" },
    });
    fireEvent.click(screen.getByTestId("contact-import-submit"));

    await waitFor(() => expect(screen.getByTestId("contact-import-error")).toBeTruthy());
    expect(screen.getByTestId("contact-import-error").textContent).toContain("csv must be a non-empty string");
  });
});
