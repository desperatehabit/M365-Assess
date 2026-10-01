"use client";

// Graph Explorer page (EPIC-040 SPEC.md §3.1, §4.1, §8; T-0782).
// Method + URL + body editor, a Run button, and a response viewer (formatted
// JSON, status, headers, duration). Write methods are elevated and audited.
// All request state is client-side; no tenant call happens without an explicit
// Run. The preset slot is supplied by T-0784, which also completes the
// "Save as preset" wiring to the presets API.

import React, {
  useCallback,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import {
  GraphRequestEditor,
  type GraphExplorerMethod,
  type GraphExplorerRequest,
} from "../../../components/GraphRequestEditor";
import {
  GraphResponseViewer,
  type GraphExplorerResponse,
} from "../../../components/GraphResponseViewer";
import { GraphPresetList } from "../../../components/GraphPresetList";

export type Fetcher = typeof fetch;

const DEFAULT_GRAPH_URL = "https://graph.microsoft.com/v1.0/";

// Props the page injects into the preset slot (T-0784 supplies the component).
export interface GraphExplorerPresetSlotProps {
  readonly currentRequest: GraphExplorerRequest;
  readonly onRunPreset: (preset: GraphExplorerRequest) => void;
  readonly onSavePreset: (request: GraphExplorerRequest) => void;
}

export interface GraphExplorerViewProps {
  readonly tenantId: string;
  readonly fetcher?: Fetcher;
  readonly presetSlot?: ReactNode;
  readonly onSavePreset?: (request: GraphExplorerRequest) => void;
}

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1400px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

const headingStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-soft)",
  fontSize: "14px",
};

const buttonRowStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  alignItems: "center",
  flexWrap: "wrap",
};

const runButtonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  fontSize: "14px",
  fontWeight: 600,
  cursor: "pointer",
};

const disabledButtonStyle: CSSProperties = {
  ...runButtonStyle,
  opacity: 0.5,
  cursor: "not-allowed",
};

const secondaryButtonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const presetsSectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "20px",
};

const presetsHeadingStyle: CSSProperties = {
  fontSize: "16px",
  fontWeight: 700,
  margin: 0,
};

const presetsEmptyStyle: CSSProperties = {
  color: "var(--text-soft)",
  fontSize: "14px",
  margin: 0,
};

function buildRequestBody(
  method: GraphExplorerMethod,
  url: string,
  bodyText: string,
): GraphExplorerRequest {
  const trimmed = bodyText.trim();
  if (trimmed.length > 0) {
    try {
      return { method, url, body: JSON.parse(trimmed) };
    } catch {
      // Invalid JSON is rejected before Run; leave the body unset here.
    }
  }
  return { method, url };
}

export function GraphExplorerView({
  tenantId,
  fetcher,
  presetSlot,
  onSavePreset,
}: GraphExplorerViewProps): ReactElement {
  const doFetch = fetcher ?? fetch;
  const [method, setMethod] = useState<GraphExplorerMethod>("GET");
  const [url, setUrl] = useState(DEFAULT_GRAPH_URL);
  const [bodyText, setBodyText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [response, setResponse] = useState<GraphExplorerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentRequest = buildRequestBody(method, url.trim(), bodyText);

  const runRequest = useCallback(
    async (request: GraphExplorerRequest): Promise<void> => {
      setLoading(true);
      setError(null);
      setResponse(null);
      try {
        const res = await doFetch(`/v1/tenants/${encodeURIComponent(tenantId)}/graph-explorer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        const data = (await res.json().catch(() => null)) as
          | (GraphExplorerResponse & { message?: string })
          | null;
        if (!res.ok) {
          throw new Error(data?.message ?? `Request failed: HTTP ${res.status}`);
        }
        setResponse(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Request failed");
      } finally {
        setLoading(false);
      }
    },
    [doFetch, tenantId],
  );

  const handleRun = useCallback(async (): Promise<void> => {
    if (jsonError !== null) {
      setError("Fix the JSON body before running.");
      return;
    }
    const trimmedUrl = url.trim();
    if (trimmedUrl.length === 0) {
      setError("Enter a URL to run.");
      return;
    }
    await runRequest(buildRequestBody(method, trimmedUrl, bodyText));
  }, [jsonError, url, method, bodyText, runRequest]);

  const loadPreset = useCallback((preset: GraphExplorerRequest): void => {
    setMethod(preset.method);
    setUrl(preset.url);
    setBodyText(preset.body === undefined ? "" : JSON.stringify(preset.body, null, 2));
    setJsonError(null);
    setError(null);
    setResponse(null);
  }, []);

  const handleSavePreset = useCallback((): void => {
    onSavePreset?.(currentRequest);
  }, [onSavePreset, currentRequest]);

  const slotProps: GraphExplorerPresetSlotProps = {
    currentRequest,
    onRunPreset: (preset) => {
      loadPreset(preset);
      void runRequest(preset);
    },
    onSavePreset: handleSavePreset,
  };

  return (
    <div style={pageStyle} data-testid="graph-explorer-page">
      <div>
        <h1 style={headingStyle}>Graph Explorer</h1>
        <p style={subtitleStyle}>
          Run Microsoft Graph requests against the selected tenant with the portal&rsquo;s
          credentials. Write methods require elevated permission and are audited.
        </p>
      </div>

      <GraphRequestEditor
        method={method}
        url={url}
        body={bodyText}
        onMethodChange={setMethod}
        onUrlChange={setUrl}
        onBodyChange={setBodyText}
        onJsonErrorChange={setJsonError}
      />

      <div style={buttonRowStyle}>
        <button
          type="button"
          style={loading ? disabledButtonStyle : runButtonStyle}
          disabled={loading}
          onClick={() => void handleRun()}
          data-testid="graph-run-button"
        >
          {loading ? "Running…" : "Run"}
        </button>
        <button
          type="button"
          style={secondaryButtonStyle}
          disabled={!onSavePreset}
          onClick={handleSavePreset}
          data-testid="graph-save-preset-button"
          title={onSavePreset ? "Save this request as a preset" : "Preset saving is not available yet"}
        >
          Save as preset
        </button>
      </div>

      <GraphResponseViewer response={response} loading={loading} error={error} />

      <div style={presetsSectionStyle} data-testid="graph-presets-section">
        <h2 style={presetsHeadingStyle}>Presets</h2>
        {presetSlot && React.isValidElement(presetSlot)
          ? React.cloneElement(presetSlot as React.ReactElement<GraphExplorerPresetSlotProps>, slotProps)
          : presetSlot ?? <p style={presetsEmptyStyle}>Presets are not available yet.</p>}
      </div>
    </div>
  );
}

export default function GraphExplorerPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <GraphExplorerView tenantId={tenantId} presetSlot={<GraphPresetList />} />
    </RequireTenant>
  );
}
