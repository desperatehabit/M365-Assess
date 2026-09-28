// Shared JSON request helper and kit-token styles for the EPIC-017 template, Autopilot, and
// enrollment pages (T-0846). Errors carry the BFF's status and code so pages can react to
// 409/501 and show the server's message.
import type { CSSProperties } from "react";

export class PortalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PortalApiError";
  }
}

/** Fetches JSON; a non-2xx response throws PortalApiError with the BFF's message. */
export async function requestJson<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    ...(init.body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    throw new PortalApiError(body.message || `Request failed: HTTP ${res.status}`, res.status, body.code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const tenantPath = (tenantId: string, rest: string) => `/v1/tenants/${encodeURIComponent(tenantId)}${rest}`;

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Parses a JSON object typed by an operator; returns the object or an error message. */
export function parseJsonObject(text: string): { value: Record<string, unknown> } | { error: string } {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: "Enter a JSON object." };
    return { value: value as Record<string, unknown> };
  } catch (err) {
    return { error: `Invalid JSON: ${errorText(err, "parse error")}` };
  }
}

/** Splits one-per-line (or comma-separated) text into trimmed, de-duplicated entries. */
export function splitLines(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}

export const ui = {
  panel: { background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--radius, 10px)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px" } as CSSProperties,
  input: { padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "6px", fontSize: "13px", background: "var(--input-bg, var(--bg))", color: "var(--text)" } as CSSProperties,
  button: { padding: "5px 12px", border: "1px solid var(--border)", borderRadius: "6px", fontSize: "13px", background: "var(--bg)", color: "var(--text)", cursor: "pointer" } as CSSProperties,
  primary: { padding: "5px 12px", border: "1px solid var(--accent-border)", borderRadius: "6px", fontSize: "13px", background: "var(--accent)", color: "var(--accent-text)", cursor: "pointer" } as CSSProperties,
  th: { textAlign: "left", padding: "8px 12px", background: "var(--bg-elev)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", borderBottom: "1px solid var(--border)" } as CSSProperties,
  td: { padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: "13px", verticalAlign: "top" } as CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", background: "var(--bg)", border: "1px solid var(--border)" } as CSSProperties,
  error: { padding: "10px 14px", background: "var(--danger-soft)", color: "var(--danger-text)", borderRadius: "8px", fontSize: "13px" } as CSSProperties,
  notice: { padding: "10px 14px", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "8px", fontSize: "13px" } as CSSProperties,
  muted: { fontSize: "12px", color: "var(--muted)" } as CSSProperties,
  mono: { fontFamily: "var(--font-mono)" } as CSSProperties,
};

export function stateTone(state: string): CSSProperties {
  const ok = ["ok", "ready", "imported", "queued", "planned", "created", "enrolled", "succeeded", "success"];
  const bad = ["expired", "failed", "invalid", "failure"];
  const warn = ["expiring", "duplicate", "partial", "notContacted"];
  if (ok.includes(state)) return { background: "var(--success-soft)", color: "var(--success-text)" };
  if (bad.includes(state)) return { background: "var(--danger-soft)", color: "var(--danger-text)" };
  if (warn.includes(state)) return { background: "var(--warn-soft)", color: "var(--warn-text)" };
  return { background: "var(--chip)", color: "var(--muted)" };
}

export const badge = (state: string): CSSProperties => ({ ...stateTone(state), padding: "2px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap" });
