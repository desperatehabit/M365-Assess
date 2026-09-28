"use client";

// EnrollmentProfiles — Intune → Autopilot & Enrollment → Enrollment Profiles (EPIC-017 SPEC.md §3.5; T-0846).
// Token status first: every Apple ADE token and Android enrollment token with its expiry, and
// the API's `alerts` (expiring within 30 days, or expired) called out above the fold. Then the
// profiles (T-0329): create from a template or a JSON body (an Apple profile picks its ADE
// token), edit, delete (typed name), and assign Apple profiles to device serials — each through
// preview then apply. Templates can be created and removed at the bottom. Kit tokens only.
import React, { useCallback, useEffect, useState } from "react";
import { badge, errorText, parseJsonObject, requestJson, splitLines, tenantPath, ui } from "./intuneFetch";

export type Platform = "apple-ade" | "android-enterprise";

export interface EnrollmentToken {
  readonly platform: Platform;
  readonly id: string;
  readonly name: string;
  readonly expiresAt: string | null;
  readonly daysRemaining: number | null;
  readonly state: "ok" | "expiring" | "expired" | "unknown";
}

export interface EnrollmentProfile {
  readonly platform: Platform;
  readonly id: string;
  readonly displayName: string;
  readonly profileType: string;
  readonly depOnboardingSettingId?: string;
  readonly tokenState?: string;
}

export interface EnrollmentTemplate {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
  readonly profileJson: Record<string, unknown>;
}

export interface EnrollmentList {
  readonly profiles: readonly EnrollmentProfile[];
  readonly tokens: readonly EnrollmentToken[];
  readonly alerts: readonly EnrollmentToken[];
}

export interface EnrollmentApi {
  list(tenantId: string): Promise<EnrollmentList>;
  create(tenantId: string, body: Record<string, unknown>): Promise<{ preview: boolean; plan: Record<string, unknown> }>;
  update(tenantId: string, id: string, body: Record<string, unknown>): Promise<{ preview: boolean; plan: Record<string, unknown> }>;
  remove(tenantId: string, id: string, body: Record<string, unknown>): Promise<unknown>;
  assign(tenantId: string, id: string, body: Record<string, unknown>): Promise<{ preview: boolean; plan: Record<string, unknown> }>;
  listTemplates(): Promise<readonly EnrollmentTemplate[]>;
  createTemplate(body: Record<string, unknown>): Promise<EnrollmentTemplate>;
  removeTemplate(id: string): Promise<void>;
}

export function createEnrollmentApi(): EnrollmentApi {
  const live = (t: string, id?: string) => tenantPath(t, `/enrollment-profiles${id ? `/${encodeURIComponent(id)}` : ""}`);
  const tpl = (id?: string) => `/v1/enrollment-profile-templates${id ? `/${encodeURIComponent(id)}` : ""}`;
  return {
    list: (t) => requestJson(live(t)),
    create: (t, body) => requestJson(live(t), { method: "POST", body }),
    update: (t, id, body) => requestJson(live(t, id), { method: "PATCH", body }),
    remove: (t, id, body) => requestJson(live(t, id), { method: "DELETE", body }),
    assign: (t, id, body) => requestJson(`${live(t, id)}/assign`, { method: "POST", body }),
    listTemplates: async () => (await requestJson<{ items: EnrollmentTemplate[] }>(tpl())).items,
    createTemplate: (body) => requestJson(tpl(), { method: "POST", body }),
    removeTemplate: (id) => requestJson(tpl(id), { method: "DELETE" }),
  };
}

const PLATFORM_LABELS: Record<Platform, string> = { "apple-ade": "Apple ADE", "android-enterprise": "Android Enterprise" };

export function tokenMessage(t: EnrollmentToken): string {
  const label = `${PLATFORM_LABELS[t.platform]} token '${t.name}'`;
  if (t.state === "expired") return `${label} expired ${t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : ""}. Devices cannot enroll until it is renewed.`.replace(" .", ".");
  return `${label} expires in ${t.daysRemaining} day${t.daysRemaining === 1 ? "" : "s"}.`;
}

