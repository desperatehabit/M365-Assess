"use client";

// Shell top bar: the theme switcher and the global tenant selector. The chosen tenant is
// stored by tenant-preference.ts and read by pages through useCurrentTenantId().

import { useEffect, useState, type ReactElement } from "react";
import { TenantSelector, type TenantItem } from "../TenantSelector";
import { useDemoMode } from "./DemoProvider";
import { ThemeSwitcher } from "./ThemeSwitcher";

export function TenantBar(): ReactElement {
  const { enabled: demoEnabled, toggle: toggleDemo } = useDemoMode();
  const [mounted, setMounted] = useState(false);
  const [tenants, setTenants] = useState<TenantItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch("/v1/tenants?limit=200")
      .then(async (res) => {
        if (!res.ok) throw new Error(`tenants request failed (${res.status})`);
        const body = (await res.json()) as { items?: TenantItem[] };
        if (!cancelled) setTenants(body.items ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setTenants(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [demoEnabled]);

  const demoActive = mounted && demoEnabled;

  return (
    <div
      data-testid="tenant-bar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 0",
        borderBottom: "1px solid var(--border)",
        minHeight: "58px",
      }}
    >
      <ThemeSwitcher />
      <div style={{ flex: 1 }} />
      {error && <span style={{ color: "var(--muted)", fontSize: "13px" }}>Tenants unavailable: {error}</span>}
      {/* Rendered after the tenant list loads, which is also after hydration: the selector
          reads the stored tenant from localStorage when it mounts. */}
      {tenants && (
        <TenantSelector tenants={tenants} showFleetOption fleetOptionLabel="All tenants" />
      )}
      <button
        type="button"
        data-testid="demo-mode-toggle"
        aria-pressed={demoActive}
        onClick={toggleDemo}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "6px 12px",
          background: demoActive ? "var(--accent-soft)" : "var(--surface)",
          color: demoActive ? "var(--accent-text)" : "var(--text-soft)",
          border: `1px solid ${demoActive ? "var(--accent-border)" : "var(--border)"}`,
          borderRadius: "var(--radius, 6px)",
          fontSize: "12px",
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "var(--font-sans, system-ui, sans-serif)",
        }}
      >
        <span>Demo mode</span>
        {demoActive && <span>On</span>}
      </button>
    </div>
  );
}
