"use client";

// API docs page (EPIC-038 SPEC §3.5; T-0751). Read-only rendering of the
// generated OpenAPI 3.1 document served at /v1/openapi.json, plus the auth
// primer: external callers obtain a token with OAuth client credentials against
// `api://<appId>/.default` and present it as a bearer token. The page never
// mutates the spec; it is a viewer. Strictly uses report theme tokens.

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";

export const OPENAPI_JSON_API_PATH = "/v1/openapi.json";
export const OPENAPI_YAML_API_PATH = "/v1/openapi.yaml";

interface OpenApiOperation {
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly "x-permission"?: string;
  readonly security?: readonly Record<string, readonly string[]>[];
}

interface OpenApiPathItem {
  readonly [method: string]: OpenApiOperation;
}

interface OpenApiSecurityScheme {
  readonly type?: string;
  readonly scheme?: string;
  readonly bearerFormat?: string;
  readonly description?: string;
  readonly name?: string;
  readonly in?: string;
}

interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string; readonly description?: string };
  readonly servers?: readonly { readonly url: string; readonly description?: string }[];
  readonly paths: Readonly<Record<string, OpenApiPathItem>>;
  readonly components?: {
    readonly securitySchemes?: Readonly<Record<string, OpenApiSecurityScheme>>;
  };
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

const pageStyle: CSSProperties = {
  padding: "28px 40px",
  maxWidth: "1800px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

const breadcrumbStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
};

const headingStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  color: "var(--text)",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--muted)",
  fontSize: "14px",
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "10px",
  background: "var(--surface)",
  padding: "20px",
  boxShadow: "var(--shadow-card)",
};

const cardTitleStyle: CSSProperties = {
  fontSize: "16px",
  fontWeight: 700,
  margin: "0 0 12px",
  color: "var(--text)",
};

const preStyle: CSSProperties = {
  margin: "12px 0 0",
  padding: "12px 14px",
  borderRadius: "8px",
  border: "1px solid var(--border)",
  background: "var(--bg-elev)",
  color: "var(--text-soft)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12.5px",
  overflowX: "auto",
  whiteSpace: "pre",
};

const mutedStyle: CSSProperties = {
  margin: "8px 0 0",
  color: "var(--muted)",
  fontSize: "13px",
  lineHeight: 1.5,
};

const groupStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "10px",
  background: "var(--surface)",
  overflow: "hidden",
};

const groupHeaderStyle: CSSProperties = {
  padding: "10px 16px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg-elev)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
  fontWeight: 600,
  color: "var(--text)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "12px",
  padding: "10px 16px",
  borderBottom: "1px solid var(--border)",
};

const methodStyle: CSSProperties = {
  flex: "0 0 64px",
  textAlign: "center",
  padding: "2px 8px",
  borderRadius: "6px",
  border: "1px solid var(--accent-border)",
  background: "var(--accent-soft)",
  color: "var(--accent-text)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
};

const pathStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
  color: "var(--text)",
};

const summaryStyle: CSSProperties = {
  color: "var(--muted)",
  fontSize: "13px",
};

const permissionStyle: CSSProperties = {
  marginLeft: "auto",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "11.5px",
  color: "var(--text-soft)",
};

interface EndpointRow {
  readonly path: string;
  readonly method: string;
  readonly operation: OpenApiOperation;
}

function groupPaths(paths: Readonly<Record<string, OpenApiPathItem>>): [string, EndpointRow[]][] {
  const groups = new Map<string, EndpointRow[]>();
  for (const [path, item] of Object.entries(paths)) {
    const segment = path.split("/").filter((part) => part.length > 0)[0] ?? "root";
    const rows = Object.entries(item)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, operation]) => ({ path, method, operation }));
    if (rows.length === 0) continue;
    const list = groups.get(segment) ?? [];
    list.push(...rows);
    groups.set(segment, list);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export default function ApiDocsPage(): ReactElement {
  const [document, setDocument] = useState<OpenApiDocument | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(OPENAPI_JSON_API_PATH);
        if (!response.ok) {
          throw new Error(`Failed to fetch the OpenAPI document: HTTP ${response.status}`);
        }
        const json = (await response.json()) as OpenApiDocument;
        if (active) setDocument(json);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Failed to load the OpenAPI document");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const groups = useMemo(() => (document ? groupPaths(document.paths) : []), [document]);
  const securitySchemes = document?.components?.securitySchemes ?? {};

  return (
    <div style={pageStyle} data-testid="api-docs-page">
      <header>
        <div style={breadcrumbStyle}>CIPP &rarr; Advanced &rarr; API Docs</div>
        <h1 style={headingStyle}>API Reference</h1>
        <p style={subtitleStyle}>
          Read-only view of the generated OpenAPI 3.1 contract
          {document ? ` — ${document.info.title} ${document.info.version}` : ""}.
        </p>
      </header>

      <section style={cardStyle} data-testid="api-docs-auth-primer">
        <h2 style={cardTitleStyle}>Authentication (client credentials)</h2>
        <p style={{ ...mutedStyle, marginTop: 0 }}>
          External integrations authenticate with the OAuth 2.0 client-credentials grant. Request a
          token for the scope <code>api://&lt;appId&gt;/.default</code>, then send it as a bearer token on
          every request. The client secret is shown once when the API client is created or rotated;
          only its hash is stored.
        </p>
        <pre style={preStyle}>{`POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=<appId>
&client_secret=<secret>
&scope=api://<appId>/.default

Authorization: Bearer <access_token>`}</pre>
      </section>

      <section style={cardStyle}>
        <h2 style={cardTitleStyle}>Security schemes</h2>
        {Object.keys(securitySchemes).length === 0 ? (
          <p style={mutedStyle}>No security schemes are declared.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "18px", color: "var(--text-soft)", fontSize: "13px" }}>
            {Object.entries(securitySchemes).map(([name, scheme]) => (
              <li key={name}>
                <code>{name}</code> — {scheme.type ?? "unknown"}
                {scheme.scheme ? ` (${scheme.scheme}${scheme.bearerFormat ? `, ${scheme.bearerFormat}` : ""})` : ""}
                {scheme.description ? `: ${scheme.description}` : ""}
              </li>
            ))}
          </ul>
        )}
        <p style={mutedStyle}>
          Machine-readable:{" "}
          <a href={OPENAPI_JSON_API_PATH}>openapi.json</a>
          {" · "}
          <a href={OPENAPI_YAML_API_PATH}>openapi.yaml</a>
        </p>
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <h2 style={cardTitleStyle}>Endpoints</h2>
        {loading ? <p style={mutedStyle}>Loading the OpenAPI document…</p> : null}
        {error ? (
          <p role="alert" style={{ ...mutedStyle, color: "var(--danger-text)" }}>
            {error}
          </p>
        ) : null}
        {groups.map(([group, rows]) => (
          <div key={group} style={groupStyle}>
            <div style={groupHeaderStyle}>/{group}</div>
            {rows.map(({ path, method, operation }, index) => (
              <div
                key={`${method}-${path}`}
                style={{
                  ...rowStyle,
                  ...(index === rows.length - 1 ? { borderBottom: "none" } : {}),
                }}
              >
                <span style={methodStyle}>{method}</span>
                <span style={pathStyle}>{path}</span>
                <span style={summaryStyle}>{operation.summary ?? ""}</span>
                {operation["x-permission"] ? (
                  <span style={permissionStyle}>{operation["x-permission"]}</span>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}
