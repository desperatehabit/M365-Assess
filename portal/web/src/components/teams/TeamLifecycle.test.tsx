/** @vitest-environment jsdom */

// Teams lifecycle UI (EPIC-026 SPEC.md §3.1, §4.1, §8, §9; T-0506): the
// add-team wizard (name, owners, members, template, visibility with per-field
// errors), the delete confirmation that names the team and gates on an explicit
// confirm, and the edit/archive/clone affordances that call the T-0505 API and
// signal the table to refresh. Also asserts the components use theme tokens only
// (zero colour literals).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddTeamWizard, type TeamTemplateOption } from "./AddTeamWizard";
import {
  TeamDeleteDialog,
  TeamLifecycleActions,
  type TeamLifecycleTarget,
  type TeamOperationResult,
} from "./TeamDeleteDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TEMPLATES: TeamTemplateOption[] = [
  {
    id: "tpl-1",
    name: "Project Standard",
    owners: ["owner1@example.invalid"],
    members: ["member1@example.invalid", "member2@example.invalid"],
    visibility: "private",
  },
  { id: "tpl-2", name: "Company Wide", visibility: "public" },
];

const TEAM: TeamLifecycleTarget = {
  id: "team-1",
  name: "Project Alpha",
  visibility: "private",
};

function deleteResult(): TeamOperationResult {
  return {
    success: true,
    state: "succeeded",
    operation: "delete",
    teamId: TEAM.id,
    targetName: TEAM.name,
    error: null,
  };
}

describe("AddTeamWizard (T-0506)", () => {
  it("validates fields, submits name/owners/members/template/visibility, and expands the template", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: String(url), method: init?.method ?? "POST", body });
      if (body["preview"] === true) {
        return jsonResponse({
          action: "create",
          targetName: "Project Alpha",
          diff: ["Create team 'Project Alpha' (public)", "Expand template 'tpl-1': 1 owner(s), 2 member(s)"],
          valid: true,
          dryRun: true,
        });
      }
      return jsonResponse({
        success: true,
        plan: {
          action: "create",
          targetName: "Project Alpha",
          diff: [],
          valid: true,
          dryRun: false,
        },
        jobId: "job-1",
      });
    }) as unknown as typeof fetch;
    const onCreated = vi.fn();

    render(
      <AddTeamWizard tenantId="tenant-1" templates={TEMPLATES} onCreated={onCreated} fetcher={fetcher} />,
    );

    fireEvent.click(screen.getByTestId("add-team-preview"));
    expect(screen.getByTestId("add-team-error-name").textContent).toContain("name is required");
    expect(screen.getByTestId("add-team-error-owners").textContent).toContain("owner");
    expect(calls).toHaveLength(0);

    fireEvent.change(screen.getByTestId("add-team-name-input"), { target: { value: "Project Alpha" } });
    fireEvent.change(screen.getByTestId("add-team-owners-input"), {
      target: { value: "owner1@example.invalid" },
    });
    fireEvent.change(screen.getByTestId("add-team-members-input"), {
      target: { value: "member1@example.invalid, member2@example.invalid" },
    });
    fireEvent.change(screen.getByTestId("add-team-template-select"), { target: { value: "tpl-1" } });
    fireEvent.change(screen.getByTestId("add-team-visibility-select"), { target: { value: "public" } });

    expect(screen.getByTestId("add-team-template-summary").textContent).toContain("Project Standard");
    expect(screen.getByTestId("add-team-template-summary").textContent).toContain("1 owner(s)");
    expect(screen.getByTestId("add-team-template-summary").textContent).toContain("2 member(s)");

    fireEvent.click(screen.getByTestId("add-team-preview"));
    await waitFor(() => expect(screen.getByTestId("add-team-step-2")).toBeTruthy());
    expect(screen.getByTestId("add-team-plan-diff").textContent).toContain("Expand template 'tpl-1'");

    const previewCall = calls.find((call) => call.body?.["preview"] === true);
    expect(previewCall?.url).toContain("/v1/tenants/tenant-1/teams");
    expect(previewCall?.body).toMatchObject({
      name: "Project Alpha",
      owners: ["owner1@example.invalid"],
      members: ["member1@example.invalid", "member2@example.invalid"],
      template: "tpl-1",
      visibility: "public",
      preview: true,
    });

    fireEvent.click(screen.getByTestId("add-team-apply"));
    await waitFor(() => expect(screen.getByTestId("add-team-step-3")).toBeTruthy());
    expect(screen.getByTestId("add-team-result").textContent).toContain("Project Alpha");

    const applyCall = calls.find((call) => call.body?.["preview"] === false);
    expect(applyCall?.body).toMatchObject({ preview: false, template: "tpl-1" });
    expect(onCreated).toHaveBeenCalledWith("Project Alpha");
  });

  it("surfaces the route's structured field errors", async () => {
    const fetcher = (async () =>
      jsonResponse(
        {
          message: "validation failed",
          details: [{ field: "name", reason: "required" }],
        },
        400,
      )) as unknown as typeof fetch;

    render(<AddTeamWizard tenantId="tenant-1" fetcher={fetcher} />);

    fireEvent.change(screen.getByTestId("add-team-name-input"), { target: { value: "Project Alpha" } });
    fireEvent.change(screen.getByTestId("add-team-owners-input"), {
      target: { value: "owner1@example.invalid" },
    });
    fireEvent.click(screen.getByTestId("add-team-preview"));

    await waitFor(() =>
      expect(screen.getByTestId("add-team-error-name").textContent).toContain("name is required"),
    );
  });
});

