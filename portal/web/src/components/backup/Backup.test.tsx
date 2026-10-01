/** @vitest-environment jsdom */

// Backup UI (EPIC-035 SPEC.md §3.1-§3.3; T-0689). Covers the §3.1 table columns
// and Download/Restore/Delete/New backup actions, the New backup dialog, and the
// restore wizard's states: backup pick, full/selective scope, the T-0686 preview
// render, and the destructive confirm that stays blocked until acknowledged.
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  BackupsTable,
  backupLocation,
  backupName,
  backupScope,
  formatBytes,
  type BackupView,
} from "./BackupsTable";
import { NewBackupDialog } from "./NewBackupDialog";
import {
  RestoreWizard,
  type RestorePreview,
} from "./RestoreWizard";
import { createBackup, restoreBackup } from "../../app/backup/page";
import {
  BackupSettingsView,
  draftFrom,
  retentionIsValid,
  type BackupSettings,
} from "../../app/backup/settings/page";

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

const SAMPLE_BACKUPS: readonly BackupView[] = [
  {
    id: "backup-0001",
    name: "Nightly instance backup",
    type: "instance",
    tenantId: null,
    createdAt: "2026-09-30T02:00:00.000Z",
    artifactRef: "backups/backup-0001.zip",
    sizeBytes: 2048,
  },
  {
    id: "backup-0002",
    name: "Tenant alpha config",
    type: "tenant",
    tenantId: "tenant-alpha",
    createdAt: "2026-09-29T02:00:00.000Z",
    artifactRef: "backups/backup-0002.zip",
    sizeBytes: 512,
  },
];

const SAMPLE_PREVIEW: RestorePreview = {
  schemaVersion: 43,
  tables: [
    {
      table: "tenants",
      added: [{ kind: "added", id: "tenant-new" }],
      changed: [{ kind: "changed", id: "tenant-alpha" }],
      removed: [],
    },
    {
      table: "roles",
      added: [],
      changed: [],
      removed: [{ kind: "removed", id: "role-old" }],
    },
  ],
};

