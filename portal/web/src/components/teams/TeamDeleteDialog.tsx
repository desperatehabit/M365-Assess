"use client";

// Team lifecycle dialogs (EPIC-026 SPEC.md §2 US-2, §3.1, §4.1, §8, §9; T-0506).
// `TeamDeleteDialog` is the destructive delete confirmation: it names the team,
// explains the archive-before-delete alternative, and gates the delete behind an
// explicit checkbox so a delete can never fire without an operator confirming
// the named team (SPEC §8/§9). `TeamLifecycleActions` renders the edit, archive,
// clone, and delete affordances; each write calls the T-0505 lifecycle API
// (PATCH / DELETE .../teams/{teamId} and POST .../archive | .../clone) and then
// invokes `onChanged` so the Teams table can refresh. Strictly uses report theme
// tokens with zero colour literals.

import { useState, type CSSProperties, type ReactElement } from "react";
import type { TeamVisibility } from "./TeamsTable";

export type TeamLifecycleAction = "edit" | "archive" | "clone" | "delete";

export interface TeamLifecycleTarget {
  readonly id: string;
  readonly name: string;
  readonly visibility?: TeamVisibility;
}

export interface TeamAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly result?: "success" | "failure";
}

export interface TeamOperationResult {
  readonly success: boolean;
  readonly state: "succeeded" | "failed";
  readonly operation: TeamLifecycleAction;
  readonly teamId: string;
  readonly targetName: string;
  readonly error: string | null;
  readonly auditEvent?: TeamAuditEvent;
}

export interface TeamDeleteDialogProps {
  readonly isOpen: boolean;
  readonly tenantId: string;
  readonly team: TeamLifecycleTarget | null;
  readonly onClose: () => void;
  readonly onDeleted?: (result: TeamOperationResult) => void;
  readonly fetcher?: typeof fetch;
}

export interface TeamLifecycleActionsProps {
  readonly tenantId: string;
  readonly team: TeamLifecycleTarget;
  readonly onChanged?: (action: TeamLifecycleAction) => void;
  readonly fetcher?: typeof fetch;
}

