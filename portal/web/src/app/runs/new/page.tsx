"use client";

// New run page (EPIC-003 SPEC.md §3.2, T-0050).
// Loads tenants and groups from EPIC-002, renders the NewRunDialog wizard,
// and submits run plans to POST /v1/runs (T-0043).
// Strictly uses report theme tokens with zero colour literals.

import React, { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  NewRunDialog,
  type NewRunFormData,
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadData(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const [tenantsRes, groupsRes] = await Promise.all([
          fetch("/v1/tenants"),
          fetch("/v1/tenant-groups"),
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
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
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
      />
    </div>
  );
}