describe("BackupsTable", () => {
  it("renders every §3.1 column", () => {
    render(<BackupsTable backups={SAMPLE_BACKUPS} />);

    for (const header of ["Name", "Type", "Scope", "Created", "Size", "Location", "Actions"]) {
      expect(screen.getByText(header)).toBeDefined();
    }
    expect(screen.getByText("Nightly instance backup")).toBeDefined();
    expect(screen.getByText("Tenant alpha config")).toBeDefined();
    expect(screen.getByText("Instance")).toBeDefined();
    expect(screen.getByText("tenant-alpha")).toBeDefined();
    expect(screen.getByText("2.0 KB")).toBeDefined();
  });

  it("renders the Download, Restore, Delete, and New backup actions", () => {
    const onDownload = vi.fn();
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    const onNewBackup = vi.fn();
    render(
      <BackupsTable
        backups={SAMPLE_BACKUPS}
        onDownload={onDownload}
        onRestore={onRestore}
        onDelete={onDelete}
        onNewBackup={onNewBackup}
      />,
    );

    expect(screen.getByTestId("new-backup-button")).toBeDefined();

    fireEvent.click(screen.getByTestId("action-download-backup-0001"));
    fireEvent.click(screen.getByTestId("action-restore-backup-0001"));
    fireEvent.click(screen.getByTestId("action-delete-backup-0001"));

    expect(onDownload).toHaveBeenCalledWith(SAMPLE_BACKUPS[0]);
    expect(onRestore).toHaveBeenCalledWith(SAMPLE_BACKUPS[0]);
    expect(onDelete).toHaveBeenCalledWith(SAMPLE_BACKUPS[0]);
  });

  it("renders loading, error, and empty states", () => {
    const { rerender } = render(<BackupsTable loading={true} />);
    expect(screen.getByText(/loading backups/i)).toBeDefined();

    rerender(<BackupsTable error="Network error" />);
    expect(screen.getByRole("alert")).toBeDefined();

    rerender(<BackupsTable backups={[]} />);
    expect(screen.getByTestId("empty-backups-state")).toBeDefined();
  });

  it("derives readable values when the API omits name/size/location", () => {
    expect(backupName({ ...SAMPLE_BACKUPS[0], name: null })).toBe("backup-0001");
    expect(backupScope({ ...SAMPLE_BACKUPS[1], scope: null })).toBe("tenant-alpha");
    expect(backupScope({ ...SAMPLE_BACKUPS[0], scope: null })).toBe("Instance");
    expect(backupLocation({ ...SAMPLE_BACKUPS[0], location: null })).toBe("backups/backup-0001.zip");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});

describe("NewBackupDialog", () => {
  it("submits an instance backup by default", () => {
    const onSubmit = vi.fn();
    render(<NewBackupDialog open={true} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByTestId("new-backup-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ type: "instance" });
  });

  it("requires a tenant id before creating a tenant backup", () => {
    const onSubmit = vi.fn();
    render(<NewBackupDialog open={true} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByTestId("new-backup-type"), { target: { value: "tenant" } });
    const submit = screen.getByTestId("new-backup-submit");
    expect(submit.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByTestId("new-backup-tenant"), {
      target: { value: "tenant-alpha" },
    });
    expect(submit.hasAttribute("disabled")).toBe(false);

    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ type: "tenant", tenantId: "tenant-alpha" });
  });

  it("renders nothing when closed", () => {
    const { container } = render(<NewBackupDialog open={false} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("RestoreWizard", () => {
  it("walks backup -> scope -> preview -> confirm and gates the destructive confirm", async () => {
    const loadPreview = vi.fn().mockResolvedValue(SAMPLE_PREVIEW);
    const onConfirm = vi.fn();
    render(
      <RestoreWizard
        open={true}
        backups={SAMPLE_BACKUPS}
        backup={SAMPLE_BACKUPS[0]}
        loadPreview={loadPreview}
        onConfirm={onConfirm}
      />,
    );

    await waitFor(() => expect(loadPreview).toHaveBeenCalledWith("backup-0001"));

    // Step 1: pick a backup.
    expect(screen.getByTestId("wizard-panel-backup")).toBeDefined();
    fireEvent.click(screen.getByTestId("wizard-next"));

    // Step 2: scope.
    expect(screen.getByTestId("wizard-panel-scope")).toBeDefined();
    fireEvent.click(screen.getByTestId("scope-full"));
    fireEvent.click(screen.getByTestId("wizard-next"));

    // Step 3: preview renders the T-0686 diff.
    expect(screen.getByTestId("wizard-panel-preview")).toBeDefined();
    expect(screen.getByTestId("preview-table-tenants")).toBeDefined();
    expect(screen.getByTestId("preview-table-roles")).toBeDefined();
    expect(screen.getByTestId("preview-added-tenants").textContent).toContain("1 added");
    expect(screen.getByTestId("preview-changed-tenants").textContent).toContain("1 changed");
    expect(screen.getByTestId("preview-removed-roles").textContent).toContain("1 removed");
    fireEvent.click(screen.getByTestId("wizard-next"));

    // Step 4: confirm is blocked until acknowledged.
    expect(screen.getByTestId("wizard-panel-confirm")).toBeDefined();
    const confirm = screen.getByTestId("wizard-confirm");
    expect(confirm.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByTestId("confirm-ack"));
    expect(confirm.hasAttribute("disabled")).toBe(false);

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ backupId: "backup-0001", confirm: true });
  });

  it("supports a selective scope and only previews the chosen tables", async () => {
    const loadPreview = vi.fn().mockResolvedValue(SAMPLE_PREVIEW);
    const onConfirm = vi.fn();
    render(
      <RestoreWizard
        open={true}
        backups={SAMPLE_BACKUPS}
        backup={SAMPLE_BACKUPS[0]}
        loadPreview={loadPreview}
        onConfirm={onConfirm}
      />,
    );

    await waitFor(() => expect(loadPreview).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("scope-selective"));

    // No table chosen yet: cannot continue.
    expect(screen.getByTestId("wizard-next").hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByTestId("table-checkbox-tenants"));
    expect(screen.getByTestId("wizard-next").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByTestId("wizard-next"));

    expect(screen.getByTestId("preview-table-tenants")).toBeDefined();
    expect(screen.queryByTestId("preview-table-roles")).toBeNull();

    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("confirm-ack"));
    fireEvent.click(screen.getByTestId("wizard-confirm"));

    expect(onConfirm).toHaveBeenCalledWith({
      backupId: "backup-0001",
      tables: ["tenants"],
      confirm: true,
    });
  });

  it("surfaces a preview error and blocks advancing to confirm", async () => {
    const loadPreview = vi.fn().mockRejectedValue(new Error("schema mismatch"));
    render(
      <RestoreWizard
        open={true}
        backups={SAMPLE_BACKUPS}
        backup={SAMPLE_BACKUPS[0]}
        loadPreview={loadPreview}
      />,
    );

    await waitFor(() => expect(loadPreview).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("wizard-next"));

    await waitFor(() => expect(screen.getByTestId("preview-error")).toBeDefined());
    expect(screen.getByTestId("preview-error").textContent).toContain("schema mismatch");
    expect(screen.getByTestId("wizard-next").hasAttribute("disabled")).toBe(true);
  });
});

describe("backup API wiring", () => {
  it("creates an instance backup through POST /v1/backups", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ id: "backup-1" }, 201));
    await createBackup({ type: "instance" }, fetcher as unknown as typeof fetch);

    expect(fetcher).toHaveBeenCalledWith(
      "/v1/backups",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ type: "instance" }),
      }),
    );
  });

  it("restores through POST /v1/backups/{id}/restore with a confirming key", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ backupId: "backup-1" }));
    await restoreBackup(
      { backupId: "backup-1", tables: ["tenants"], confirm: true },
      fetcher as unknown as typeof fetch,
    );

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/backups/backup-1/restore");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect(JSON.parse(String(init.body))).toEqual({ confirm: true, tables: ["tenants"] });
  });
});