type Action =
  | { kind: "create" }
  | { kind: "edit"; profile: EnrollmentProfile }
  | { kind: "assign"; profile: EnrollmentProfile };

export interface EnrollmentProfilesPageProps {
  readonly tenantId: string;
  readonly api?: EnrollmentApi;
}

export function EnrollmentProfilesPage({ tenantId, api }: EnrollmentProfilesPageProps) {
  const [client] = useState(() => api ?? createEnrollmentApi());
  const [data, setData] = useState<EnrollmentList | null>(null);
  const [templates, setTemplates] = useState<readonly EnrollmentTemplate[]>([]);
  const [action, setAction] = useState<Action | null>(null);
  const [platform, setPlatform] = useState<Platform>("android-enterprise");
  const [depId, setDepId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [newTemplate, setNewTemplate] = useState<{ name: string; platform: Platform; json: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await client.list(tenantId));
      setTemplates(await client.listTemplates());
    } catch (err) {
      setError(errorText(err, "Failed to load enrollment profiles."));
    }
  }, [client, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const appleTokens = (data?.tokens ?? []).filter((t) => t.platform === "apple-ade");
  const open = (a: Action) => {
    setAction(a);
    setPlan(null);
    setError(null);
    setTemplateId("");
    setText(a.kind === "edit" ? JSON.stringify({ displayName: a.profile.displayName }, null, 2) : "");
    if (a.kind === "create") setDepId(appleTokens[0]?.id ?? "");
  };

  function buildBody(preview: boolean): Record<string, unknown> | null {
    if (!action) return null;
    if (action.kind === "assign") {
      const serials = splitLines(text);
      if (serials.length === 0) return (setError("Enter at least one serial number."), null);
      return { platform: "apple-ade", depOnboardingSettingId: action.profile.depOnboardingSettingId, serialNumbers: serials, preview };
    }
    const target = action.kind === "create" ? platform : action.profile.platform;
    let profile: Record<string, unknown> | undefined;
    if (text.trim()) {
      const parsed = parseJsonObject(text);
      if ("error" in parsed) return (setError(parsed.error), null);
      profile = parsed.value;
    }
    if (action.kind === "create") {
      if (!templateId && !profile) return (setError("Choose a template or enter a profile body."), null);
      if (target === "apple-ade" && !depId) return (setError("Choose the ADE token the profile belongs to."), null);
      return {
        ...(templateId ? { templateId } : { platform: target }),
        ...(profile ? { profile } : {}),
        ...(target === "apple-ade" ? { depOnboardingSettingId: depId } : {}),
        preview,
      };
    }
    return {
      platform: target,
      profile: profile ?? {},
      ...(action.profile.depOnboardingSettingId ? { depOnboardingSettingId: action.profile.depOnboardingSettingId } : {}),
      preview,
    };
  }

  async function run(preview: boolean) {
    const body = buildBody(preview);
    if (!body || !action) return;
    setError(null);
    try {
      const result =
        action.kind === "create"
          ? await client.create(tenantId, body)
          : action.kind === "edit"
            ? await client.update(tenantId, action.profile.id, body)
            : await client.assign(tenantId, action.profile.id, body);
      if (preview) setPlan(result.plan);
      else {
        setNotice(action.kind === "assign" ? "Devices assigned." : "Saved.");
        setAction(null);
        setPlan(null);
        await load();
      }
    } catch (err) {
      setError(errorText(err, "The change failed."));
    }
  }

  async function remove(p: EnrollmentProfile) {
    const typed = window.prompt(`Type the profile name '${p.displayName}' to delete it.`);
    if (!typed) return;
    try {
      await client.remove(tenantId, p.id, {
        platform: p.platform,
        confirmName: typed,
        ...(p.depOnboardingSettingId ? { depOnboardingSettingId: p.depOnboardingSettingId } : {}),
      });
      setNotice(`Deleted ${p.displayName}.`);
      await load();
    } catch (err) {
      setError(errorText(err, "Delete failed."));
    }
  }

  async function saveTemplate() {
    if (!newTemplate) return;
    const parsed = parseJsonObject(newTemplate.json);
    if ("error" in parsed) return setError(parsed.error);
    try {
      await client.createTemplate({ name: newTemplate.name, platform: newTemplate.platform, profileJson: parsed.value });
      setNewTemplate(null);
      await load();
    } catch (err) {
      setError(errorText(err, "Save failed."));
    }
  }

  const planText = (p: Record<string, unknown>) => {
    const after = p["after"] as Record<string, unknown> | null | undefined;
    const serials = after?.["assignedSerialNumbers"] as string[] | undefined;
    if (serials) return `Assign ${serials.length} device${serials.length === 1 ? "" : "s"}: ${serials.join(", ")}`;
    return after ? `Profile: ${String(after["displayName"] ?? "")}` : "No changes.";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", color: "var(--text)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: "18px" }}>Enrollment profiles</h2>
        <button type="button" style={ui.primary} onClick={() => open({ kind: "create" })}>
          + New profile
        </button>
      </div>

      {data && data.alerts.length > 0 && (
        <section aria-label="Token alerts" style={{ ...ui.panel, background: "var(--warn-soft)", color: "var(--warn-text)" }}>
          {data.alerts.map((t) => (
            <div key={`${t.platform}-${t.id}`} data-testid={`alert-${t.id}`}>
              <span style={badge(t.state)}>{t.state}</span> {tokenMessage(t)}
            </div>
          ))}
        </section>
      )}
      {notice && <div role="status" style={ui.notice}>{notice}</div>}
      {error && <div role="alert" style={ui.error}>{error}</div>}

      {action && (
        <section aria-label="Enrollment change" style={ui.panel}>
          <strong>{action.kind === "create" ? "New enrollment profile" : action.kind === "edit" ? `Edit ${action.profile.displayName}` : `Assign devices to ${action.profile.displayName}`}</strong>
          {action.kind === "create" && (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <select aria-label="Platform" style={ui.input} value={platform} onChange={(e) => { setPlatform(e.target.value as Platform); setTemplateId(""); setPlan(null); }}>
                <option value="android-enterprise">Android Enterprise</option>
                <option value="apple-ade">Apple ADE</option>
              </select>
              {platform === "apple-ade" && (
                <select aria-label="ADE token" style={ui.input} value={depId} onChange={(e) => { setDepId(e.target.value); setPlan(null); }}>
                  <option value="">Choose an ADE token…</option>
                  {appleTokens.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
              <select aria-label="Template" style={ui.input} value={templateId} onChange={(e) => { setTemplateId(e.target.value); setPlan(null); }}>
                <option value="">No template (JSON body)</option>
                {templates.filter((t) => t.platform === platform).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <textarea
            aria-label={action.kind === "assign" ? "Device serial numbers" : "Profile JSON"}
            placeholder={action.kind === "assign" ? "One serial number per line" : action.kind === "create" ? "Profile body, or overrides for the template" : ""}
            style={{ ...ui.input, ...(action.kind === "assign" ? {} : ui.mono), minHeight: "100px" }}
            value={text}
            onChange={(e) => { setText(e.target.value); setPlan(null); }}
          />
          {plan && <div role="status" aria-label="Plan" style={ui.notice}>{planText(plan)}</div>}
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button type="button" style={ui.button} onClick={() => setAction(null)}>
              Cancel
            </button>
            <button type="button" style={ui.button} onClick={() => void run(true)}>
              Preview
            </button>
            <button type="button" style={ui.primary} disabled={!plan} onClick={() => void run(false)}>
              Apply
            </button>
          </div>
        </section>
      )}

      {data && (
        <>
          <table aria-label="Enrollment tokens" style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Token</th>
                <th style={ui.th}>Platform</th>
                <th style={ui.th}>Expires</th>
                <th style={ui.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.tokens.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ ...ui.td, textAlign: "center", color: "var(--muted)" }}>
                    No enrollment tokens.
                  </td>
                </tr>
              ) : (
                data.tokens.map((t) => (
                  <tr key={`${t.platform}-${t.id}`}>
                    <td style={ui.td}>{t.name}</td>
                    <td style={ui.td}>{PLATFORM_LABELS[t.platform]}</td>
                    <td style={ui.td}>{t.expiresAt ? `${new Date(t.expiresAt).toLocaleDateString()} (${t.daysRemaining} days)` : "—"}</td>
                    <td style={ui.td}>
                      <span style={badge(t.state)}>{t.state}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <table aria-label="Enrollment profiles" style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Name</th>
                <th style={ui.th}>Platform</th>
                <th style={ui.th}>Token</th>
                <th style={ui.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.profiles.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ ...ui.td, textAlign: "center", color: "var(--muted)" }}>
                    No enrollment profiles.
                  </td>
                </tr>
              ) : (
                data.profiles.map((p) => (
                  <tr key={p.id} data-testid={`enrollment-${p.id}`}>
                    <td style={ui.td}>{p.displayName}</td>
                    <td style={ui.td}>{PLATFORM_LABELS[p.platform]}</td>
                    <td style={ui.td}>
                      <span style={badge(p.tokenState ?? "unknown")}>{p.tokenState ?? "unknown"}</span>
                    </td>
                    <td style={ui.td}>
                      <span style={{ display: "flex", gap: "4px" }}>
                        <button type="button" style={ui.button} aria-label={`Edit ${p.displayName}`} onClick={() => open({ kind: "edit", profile: p })}>
                          Edit
                        </button>
                        {p.platform === "apple-ade" && (
                          <button type="button" style={ui.button} aria-label={`Assign devices to ${p.displayName}`} onClick={() => open({ kind: "assign", profile: p })}>
                            Assign devices
                          </button>
                        )}
                        <button type="button" style={{ ...ui.button, color: "var(--danger-text)" }} aria-label={`Delete ${p.displayName}`} onClick={() => void remove(p)}>
                          Delete
                        </button>
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </>
      )}

      <section aria-label="Enrollment templates" style={ui.panel}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <strong>Templates</strong>
          <button type="button" style={ui.button} onClick={() => setNewTemplate({ name: "", platform: "android-enterprise", json: "" })}>
            + New template
          </button>
        </div>
        {newTemplate && (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ display: "flex", gap: "6px" }}>
              <input aria-label="Template name" placeholder="Name" style={ui.input} value={newTemplate.name} onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })} />
              <select aria-label="Template platform" style={ui.input} value={newTemplate.platform} onChange={(e) => setNewTemplate({ ...newTemplate, platform: e.target.value as Platform })}>
                <option value="android-enterprise">Android Enterprise</option>
                <option value="apple-ade">Apple ADE</option>
              </select>
            </div>
            <textarea aria-label="Template profile JSON" style={{ ...ui.input, ...ui.mono, minHeight: "80px" }} value={newTemplate.json} onChange={(e) => setNewTemplate({ ...newTemplate, json: e.target.value })} />
            <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
              <button type="button" style={ui.button} onClick={() => setNewTemplate(null)}>
                Cancel
              </button>
              <button type="button" style={ui.primary} onClick={() => void saveTemplate()}>
                Save template
              </button>
            </div>
          </div>
        )}
        {templates.length === 0 ? (
          <div style={ui.muted}>No templates yet.</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px" }}>
            {templates.map((t) => (
              <li key={t.id}>
                {t.name} <span style={ui.muted}>({PLATFORM_LABELS[t.platform]})</span>{" "}
                <button type="button" style={{ ...ui.button, padding: "1px 6px" }} aria-label={`Delete template ${t.name}`} onClick={() => void client.removeTemplate(t.id).then(load)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