describe("TeamDeleteDialog confirmation gate (T-0506)", () => {
  it("names the team, shows archive guidance, and cannot delete until confirmed", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: String(url), method: init?.method ?? "DELETE", body });
      return jsonResponse(deleteResult());
    }) as unknown as typeof fetch;
    const onDeleted = vi.fn();

    render(
      <TeamDeleteDialog
        isOpen={true}
        tenantId="tenant-1"
        team={TEAM}
        onClose={vi.fn()}
        onDeleted={onDeleted}
        fetcher={fetcher}
      />,
    );

    expect(screen.getByTestId("team-delete-title").textContent).toContain("Project Alpha");
    expect(screen.getByTestId("team-delete-warning").textContent).toContain("Project Alpha");
    expect(screen.getByTestId("team-delete-archive-guidance").textContent).toContain("Project Alpha");

    const confirmButton = screen.getByTestId("team-delete-confirm-button") as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    expect(calls).toHaveLength(0);

    fireEvent.click(confirmButton);
    expect(calls).toHaveLength(0);

    fireEvent.click(screen.getByTestId("team-delete-confirm-checkbox"));
    expect(confirmButton.disabled).toBe(false);

    fireEvent.click(confirmButton);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/v1/tenants/tenant-1/teams/team-1");
    expect(calls[0]?.body).toEqual({ confirm: true, confirmName: "Project Alpha" });
    await waitFor(() => expect(screen.getByTestId("team-delete-result")).toBeTruthy());
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed or without a team", () => {
    const view = render(
      <TeamDeleteDialog isOpen={false} tenantId="tenant-1" team={TEAM} onClose={vi.fn()} />,
    );
    expect(screen.queryByTestId("team-delete-dialog")).toBeNull();
    view.rerender(
      <TeamDeleteDialog isOpen={true} tenantId="tenant-1" team={null} onClose={vi.fn()} />,
    );
    expect(screen.queryByTestId("team-delete-dialog")).toBeNull();
  });
});

