"use client";

// Contacts administration (EPIC-023 SPEC.md §3.1; T-0445).
// Nav: Email & Exchange → Administration → Contacts. Title "Contacts" with
// the §3.1 table (display name, external address, type, hidden from GAL,
// last modified), the §3.1 filters (search, type, hidden), and the §3.1 row
// actions. Reads go through the T-0442 list route
// (GET /v1/tenants/{id}/contacts); writes go through the T-0443 routes with
// plan preview for edits and explicit confirmation for deletes (SPEC §8).
// `Clone to template` links to the template editor (T-0446) instead of
// duplicating its state. Bulk import opens the ContactImportDialog against
// the T-0444 import route. Write controls are disabled unless `canWrite`
// (RBAC) is set. Strictly uses report theme tokens with zero colour literals.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import { ContactImportDialog } from "../../../components/contacts/ContactImportDialog";
import {
  EMPTY_CONTACTS_FILTERS,
  ContactsTable,
  buildContactsQuery,
  contactTypeLabel,
  formatLastModified,
  type ContactItem,
  type ContactRowAction,
  type ContactsFilters,
} from "../../../components/contacts/ContactsTable";

export type Fetcher = typeof fetch;

interface ContactPlan {
  readonly action: "create" | "edit" | "hideFromGal" | "delete";
  readonly contactId?: string;
  readonly targetName: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

interface ContactCrudResult {
  readonly success: boolean;
  readonly plan: ContactPlan;
  readonly result?: Record<string, unknown>;
}

async function readError(response: Response, fallback: string): Promise<Error> {
  let detail = fallback;
  try {
    const body = (await response.json()) as { message?: string };
    if (body?.message) detail = body.message;
  } catch {
    detail = `${fallback}: HTTP ${response.status}`;
  }
  return new Error(detail);
}

async function fetchContacts(
  tenantId: string,
  filter: ContactsFilters,
  fetcher: Fetcher,
): Promise<ContactItem[]> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/contacts${buildContactsQuery(filter, { limit: 100 })}`,
  );
  if (!response.ok) throw await readError(response, "List contacts");
  const body = (await response.json()) as { items?: ContactItem[] };
  return [...(body.items ?? [])];
}

async function previewContactEdit(
  tenantId: string,
  contactId: string,
  payload: { displayName?: string; externalAddress?: string },
  fetcher: Fetcher,
): Promise<ContactPlan> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/contacts/${encodeURIComponent(contactId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "edit", ...payload, preview: true }),
    },
  );
  if (!response.ok) throw await readError(response, "Preview contact edit");
  const body = (await response.json()) as ContactCrudResult;
  return body.plan;
}

async function applyContactEdit(
  tenantId: string,
  contactId: string,
  payload: { displayName?: string; externalAddress?: string },
  fetcher: Fetcher,
): Promise<ContactCrudResult> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/contacts/${encodeURIComponent(contactId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "edit", ...payload, preview: false }),
    },
  );
  if (!response.ok) throw await readError(response, "Apply contact edit");
  return (await response.json()) as ContactCrudResult;
}

async function setContactHiddenFromGal(
  tenantId: string,
  contactId: string,
  hiddenFromGal: boolean,
  fetcher: Fetcher,
): Promise<ContactCrudResult> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/contacts/${encodeURIComponent(contactId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "hideFromGal", hiddenFromGal, preview: false }),
    },
  );
  if (!response.ok) throw await readError(response, "Hide contact from GAL");
  return (await response.json()) as ContactCrudResult;
}

async function deleteContact(tenantId: string, contactId: string, fetcher: Fetcher): Promise<void> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/contacts/${encodeURIComponent(contactId)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    },
  );
  if (!response.ok) throw await readError(response, "Delete contact");
}

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1400px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
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
  padding: "8px 14px",
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

const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

const bannerStyle: CSSProperties = {
  padding: "12px 16px",
  borderRadius: "6px",
  fontSize: "14px",
};

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay)",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "560px",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const drawerStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  width: "min(560px, 92vw)",
  background: "var(--bg-elev)",
  borderLeft: "1px solid var(--border)",
  boxShadow: "var(--shadow)",
  zIndex: 70,
  overflowY: "auto",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
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

const flagStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: "var(--warning-soft)",
  border: "1px solid var(--warning)",
  color: "var(--warning-text)",
};

interface EditDialogState {
  readonly contact: ContactItem;
  readonly displayName: string;
  readonly externalAddress: string;
}

interface ConfirmDialogState {
  readonly contact: ContactItem;
  readonly mode: "hide" | "delete";
}

export interface ContactsViewProps {
  readonly tenantId: string;
  /** False hides write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

export function ContactsView({ tenantId, canWrite = true, fetcher = fetch }: ContactsViewProps): ReactElement {
  const [filter, setFilter] = useState<ContactsFilters>(EMPTY_CONTACTS_FILTERS);
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<ContactItem | null>(null);
  const [edit, setEdit] = useState<EditDialogState | null>(null);
  const [editPlan, setEditPlan] = useState<ContactPlan | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmDialogState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(
    async (next: ContactsFilters): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        setContacts(await fetchContacts(tenantId, next, fetcher));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [tenantId, fetcher],
  );

  useEffect(() => {
    void load(filter);
  }, [load, filter]);

  function handleAction(action: ContactRowAction, contact: ContactItem): void {
    if (action === "view") {
      setSelected(contact);
      return;
    }
    if (action === "edit") {
      setEdit({ contact, displayName: contact.displayName ?? "", externalAddress: contact.externalAddress ?? "" });
      setEditPlan(null);
      setEditError(null);
      return;
    }
    if (action === "hideFromGal") {
      setConfirm({ contact, mode: "hide" });
      setConfirmError(null);
      return;
    }
    if (action === "cloneToTemplate") {
      window.location.href = `/email/contact-templates?tenantId=${encodeURIComponent(tenantId)}&cloneFrom=${encodeURIComponent(contact.id)}`;
      return;
    }
    if (action === "delete") {
      setConfirm({ contact, mode: "delete" });
      setConfirmError(null);
    }
  }

  async function previewEdit(): Promise<void> {
    if (!edit) return;
    setEditBusy(true);
    setEditError(null);
    try {
      setEditPlan(await previewContactEdit(tenantId, edit.contact.id, {
        displayName: edit.displayName.trim(),
        externalAddress: edit.externalAddress.trim(),
      }, fetcher));
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditBusy(false);
    }
  }

  async function applyEdit(): Promise<void> {
    if (!edit) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const result = await applyContactEdit(tenantId, edit.contact.id, {
        displayName: edit.displayName.trim(),
        externalAddress: edit.externalAddress.trim(),
      }, fetcher);
      if (!result.success) {
        setEditError("The edit was not applied.");
        return;
      }
      setNotice(`Updated ${edit.displayName.trim()}.`);
      setEdit(null);
      setEditPlan(null);
      await load(filter);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditBusy(false);
    }
  }

  async function runConfirm(): Promise<void> {
    if (!confirm) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (confirm.mode === "hide") {
        const next = !confirm.contact.hiddenFromGal;
        const result = await setContactHiddenFromGal(tenantId, confirm.contact.id, next, fetcher);
        if (!result.success) {
          setConfirmError("The change was not applied.");
          return;
        }
        setNotice(`${confirm.contact.displayName ?? confirm.contact.externalAddress} is now ${next ? "hidden from" : "visible in"} the GAL.`);
      } else {
        await deleteContact(tenantId, confirm.contact.id, fetcher);
        setNotice(`Deleted ${confirm.contact.displayName ?? confirm.contact.externalAddress}.`);
      }
      setConfirm(null);
      await load(filter);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmBusy(false);
    }
  }

  const writeDisabled = !canWrite;

  return (
    <div style={pageStyle} data-testid="contacts-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Administration &gt; Contacts</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Contacts
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          List, search, and filter mail contacts and mail users, then act on rows. Edits preview a
          plan before apply; deletes require confirmation.
        </p>
      </div>

      {notice && (
        <div
          style={{ ...bannerStyle, background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)" }}
          data-testid="contacts-notice"
        >
          {notice}
        </div>
      )}
      {error && (
        <div
          role="alert"
          style={{ ...bannerStyle, background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)" }}
          data-testid="contacts-error"
        >
          {error}
        </div>
      )}

      <ContactsTable
        contacts={contacts}
        loading={loading}
        filters={filter}
        onFiltersChange={setFilter}
        onAction={handleAction}
        onImport={() => setImportOpen(true)}
        canWrite={canWrite}
      />

      {selected && (
        <>
          <div style={{ ...overlayStyle, background: "transparent", pointerEvents: "none" }} />
          <aside
            style={drawerStyle}
            role="dialog"
            aria-modal="true"
            aria-label={`Contact ${selected.displayName ?? selected.externalAddress ?? selected.id}`}
            data-testid="contact-drawer"
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, fontSize: "18px" }}>
                {selected.displayName ?? selected.externalAddress ?? "Contact"}
              </h2>
              <button type="button" style={buttonStyle} onClick={() => setSelected(null)} data-testid="contact-drawer-close">
                Close
              </button>
            </div>
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "160px 1fr", gap: "8px", fontSize: "14px" }}>
              <dt style={{ color: "var(--text-soft)" }}>Display name</dt>
              <dd style={{ margin: 0 }}>{selected.displayName ?? "—"}</dd>
              <dt style={{ color: "var(--text-soft)" }}>External address</dt>
              <dd style={{ margin: 0, fontFamily: "var(--font-mono, monospace)" }}>{selected.externalAddress ?? "—"}</dd>
              <dt style={{ color: "var(--text-soft)" }}>Type</dt>
              <dd style={{ margin: 0 }}>{contactTypeLabel(selected.type)}</dd>
              <dt style={{ color: "var(--text-soft)" }}>Hidden from GAL</dt>
              <dd style={{ margin: 0 }}>
                {selected.hiddenFromGal ? <span style={flagStyle}>Hidden</span> : "Visible"}
              </dd>
              <dt style={{ color: "var(--text-soft)" }}>Last modified</dt>
              <dd style={{ margin: 0 }}>{formatLastModified(selected.lastModified)}</dd>
            </dl>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle}
                disabled={writeDisabled}
                title={writeDisabled ? "Requires contacts.write permission" : undefined}
                onClick={() => {
                  const target = selected;
                  setSelected(null);
                  handleAction("edit", target);
                }}
                data-testid="contact-drawer-edit"
              >
                Edit
              </button>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => handleAction("cloneToTemplate", selected)}
                data-testid="contact-drawer-clone"
              >
                Clone to template
              </button>
            </div>
          </aside>
        </>
      )}

      {edit && (
        <div style={overlayStyle} data-testid="contact-edit-dialog" role="dialog" aria-modal="true" aria-label={`Edit ${edit.contact.displayName ?? edit.contact.externalAddress}`}>
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>
              Edit — {edit.contact.displayName ?? edit.contact.externalAddress}
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <label style={{ fontSize: "13px", fontWeight: 600 }} htmlFor="contact-edit-displayname">
                  Display name
                </label>
                <input
                  id="contact-edit-displayname"
                  type="text"
                  value={edit.displayName}
                  onChange={(e) => setEdit({ ...edit, displayName: e.target.value })}
                  style={inputStyle}
                  data-testid="contact-edit-displayname"
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <label style={{ fontSize: "13px", fontWeight: 600 }} htmlFor="contact-edit-address">
                  External address
                </label>
                <input
                  id="contact-edit-address"
                  type="text"
                  value={edit.externalAddress}
                  onChange={(e) => setEdit({ ...edit, externalAddress: e.target.value })}
                  style={inputStyle}
                  data-testid="contact-edit-address"
                />
              </div>
            </div>
            <div data-testid="contact-edit-plan">
              {editBusy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
              {editError && (
                <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }} data-testid="contact-edit-error">
                  {editError}
                </div>
              )}
              {editPlan && (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "14px" }}>
                  <div data-testid="contact-edit-plan-diff">
                    {editPlan.diff.length === 0 ? "No changes." : editPlan.diff.map((line, index) => <div key={index}>{line}</div>)}
                  </div>
                  {editPlan.requiresConfirmation && (
                    <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>
                  )}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  setEdit(null);
                  setEditPlan(null);
                  setEditError(null);
                }}
                data-testid="contact-edit-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                style={{ ...buttonStyle, ...(editBusy ? disabledStyle : {}) }}
                disabled={editBusy}
                onClick={() => void previewEdit()}
                data-testid="contact-edit-preview"
              >
                Preview changes
              </button>
              <button
                type="button"
                style={{ ...primaryButtonStyle, ...(editBusy || !editPlan || !editPlan.valid ? disabledStyle : {}) }}
                disabled={editBusy || !editPlan || !editPlan.valid}
                onClick={() => void applyEdit()}
                data-testid="contact-edit-apply"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div style={overlayStyle} data-testid="contact-confirm-dialog" role="dialog" aria-modal="true" aria-label={confirm.mode === "delete" ? `Delete ${confirm.contact.displayName ?? confirm.contact.externalAddress}` : `Change GAL visibility for ${confirm.contact.displayName ?? confirm.contact.externalAddress}`}>
          <div style={dialogStyle}>
            {confirm.mode === "delete" ? (
              <>
                <h3 style={{ margin: 0 }}>Delete contact</h3>
                <div style={warningBannerStyle} data-testid="contact-delete-warning">
                  <strong>{confirm.contact.displayName ?? confirm.contact.externalAddress}</strong> will be
                  deleted. This action is audited and cannot be undone.
                </div>
              </>
            ) : (
              <>
                <h3 style={{ margin: 0 }}>
                  {confirm.contact.hiddenFromGal ? "Show in GAL" : "Hide from GAL"}
                </h3>
                <p style={{ margin: 0, fontSize: "14px", color: "var(--text-soft)" }}>
                  {confirm.contact.hiddenFromGal
                    ? `${confirm.contact.displayName ?? confirm.contact.externalAddress} is currently hidden from the global address list. Show it again?`
                    : `${confirm.contact.displayName ?? confirm.contact.externalAddress} is currently visible in the global address list. Hide it?`}
                </p>
              </>
            )}
            {confirmError && (
              <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }} data-testid="contact-confirm-error">
                {confirmError}
              </div>
            )}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  setConfirm(null);
                  setConfirmError(null);
                }}
                data-testid="contact-confirm-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                style={confirm.mode === "delete" ? { ...dangerButtonStyle, ...(confirmBusy ? disabledStyle : {}) } : { ...primaryButtonStyle, ...(confirmBusy ? disabledStyle : {}) }}
                disabled={confirmBusy}
                onClick={() => void runConfirm()}
                data-testid="contact-confirm-submit"
              >
                {confirmBusy ? "Working…" : confirm.mode === "delete" ? "Delete" : confirm.contact.hiddenFromGal ? "Show in GAL" : "Hide from GAL"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ContactImportDialog
        tenantId={tenantId}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void load(filter)}
        fetcher={fetcher}
      />
    </div>
  );
}

export default function ContactsPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <ContactsView tenantId={tenantId} />
    </RequireTenant>
  );
}
