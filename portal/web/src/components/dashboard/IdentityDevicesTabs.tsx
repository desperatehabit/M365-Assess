"use client";

// IdentityDevicesTabs component (EPIC-004 SPEC.md §3, §3.2, T-0065).
// Sub-tab navigation shell: Overview / Identity / Devices / Custom.
// Switches sub-tabs without a page reload and renders corresponding content panels.
// Strictly uses report theme tokens with zero colour literals.

import React, {
  useState,
  useCallback,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type MouseEvent,
} from "react";

export type DashboardTabId = "overview" | "identity" | "devices" | "custom";

export interface TabDefinition {
  readonly id: DashboardTabId;
  readonly label: string;
  readonly description?: string;
}

export const DASHBOARD_TABS: readonly TabDefinition[] = [
  { id: "overview", label: "Overview", description: "Tenant summary, headline posture & open alerts" },
  { id: "identity", label: "Identity", description: "MFA coverage, auth methods, admin roles & sign-in health" },
  { id: "devices", label: "Devices", description: "Compliance posture, managed endpoints & Defender health" },
  { id: "custom", label: "Custom", description: "Configurable widget canvas and layout" },
] as const;

export interface IdentityDevicesTabsProps {
  /** Currently active tab (controlled mode) */
  readonly activeTab?: DashboardTabId;
  /** Default active tab (uncontrolled mode, default: "overview") */
  readonly defaultTab?: DashboardTabId;
  /** Active tab change callback */
  readonly onTabChange?: (tab: DashboardTabId) => void;
  /** Content for the Overview tab */
  readonly overviewContent?: ReactNode;
  /** Content for the Identity tab */
  readonly identityContent?: ReactNode;
  /** Content for the Devices tab */
  readonly devicesContent?: ReactNode;
  /** Content for the Custom tab */
  readonly customContent?: ReactNode;
  /** Fallback children rendered if no specific tab content is matched */
  readonly children?: ReactNode;
  /** Custom class name */
  readonly className?: string;
  /** Custom inline style */
  readonly style?: CSSProperties;
}

export function IdentityDevicesTabs(props: IdentityDevicesTabsProps): ReactElement {
  const {
    activeTab: controlledTab,
    defaultTab = "overview",
    onTabChange,
    overviewContent,
    identityContent,
    devicesContent,
    customContent,
    children,
    className,
    style,
  } = props;

  const [internalTab, setInternalTab] = useState<DashboardTabId>(defaultTab);
  const currentTab = controlledTab !== undefined ? controlledTab : internalTab;

  const handleSelectTab = useCallback(
    (tabId: DashboardTabId, event: MouseEvent) => {
      // Prevent any anchor/form default behavior to ensure no page reload
      event.preventDefault();
      if (controlledTab === undefined) {
        setInternalTab(tabId);
      }
      onTabChange?.(tabId);
    },
    [controlledTab, onTabChange]
  );

  const contentMap: Record<DashboardTabId, ReactNode> = {
    overview: overviewContent,
    identity: identityContent,
    devices: devicesContent,
    custom: customContent,
  };

  const activeContent = contentMap[currentTab] ?? children;

  return (
    <div
      data-testid="identity-devices-tabs-container"
      className={className}
      style={{ display: "flex", flexDirection: "column", width: "100%", ...style }}
    >
      {/* Tablist navigation chrome */}
      <div
        role="tablist"
        aria-label="Dashboard sub-tabs"
        data-testid="dashboard-subtabs-list"
        style={{
          display: "flex",
          gap: "8px",
          borderBottom: "1px solid var(--border)",
          paddingBottom: "0px",
          overflowX: "auto",
        }}
      >
        {DASHBOARD_TABS.map((tab) => {
          const isActive = currentTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              id={`tab-${tab.id}`}
              data-testid={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.id}`}
              onClick={(e) => handleSelectTab(tab.id, e)}
              style={{
                padding: "10px 18px",
                fontSize: "14px",
                fontWeight: 600,
                color: isActive ? "var(--accent-text)" : "var(--muted)",
                background: isActive ? "var(--accent-soft)" : "transparent",
                border: "none",
                borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                borderRadius: "var(--radius, 6px) var(--radius, 6px) 0 0",
                cursor: "pointer",
                transition: "all 0.15s ease",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-sans, system-ui, sans-serif)",
              }}
            >
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab panel container */}
      <div
        role="tabpanel"
        id={`tabpanel-${currentTab}`}
        data-testid={`tabpanel-${currentTab}`}
        aria-labelledby={`tab-${currentTab}`}
        style={{ marginTop: "20px", width: "100%" }}
      >
        {activeContent ?? (
          <div
            data-testid={`tab-placeholder-${currentTab}`}
            style={{
              padding: "48px 24px",
              textAlign: "center",
              background: "var(--surface)",
              border: "1px dashed var(--border)",
              borderRadius: "var(--radius, 10px)",
              color: "var(--muted)",
              fontSize: "14px",
            }}
          >
            {tabDisplayName(currentTab)} tab content
          </div>
        )}
      </div>
    </div>
  );
}

function tabDisplayName(tab: DashboardTabId): string {
  switch (tab) {
    case "overview":
      return "Overview";
    case "identity":
      return "Identity";
    case "devices":
      return "Devices";
    case "custom":
      return "Custom";
  }
}
