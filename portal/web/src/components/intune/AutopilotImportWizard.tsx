"use client";

// AutopilotImportWizard — Intune → Autopilot & Enrollment → Add Device (EPIC-017 SPEC.md §3.4, §4.3; T-0846).
// Choose a source — manual rows, a Get-WindowsAutoPilotInfo CSV (pasted or read from a file),
// or device-prep rows (manufacturer, model, serial) — then Preview: the T-0328 import route
// reports every row as ready, duplicate (within the batch or already in the tenant), or
// invalid before anything is written. Import sends the same rows and shows each row's result.
// Kit tokens only.
import React, { useState } from "react";
import { badge, errorText, requestJson, tenantPath, ui } from "./intuneFetch";

export type ImportSource = "manual" | "csv" | "device-prep";

export interface ImportRowResult {
  readonly row: number;
  readonly serialNumber: string;
  readonly status: "ready" | "imported" | "duplicate" | "invalid" | "failed";
  readonly reason: string | null;
}

export interface ImportResponse {
  readonly preview: boolean;
  readonly rows: readonly ImportRowResult[];
  readonly counts: Record<string, number>;
}

export type ImportApi = (tenantId: string, body: Record<string, unknown>) => Promise<ImportResponse>;

export const defaultImportApi: ImportApi = (tenantId, body) => requestJson(tenantPath(tenantId, "/autopilot/import"), { method: "POST", body });

const FIELDS: Record<Exclude<ImportSource, "csv">, readonly { key: string; label: string }[]> = {
  manual: [
    { key: "serialNumber", label: "Serial" },
    { key: "hardwareHash", label: "Hardware hash" },
    { key: "groupTag", label: "Group tag" },
    { key: "assignedUser", label: "Assigned user" },
  ],
  "device-prep": [
    { key: "manufacturer", label: "Manufacturer" },
    { key: "model", label: "Model" },
    { key: "serialNumber", label: "Serial" },
  ],
};

type Row = Record<string, string>;

/** The import request body for the current source; blank rows are dropped. */
export function buildImportBody(source: ImportSource, rows: readonly Row[], csv: string, preview: boolean): Record<string, unknown> {
  if (source === "csv") return { source, csv, preview };
  const keep = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))).filter((r) => Object.keys(r).length > 0);
  return { source, rows: keep, preview };
}

export interface AutopilotImportWizardProps {
  readonly tenantId: string;
  readonly api?: ImportApi;
  readonly onDone?: () => void;
}

export function AutopilotImportWizard({ tenantId, api = defaultImportApi, onDone }: AutopilotImportWizardProps) {
  const [source, setSource] = useState<ImportSource>("manual");
  const [rows, setRows] = useState<Row[]>([{}]);
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => setResult(null);
  const changeSource = (s: ImportSource) => {
    setSource(s);
    setRows([{}]);
    reset();
  };
  const setCell = (i: number, key: string, value: string) => {
    setRows(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
    reset();
  };

  async function run(preview: boolean) {
    const body = buildImportBody(source, rows, csv, preview);
    if (source === "csv" ? !csv.trim() : (body["rows"] as unknown[]).length === 0) {
      setError(source === "csv" ? "Paste or choose a CSV file." : "Enter at least one device.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await api(tenantId, body));
      if (!preview) onDone?.();
    } catch (err) {
      setError(errorText(err, "Import failed."));
    } finally {
      setBusy(false);
    }
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    setCsv(await file.text());
    reset();
  }

  const ready = result?.preview ? (result.counts["ready"] ?? 0) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", color: "var(--text)" }}>
      <h2 style={{ margin: 0, fontSize: "18px" }}>Add Autopilot devices</h2>
      <div role="radiogroup" aria-label="Import source" style={{ display: "flex", gap: "14px", fontSize: "13px" }}>
        {(["manual", "csv", "device-prep"] as const).map((s) => (
          <label key={s}>
            <input type="radio" name="source" checked={source === s} onChange={() => changeSource(s)} />{" "}
            {s === "manual" ? "Manual" : s === "csv" ? "CSV (Get-WindowsAutoPilotInfo)" : "Device preparation"}
          </label>
        ))}
      </div>

      <section style={ui.panel} aria-label="Devices to import">
        {source === "csv" ? (
          <>
            <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => void readFile(e.target.files?.[0])} />
            <textarea aria-label="CSV text" style={{ ...ui.input, ...ui.mono, minHeight: "140px" }} placeholder="Device Serial Number,Windows Product ID,Hardware Hash,Group Tag" value={csv} onChange={(e) => { setCsv(e.target.value); reset(); }} />
          </>
        ) : (
          <>
            {rows.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {FIELDS[source].map((f) => (
                  <input key={f.key} aria-label={`Row ${i + 1} ${f.label}`} placeholder={f.label} style={{ ...ui.input, ...(f.key === "hardwareHash" ? { flex: 1, ...ui.mono } : {}) }} value={r[f.key] ?? ""} onChange={(e) => setCell(i, f.key, e.target.value)} />
                ))}
                <button type="button" style={ui.button} aria-label={`Remove row ${i + 1}`} onClick={() => { setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{}]); reset(); }}>
                  Remove
                </button>
              </div>
            ))}
            <button type="button" style={{ ...ui.button, alignSelf: "flex-start" }} onClick={() => setRows([...rows, {}])}>
              + Add row
            </button>
          </>
        )}
      </section>

      {error && <div role="alert" style={ui.error}>{error}</div>}
      {result && (
        <section aria-label="Import results" style={ui.panel}>
          <div style={ui.muted}>
            {Object.entries(result.counts)
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ")}
          </div>
          <table aria-label="Row results" style={ui.table}>
            <thead>
              <tr>
                <th style={ui.th}>Row</th>
                <th style={ui.th}>Serial</th>
                <th style={ui.th}>Result</th>
                <th style={ui.th}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.row} data-testid={`row-result-${r.row}`}>
                  <td style={ui.td}>{r.row}</td>
                  <td style={{ ...ui.td, ...ui.mono }}>{r.serialNumber || "—"}</td>
                  <td style={ui.td}>
                    <span style={badge(r.status)}>{r.status}</span>
                  </td>
                  <td style={ui.td}>{r.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        <button type="button" style={ui.button} disabled={busy} onClick={() => void run(true)}>
          Preview
        </button>
        <button type="button" style={ui.primary} disabled={busy || ready === 0} onClick={() => void run(false)}>
          Import {ready > 0 ? `${ready} device${ready === 1 ? "" : "s"}` : ""}
        </button>
      </div>
    </div>
  );
}
