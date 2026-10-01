"use client";

// Catalog page (EPIC-039 SPEC.md §3.2, §6, §7; T-0763).
// Title "Catalog", type chips (Intune Policy, Conditional Access, Standards,
// Baseline, Report Builder, Group, PIM Role Settings, Custom Test), repo cards
// with Built-in / Write Access chips and a `+N more` count, and an `Add repo`
// dialog (URL or owner/repo, template types, user/org). Reads go through
// `templates.read`; adding/removing a repo goes through `templates.write` and is
// audited by the BFF. Untrusted repo content is rendered as text only — never
// as HTML (SPEC §9 risk). A `fetcher` seam keeps the page testable without a
// live BFF.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { AddRepoDialog, type AddRepoInput } from "../../components/AddRepoDialog";
import {
  TemplateRepoCard,
  TEMPLATE_TYPE_CHIPS,
  type TemplateRepoCardData,
} from "../../components/TemplateRepoCard";

export interface TemplateRepo {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly types: readonly string[];
  readonly writeAccess: boolean;
  readonly builtin: boolean;
  readonly signed: boolean;
  readonly reviewState: string;
  readonly trusted: boolean;
}

export interface CatalogPageProps {
  readonly fetcher?: typeof fetch;
}

type Fetcher = typeof fetch;

function asFetcher(fetcher?: Fetcher): Fetcher {
  return fetcher ?? fetch;
}

async function expectOk(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`${what} failed: ${response.status} ${detail}`);
  }
  return response;
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  await expectOk(response, what);
  return response.json() as Promise<T>;
}

async function fetchTemplateRepos(
  options: { type?: string } = {},
  fetcher?: Fetcher,
): Promise<TemplateRepo[]> {
  const query = options.type ? `?type=${encodeURIComponent(options.type)}` : "";
  const body = await readJson<{ items?: TemplateRepo[] }>(
    await asFetcher(fetcher)(`/v1/template-repos${query}`),
    "Loading catalog",
  );
  return body.items ?? [];
}

async function addTemplateRepo(input: AddRepoInput, fetcher?: Fetcher): Promise<TemplateRepo> {
  return readJson<TemplateRepo>(
    await asFetcher(fetcher)("/v1/template-repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
    "Adding repo",
  );
}

async function removeTemplateRepo(id: string, fetcher?: Fetcher): Promise<void> {
  await expectOk(
    await asFetcher(fetcher)(`/v1/template-repos/${encodeURIComponent(id)}`, { method: "DELETE" }),
    "Removing repo",
  );
}

function toCardData(repo: TemplateRepo): TemplateRepoCardData {
  return {
    id: repo.id,
    name: repo.name,
    url: repo.url,
    types: repo.types,
    writeAccess: repo.writeAccess,
    builtin: repo.builtin,
  };
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

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
  flexWrap: "wrap",
};

const titleStyle: CSSProperties = {
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

const primaryButtonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
  alignItems: "center",
};

const filterChipStyle = (active: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  padding: "4px 12px",
  borderRadius: "999px",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
  border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
  background: active ? "var(--accent-soft)" : "var(--surface)",
  color: active ? "var(--accent-text)" : "var(--text-soft)",
});

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
  gap: "16px",
};

const messageStyle: CSSProperties = {
  padding: "32px",
  textAlign: "center",
  color: "var(--text-soft)",
};

const errorStyle: CSSProperties = {
  padding: "16px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "6px",
  color: "var(--danger-text)",
};

export default function CatalogPage({ fetcher }: CatalogPageProps): ReactElement {
  const doFetch = asFetcher(fetcher);
  const [repos, setRepos] = useState<TemplateRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const items = await fetchTemplateRepos(activeType ? { type: activeType } : {}, doFetch);
      setRepos(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRepos([]);
    } finally {
      setLoading(false);
    }
  }, [activeType, doFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async (input: AddRepoInput): Promise<void> => {
    setBusy(true);
    setDialogError(null);
    try {
      await addTemplateRepo(input, doFetch);
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (repo: TemplateRepoCardData): Promise<void> => {
    setError(null);
    try {
      await removeTemplateRepo(repo.id, doFetch);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={pageStyle} data-testid="catalog-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Catalog</h1>
          <p style={subtitleStyle}>
            Community template repositories. Add a repo to index its templates; cloning a template
            into a tenant is a separate, reviewed step.
          </p>
        </div>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => {
            setDialogError(null);
            setDialogOpen(true);
          }}
          data-testid="add-repo-button"
        >
          Add repo
        </button>
      </div>

      <div style={chipRowStyle} data-testid="catalog-type-chips">
        <button
          type="button"
          style={filterChipStyle(activeType === null)}
          onClick={() => setActiveType(null)}
          data-testid="catalog-chip-all"
        >
          All types
        </button>
        {TEMPLATE_TYPE_CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            style={filterChipStyle(activeType === chip.value)}
            onClick={() => setActiveType(activeType === chip.value ? null : chip.value)}
            data-testid={`catalog-chip-${chip.value}`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {error && (
        <div style={errorStyle} role="alert" data-testid="catalog-error">
          {error}
        </div>
      )}

      {loading && <div style={messageStyle}>Loading catalog...</div>}

      {!loading && !error && repos.length === 0 && (
        <div style={messageStyle} data-testid="catalog-empty">
          No community repositories yet. Use `Add repo` to index one.
        </div>
      )}

      {!loading && !error && repos.length > 0 && (
        <div style={gridStyle} data-testid="catalog-repo-grid">
          {repos.map((repo) => (
            <TemplateRepoCard key={repo.id} repo={toCardData(repo)} onRemove={handleRemove} />
          ))}
        </div>
      )}

      <AddRepoDialog
        open={dialogOpen}
        busy={busy}
        error={dialogError}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleAdd}
      />
    </div>
  );
}