export function teamLifecycleUrl(tenantId: string, teamId: string, suffix = ""): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}${suffix}`;
}

export function deleteTeamUrl(tenantId: string, teamId: string): string {
  return teamLifecycleUrl(tenantId, teamId);
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay)",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  width: "min(560px, 92vw)",
  maxHeight: "90vh",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "20px",
  fontWeight: 700,
};

const warningBannerStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "13px",
  lineHeight: 1.5,
};

const guidanceStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontSize: "13px",
  lineHeight: 1.5,
};

const confirmRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "8px",
  fontSize: "13px",
  color: "var(--text)",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const labelStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
  color: "var(--text)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--danger)",
  color: "var(--danger-text, var(--text))",
  borderColor: "var(--danger)",
};

const actionBtnStyle: CSSProperties = {
  padding: "6px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  color: "var(--text)",
  fontSize: "13px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const disabledStyle: CSSProperties = {
  opacity: 0.55,
  cursor: "not-allowed",
};

async function sendJson(
  fetcher: typeof fetch,
  url: string,
  method: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetcher(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = (await response.json()) as { message?: string };
      if (payload?.message) detail = payload.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`${method} failed: ${response.status} ${detail}`);
  }
  return response.json();
}

export function TeamDeleteDialog({
  isOpen,
  tenantId,
  team,
  onClose,
  onDeleted,
  fetcher,
}: TeamDeleteDialogProps): ReactElement | null {
  const [confirmed, setConfirmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TeamOperationResult | null>(null);

  if (!isOpen || team === null) {
    return null;
  }

  const runFetch = fetcher ?? fetch;
  const canConfirm = confirmed && !deleting && result === null;

  async function handleConfirm(): Promise<void> {
    if (!canConfirm || team === null) return;
    setDeleting(true);
    setError(null);
    try {
      const body = (await sendJson(runFetch, deleteTeamUrl(tenantId, team.id), "DELETE", {
        confirm: true,
        confirmName: team.name,
      })) as TeamOperationResult;
      setResult(body);
      onDeleted?.(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label={`Delete team ${team.name}`}
      data-testid="team-delete-dialog"
    >
      <div style={dialogStyle}>
        <h2 style={titleStyle} data-testid="team-delete-title">
          Delete team: {team.name}
        </h2>

        <div style={warningBannerStyle} data-testid="team-delete-warning">
          <strong>{team.name}</strong> will be deleted. Deleted teams and their content are
          removed for all members. This action is audited.
        </div>

        <div style={guidanceStyle} data-testid="team-delete-archive-guidance">
          Prefer archiving first: archiving <strong>{team.name}</strong> keeps the team and its
          history read-only and can be reversed, while deletion cannot.
        </div>

        {error && (
          <div
            style={{ ...warningBannerStyle }}
            role="alert"
            data-testid="team-delete-error"
          >
            {error}
          </div>
        )}

        {result === null ? (
          <>
            <label style={confirmRowStyle} htmlFor="team-delete-confirm">
              <input
                id="team-delete-confirm"
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                data-testid="team-delete-confirm-checkbox"
              />
              <span>
                I understand this permanently deletes <strong>{team.name}</strong> and did not
                find archiving sufficient.
              </span>
            </label>

            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={onClose} data-testid="team-delete-cancel">
                Cancel
              </button>
              <button
                type="button"
                style={{ ...dangerButtonStyle, ...(canConfirm ? {} : disabledStyle) }}
                disabled={!canConfirm}
                onClick={() => void handleConfirm()}
                data-testid="team-delete-confirm-button"
              >
                {deleting ? "Deleting…" : `Delete ${team.name}`}
              </button>
            </div>
          </>
        ) : (
          <div data-testid="team-delete-result">
            <div style={{ fontWeight: 600, fontSize: "15px" }}>
              {result.success ? "Team deleted" : "Team deletion failed"}
            </div>
            <div style={{ fontSize: "13px", color: "var(--text-soft)", marginTop: "4px" }}>
              {result.targetName}
              {result.error ? ` — ${result.error}` : ""}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "12px" }}>
              <button type="button" style={buttonStyle} onClick={onClose} data-testid="team-delete-done">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface ActionDialogProps {
  readonly action: Exclude<TeamLifecycleAction, "delete">;
  readonly tenantId: string;
  readonly team: TeamLifecycleTarget;
  readonly fetcher: typeof fetch;
  readonly onClose: () => void;
  readonly onDone: (action: TeamLifecycleAction) => void;
}

function TeamLifecycleDialog({
  action,
  tenantId,
  team,
  fetcher,
  onClose,
  onDone,
}: ActionDialogProps): ReactElement {
  const [name, setName] = useState(action === "clone" ? `${team.name} copy` : team.name);
  const [visibility, setVisibility] = useState<TeamVisibility>(team.visibility ?? "private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !busy && (action !== "clone" || name.trim().length > 0);

  async function run(): Promise<void> {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "edit") {
        await sendJson(fetcher, teamLifecycleUrl(tenantId, team.id), "PATCH", {
          changes: { displayName: name.trim(), visibility },
        });
      } else if (action === "archive") {
        await sendJson(fetcher, teamLifecycleUrl(tenantId, team.id, "/archive"), "POST", {});
      } else {
        await sendJson(fetcher, teamLifecycleUrl(tenantId, team.id, "/clone"), "POST", {
          newName: name.trim(),
        });
      }
      onDone(action);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label={`${action} team ${team.name}`}
      data-testid={`team-lifecycle-dialog-${action}`}
    >
      <div style={dialogStyle}>
        <h2 style={titleStyle}>
          {action === "edit" ? "Edit team" : action === "archive" ? "Archive team" : "Clone team"}:{" "}
          {team.name}
        </h2>

        {action === "edit" && (
          <>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="team-lifecycle-name">
                Team name
              </label>
              <input
                id="team-lifecycle-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={inputStyle}
                data-testid="team-edit-name-input"
              />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="team-lifecycle-visibility">
                Visibility
              </label>
              <select
                id="team-lifecycle-visibility"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as TeamVisibility)}
                style={inputStyle}
                data-testid="team-edit-visibility-select"
              >
                <option value="private">private</option>
                <option value="public">public</option>
              </select>
            </div>
          </>
        )}

        {action === "clone" && (
          <div style={fieldStyle}>
            <label style={labelStyle} htmlFor="team-lifecycle-clone-name">
              New team name
            </label>
            <input
              id="team-lifecycle-clone-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
              data-testid="team-clone-name-input"
            />
          </div>
        )}

        {action === "archive" && (
          <div style={guidanceStyle} data-testid="team-archive-guidance">
            Archiving <strong>{team.name}</strong> keeps it read-only for members and can be
            restored later.
          </div>
        )}

        {error && (
          <div style={warningBannerStyle} role="alert" data-testid={`team-${action}-error`}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
          <button type="button" style={buttonStyle} onClick={onClose} data-testid={`team-${action}-cancel`}>
            Cancel
          </button>
          <button
            type="button"
            style={{ ...primaryButtonStyle, ...(canSubmit ? {} : disabledStyle) }}
            disabled={!canSubmit}
            onClick={() => void run()}
            data-testid={`team-${action}-confirm`}
          >
            {busy
              ? "Working…"
              : action === "edit"
                ? "Save changes"
                : action === "archive"
                  ? "Archive team"
                  : "Clone team"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TeamLifecycleActions({
  tenantId,
  team,
  onChanged,
  fetcher,
}: TeamLifecycleActionsProps): ReactElement {
  const runFetch = fetcher ?? fetch;
  const [active, setActive] = useState<TeamLifecycleAction | null>(null);

  const ACTIONS: readonly { readonly action: TeamLifecycleAction; readonly label: string }[] = [
    { action: "edit", label: "Edit" },
    { action: "archive", label: "Archive" },
    { action: "clone", label: "Clone" },
    { action: "delete", label: "Delete" },
  ];

  function finish(action: TeamLifecycleAction): void {
    setActive(null);
    onChanged?.(action);
  }

  return (
    <div style={{ display: "inline-flex", gap: "6px", flexWrap: "wrap" }} data-testid="team-lifecycle-actions">
      {ACTIONS.map(({ action, label }) => (
        <button
          key={action}
          type="button"
          style={actionBtnStyle}
          onClick={() => setActive(action)}
          aria-label={`${label} ${team.name}`}
          data-testid={`team-lifecycle-${action}`}
        >
          {label}
        </button>
      ))}

      {active !== null && active !== "delete" && (
        <TeamLifecycleDialog
          action={active}
          tenantId={tenantId}
          team={team}
          fetcher={runFetch}
          onClose={() => setActive(null)}
          onDone={finish}
        />
      )}

      <TeamDeleteDialog
        isOpen={active === "delete"}
        tenantId={tenantId}
        team={team}
        onClose={() => setActive(null)}
        onDeleted={() => finish("delete")}
        fetcher={runFetch}
      />
    </div>
  );
}
