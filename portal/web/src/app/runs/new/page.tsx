"use client";

// New run page (EPIC-003 SPEC.md §3.2, T-0050).
// Loads tenants and groups from EPIC-002, renders the NewRunDialog wizard,
// and submits run plans to POST /v1/runs (T-0043).
// Strictly uses report theme tokens with zero colour literals.

import React, { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  NewRunDialog,
  type NewRunFormData,
  type RunTemplateOption,
  type SaveRunTemplateInput,
  type UpdateRunTemplateInput,
} from "../../../components/NewRunDialog";
import type {
  TenantOption,
  TenantGroupOption,
} from "../../../components/TenantMultiSelect";

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1000px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

export default function NewRunPage(): ReactElement {
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [groups, setGroups] = useState<TenantGroupOption[]>([]);
  const [templates, setTemplates] = useState<RunTemplateOption[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadData(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const [tenantsRes, groupsRes, templatesRes] = await Promise.all([
          fetch("/v1/tenants"),
          fetch("/v1/tenant-groups"),
          fetch("/v1/run-templates"),
        ]);

        if (!tenantsRes.ok) {
          throw new Error(`Failed to load tenants: ${tenantsRes.statusText}`);
        }

        const tenantsData = await tenantsRes.json();
        const rawTenants: any[] = tenantsData.items ?? tenantsData ?? [];

        let rawGroups: any[] = [];
        if (groupsRes.ok) {
          const groupsData = await groupsRes.json();
          rawGroups = groupsData.items ?? groupsData ?? [];
        }

        let rawTemplates: any[] = [];
        if (templatesRes.ok) {
          const templatesData = await templatesRes.json();
          rawTemplates = templatesData.items ?? templatesData ?? [];
        }

        if (!cancelled) {
          setTenants(
            rawTenants.map((t) => ({
              id: t.id,
              displayName: t.displayName ?? null,
              defaultDomain: t.defaultDomain ?? null,
            })),
          );
          setGroups(
            rawGroups.map((g) => ({
              id: g.id,
              name: g.name,
              memberTenantIds: g.memberTenantIds ?? [],
            })),
          );
          setTemplates(
            rawTemplates.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description ?? null,
              sections: t.sections ?? [],
              options: t.options ?? {},
              framework: t.framework ?? null,
              autoBaseline: t.options?.autoBaseline === true,
              builtIn: t.builtIn === true,
            })),
          );
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setTemplatesLoading(false);
        }
      }
    }

    void loadData();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleClose = (): void => {
    window.location.href = "/runs";
  };

  const refreshTemplates = async (): Promise<void> => {
    const res = await fetch("/v1/run-templates");
    if (!res.ok) return;
    const data = await res.json();
    const raw: any[] = data.items ?? data ?? [];
    setTemplates(
      raw.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description ?? null,
        sections: t.sections ?? [],
        options: t.options ?? {},
        framework: t.framework ?? null,
        autoBaseline: t.options?.autoBaseline === true,
        builtIn: t.builtIn === true,
      })),
    );
  };

  const responseError = async (res: Response, fallback: string): Promise<string> => {
    const body = await res.json().catch(() => null);
    return body?.message ?? `${fallback}: ${res.statusText}`;
  };

  const handleSaveAsTemplate = async (input: SaveRunTemplateInput): Promise<void> => {
    try {
      const res = await fetch("/v1/run-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          sections: input.sections,
          options: {
            quickScan: input.options.quickScan,
            skipPurview: input.options.skipPurview,
            redact: input.options.redact,
            evidence: input.options.evidence,
            autoBaseline: input.options.autoBaseline,
          },
          framework: input.framework,
        }),
      });
      if (!res.ok) throw new Error(await responseError(res, "Failed to save template"));
      await refreshTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUpdateTemplate = async (
    template: RunTemplateOption,
    input: UpdateRunTemplateInput,
  ): Promise<void> => {
    try {
      const res = await fetch(`/v1/run-templates/${encodeURIComponent(template.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sections: input.sections,
          options: input.options,
          framework: input.framework,
        }),
      });
      if (!res.ok) throw new Error(await responseError(res, "Failed to update template"));
      await refreshTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyTemplate = async (template: RunTemplateOption): Promise<void> => {
    try {
      const res = await fetch(
        `/v1/run-templates/${encodeURIComponent(template.id)}/copy`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) throw new Error(await responseError(res, "Failed to copy template"));
      await refreshTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRenameTemplate = async (
    template: RunTemplateOption,
    name: string,
  ): Promise<void> => {
    try {
      const res = await fetch(`/v1/run-templates/${encodeURIComponent(template.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await responseError(res, "Failed to rename template"));
      await refreshTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteTemplate = async (template: RunTemplateOption): Promise<void> => {
    try {
      const res = await fetch(`/v1/run-templates/${encodeURIComponent(template.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await responseError(res, "Failed to delete template"));
      await refreshTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSubmit = async (formData: NewRunFormData): Promise<void> => {
    const payload = {
      tenantIds: formData.tenantIds,
      groupIds: formData.groupIds,
      sections: formData.sections,
      trigger: formData.trigger,
      options: formData.options,
    };

    const res = await fetch("/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => null);
      throw new Error(errorData?.message ?? `Failed to create run: ${res.statusText}`);
    }

    const data = await res.json();
    const runId = data.run?.id ?? data.id;
    if (runId) {
      window.location.href = `/runs/${runId}`;
    } else {
      window.location.href = "/runs";
    }
  };

  return (
    <div style={pageStyle} data-testid="new-run-page">
      {error && (
        <div
          style={{
            padding: "16px",
            borderRadius: "6px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            color: "var(--danger-text)",
          }}
          role="alert"
        >
          {error}
        </div>
      )}

      <NewRunDialog
        open={true}
        onClose={handleClose}
        onSubmit={handleSubmit}
        tenants={tenants}
        groups={groups}
        loading={loading}
        templates={templates}
        templatesLoading={templatesLoading}
        onSaveAsTemplate={handleSaveAsTemplate}
        onUpdateTemplate={handleUpdateTemplate}
        onCopyTemplate={handleCopyTemplate}
        onRenameTemplate={handleRenameTemplate}
        onDeleteTemplate={handleDeleteTemplate}
      />
    </div>
  );
}