describe("BackupSettingsView", () => {
  it("validates retention values", () => {
    expect(retentionIsValid("30")).toBe(true);
    expect(retentionIsValid("0")).toBe(true);
    expect(retentionIsValid("")).toBe(false);
    expect(retentionIsValid("1.5")).toBe(false);
    expect(retentionIsValid("abc")).toBe(false);

    const settings: BackupSettings = {
      id: "default",
      scheduleId: null,
      retentionDays: 30,
      replicationTarget: null,
    };
    expect(draftFrom(settings)).toEqual({
      retentionDays: "30",
      replicationTarget: "",
      scheduleId: "",
    });
  });

  it("reads and writes retention and replication values", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/v1/schedules")) {
          return jsonResponse({ items: [{ id: "sch-1", name: "Nightly backup" }] });
        }
        if (url.includes("/v1/backup-settings") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            retentionDays: number;
            replicationTarget: string | null;
          };
          return jsonResponse({
            id: "default",
            scheduleId: null,
            retentionDays: body.retentionDays,
            replicationTarget: body.replicationTarget,
          });
        }
        return jsonResponse({
          id: "default",
          scheduleId: null,
          retentionDays: 30,
          replicationTarget: "secondary-region",
        });
      },
    ) as unknown as typeof fetch;

    render(<BackupSettingsView fetcher={fetcher} />);

    await waitFor(() =>
      expect((screen.getByTestId("retention-days") as HTMLInputElement).value).toBe("30"),
    );
    expect((screen.getByTestId("replication-target") as HTMLInputElement).value).toBe(
      "secondary-region",
    );

    fireEvent.change(screen.getByTestId("retention-days"), { target: { value: "90" } });
    fireEvent.change(screen.getByTestId("replication-target"), {
      target: { value: "second-tier" },
    });
    fireEvent.click(screen.getByTestId("save-backup-settings"));

    await waitFor(() => expect(screen.getByTestId("save-success")).toBeDefined());

    const putCall = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(
      ([, init]) => init?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse(String(putCall![1].body))).toEqual({
      retentionDays: 90,
      replicationTarget: "second-tier",
      scheduleId: null,
    });
  });

  it("disables save when retention is not a whole number", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/v1/schedules")) return jsonResponse({ items: [] });
      return jsonResponse({
        id: "default",
        scheduleId: null,
        retentionDays: 30,
        replicationTarget: null,
      });
    }) as unknown as typeof fetch;

    render(<BackupSettingsView fetcher={fetcher} />);
    await waitFor(() => expect(screen.getByTestId("retention-days")).toBeDefined());

    fireEvent.change(screen.getByTestId("retention-days"), { target: { value: "not-a-number" } });
    expect(screen.getByTestId("retention-error")).toBeDefined();
    expect(screen.getByTestId("save-backup-settings").hasAttribute("disabled")).toBe(true);
  });
});

describe("zero colour literals", () => {
  it("uses report theme tokens and no hex/rgb/hsl literals in backup sources", () => {
    const files = [
      "src/components/backup/BackupsTable.tsx",
      "src/components/backup/NewBackupDialog.tsx",
      "src/components/backup/RestoreWizard.tsx",
      "src/app/backup/page.tsx",
      "src/app/backup/settings/page.tsx",
    ];

    for (const file of files) {
      const code = readFileSync(join(process.cwd(), file), "utf8");
      expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });

  it("renders only theme tokens in the table markup", () => {
    const { container } = render(
      <BackupsTable backups={SAMPLE_BACKUPS} onDownload={() => {}} onRestore={() => {}} onDelete={() => {}} />,
    );
    const html = container.innerHTML;
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(html).not.toMatch(/rgba?\(/i);
  });
});