describe("TeamLifecycleActions (T-0506)", () => {
  function recordingFetcher(calls: RecordedCall[]): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: String(url), method: init?.method ?? "POST", body });
      return jsonResponse({
        success: true,
        state: "succeeded",
        operation: "edit",
        teamId: TEAM.id,
        targetName: TEAM.name,
        error: null,
      });
    }) as unknown as typeof fetch;
  }

  it("edits a team through the T-0505 API and refreshes the table", async () => {
    const calls: RecordedCall[] = [];
    const onChanged = vi.fn();
    render(
      <TeamLifecycleActions
        tenantId="tenant-1"
        team={TEAM}
        onChanged={onChanged}
        fetcher={recordingFetcher(calls)}
      />,
    );

    fireEvent.click(screen.getByTestId("team-lifecycle-edit"));
    fireEvent.change(screen.getByTestId("team-edit-name-input"), { target: { value: "Renamed" } });
    fireEvent.change(screen.getByTestId("team-edit-visibility-select"), { target: { value: "public" } });
    fireEvent.click(screen.getByTestId("team-edit-confirm"));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("edit"));
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toContain("/v1/tenants/tenant-1/teams/team-1");
    expect(calls[0]?.body).toEqual({ changes: { displayName: "Renamed", visibility: "public" } });
  });

  it("archives a team through the T-0505 API and refreshes the table", async () => {
    const calls: RecordedCall[] = [];
    const onChanged = vi.fn();
    render(
      <TeamLifecycleActions
        tenantId="tenant-1"
        team={TEAM}
        onChanged={onChanged}
        fetcher={recordingFetcher(calls)}
      />,
    );

    fireEvent.click(screen.getByTestId("team-lifecycle-archive"));
    expect(screen.getByTestId("team-archive-guidance").textContent).toContain("Project Alpha");
    fireEvent.click(screen.getByTestId("team-archive-confirm"));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("archive"));
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v1/tenants/tenant-1/teams/team-1/archive");
  });

  it("clones a team through the T-0505 API and refreshes the table", async () => {
    const calls: RecordedCall[] = [];
    const onChanged = vi.fn();
    render(
      <TeamLifecycleActions
        tenantId="tenant-1"
        team={TEAM}
        onChanged={onChanged}
        fetcher={recordingFetcher(calls)}
      />,
    );

    fireEvent.click(screen.getByTestId("team-lifecycle-clone"));
    fireEvent.change(screen.getByTestId("team-clone-name-input"), { target: { value: "Project Beta" } });
    fireEvent.click(screen.getByTestId("team-clone-confirm"));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("clone"));
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v1/tenants/tenant-1/teams/team-1/clone");
    expect(calls[0]?.body).toEqual({ newName: "Project Beta" });
  });

  it("deletes a team only after the confirmation dialog names it", async () => {
    const calls: RecordedCall[] = [];
    const onChanged = vi.fn();
    render(
      <TeamLifecycleActions
        tenantId="tenant-1"
        team={TEAM}
        onChanged={onChanged}
        fetcher={recordingFetcher(calls)}
      />,
    );

    fireEvent.click(screen.getByTestId("team-lifecycle-delete"));
    expect(screen.getByTestId("team-delete-title").textContent).toContain("Project Alpha");
    expect(calls).toHaveLength(0);

    fireEvent.click(screen.getByTestId("team-delete-confirm-button"));
    expect(calls).toHaveLength(0);

    fireEvent.click(screen.getByTestId("team-delete-confirm-checkbox"));
    fireEvent.click(screen.getByTestId("team-delete-confirm-button"));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("delete"));
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.body).toEqual({ confirm: true, confirmName: "Project Alpha" });
  });
});

describe("Teams lifecycle UI theme tokens (T-0506)", () => {
  it("contains zero colour literals in the lifecycle components", () => {
    const files = [
      "src/components/teams/AddTeamWizard.tsx",
      "src/components/teams/TeamDeleteDialog.tsx",
    ];

    for (const file of files) {
      const code = readFileSync(join(process.cwd(), file), "utf8");
      expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });
});
