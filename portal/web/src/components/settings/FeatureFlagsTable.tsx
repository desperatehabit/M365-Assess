"use client";

// Feature flags table (EPIC-037 SPEC.md §3.3, §9; T-0728). Renders the toggle
// list with description, scope, and effect, and drives PUT /v1/feature-flags
// through the parent. The nav gate below reads the same flag source the T-0725
// enforcement seam serves, so a feature the API disables can never appear in
// the nav: a flag that is missing or disabled hides the routes it names. The
// catalog is the UI's view of which features are optional and what they gate;
// unknown persisted flags still render, with no nav effect.

import type { CSSProperties, ReactElement } from "react";

export interface FeatureFlag {
  readonly key: string;
  readonly enabled: boolean;
  readonly scope: "global" | "tenant";
  readonly description: string;
  readonly updatedAt?: string | null;
  readonly updatedBy?: string | null;
}

export interface FeatureDefinition {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly effect: string;
  readonly navHrefs: readonly string[];
}

export const FEATURE_CATALOG: readonly FeatureDefinition[] = [
  {
    key: "feature.report-builder",
    label: "Report builder",
    description: "Compose custom report templates from the block library.",
    effect: "Gates the Report builder nav item and the report-template endpoints.",
    navHrefs: ["/reports/builder"],
  },
  {
    key: "feature.custom-dashboard",
    label: "Custom dashboard",
    description: "Per-operator dashboard layouts.",
    effect: "Gates the Custom dashboard nav item.",
    navHrefs: ["/dashboard/custom"],
  },
  {
    key: "feature.diagnostics",
    label: "Diagnostics",
    description: "Container and worker health, cache status, and timers.",
    effect: "Gates the Diagnostics nav item and the diagnostics endpoint.",
    navHrefs: ["/diagnostics"],
  },
];

export interface GatedNavItem {
  readonly href: string;
}

export interface GatedNavGroup<T extends GatedNavItem> {
  readonly label: string;
  readonly items: readonly T[];
}

export function featureDefinition(key: string): FeatureDefinition | undefined {
  return FEATURE_CATALOG.find((definition) => definition.key === key);
}

/** Same semantics as the API's isFeatureEnabled: missing or disabled is off. */
export function isFlagEnabled(flags: readonly FeatureFlag[], key: string): boolean {
  return flags.some((flag) => flag.key === key && flag.enabled);
}

/**
 * Remove every nav item gated by a flag that is not enabled. A catalog flag with
 * no persisted row is treated as disabled, matching the API guard's "missing =
 * disabled" rule, so the nav can never show a feature the API would reject.
 */
export function gateNavGroups<T extends GatedNavItem>(
  groups: readonly GatedNavGroup<T>[],
  flags: readonly FeatureFlag[],
): GatedNavGroup<T>[] {
  const hidden = new Set<string>();
  for (const definition of FEATURE_CATALOG) {
    if (isFlagEnabled(flags, definition.key)) continue;
    for (const href of definition.navHrefs) hidden.add(href);
  }
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => !hidden.has(item.href)) }))
    .filter((group) => group.items.length > 0);
}

export interface FeatureFlagRow {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly effect: string;
  readonly enabled: boolean;
  readonly scope: "global" | "tenant";
}

/** Merge the catalog with persisted flags; unknown flags render with no nav effect. */
export function featureFlagRows(flags: readonly FeatureFlag[]): FeatureFlagRow[] {
  const persisted = new Map(flags.map((flag) => [flag.key, flag]));
  const rows: FeatureFlagRow[] = [];
  const seen = new Set<string>();
  for (const definition of FEATURE_CATALOG) {
    const flag = persisted.get(definition.key);
    rows.push({
      key: definition.key,
      label: definition.label,
      description: flag?.description !== undefined && flag.description.length > 0
        ? flag.description
        : definition.description,
      effect: definition.effect,
      enabled: flag?.enabled ?? false,
      scope: flag?.scope ?? "global",
    });
    seen.add(definition.key);
  }
  for (const flag of flags) {
    if (seen.has(flag.key)) continue;
    rows.push({
      key: flag.key,
      label: flag.key,
      description: flag.description,
      effect: "No nav effect.",
      enabled: flag.enabled,
      scope: flag.scope,
    });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

export interface FeatureFlagsTableProps {
  readonly flags: readonly FeatureFlag[];
  readonly onToggle: (key: string, enabled: boolean) => void;
  readonly saving?: string | null;
  readonly error?: string | null;
}

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
  color: "var(--text)",
};

const headStyle: CSSProperties = {
  textAlign: "left",
  fontSize: "11px",
  fontWeight: 600,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
  borderBottom: "1px solid var(--border)",
  padding: "8px 10px",
};

const cellStyle: CSSProperties = {
  borderBottom: "1px solid var(--border)",
  padding: "10px",
  verticalAlign: "top",
};

const errorStyle: CSSProperties = {
  padding: "10px 12px",
  background: "var(--danger-soft)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
  marginBottom: "12px",
};

export function FeatureFlagsTable({
  flags,
  onToggle,
  saving = null,
  error = null,
}: FeatureFlagsTableProps): ReactElement {
  const rows = featureFlagRows(flags);
  return (
    <div data-testid="feature-flags-table">
      {error !== null ? (
        <div data-testid="feature-flags-error" style={errorStyle}>
          {error}
        </div>
      ) : null}
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={headStyle}>Feature</th>
            <th style={headStyle}>Description</th>
            <th style={headStyle}>Scope</th>
            <th style={headStyle}>Effect</th>
            <th style={headStyle}>State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-testid={`feature-row-${row.key}`}>
              <td style={cellStyle}>
                <div style={{ fontWeight: 600 }}>{row.label}</div>
                <div style={{ color: "var(--muted)", fontFamily: "var(--font-mono, monospace)", fontSize: "11px" }}>
                  {row.key}
                </div>
              </td>
              <td style={cellStyle}>{row.description}</td>
              <td style={cellStyle}>{row.scope}</td>
              <td style={cellStyle}>{row.effect}</td>
              <td style={cellStyle}>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={row.label}
                  data-testid={`feature-toggle-${row.key}`}
                  checked={row.enabled}
                  disabled={saving === row.key}
                  onChange={(event) => onToggle(row.key, event.target.checked)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
