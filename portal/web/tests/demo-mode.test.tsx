/** @vitest-environment jsdom */

// System-wide demo mode and dataset verification (T-0892).
// Verifies explicit opt-in only, fetch interception and clean restoration,
// persistent banner visibility, write non-persistence markers, zero color literals,
// zero real domains/UPNs, and GET coverage across every major AppNav area.

import React, { useEffect, useState } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEMO_DASHBOARD_PAYLOAD, DEMO_FLEET_PAYLOAD } from "../src/data/dashboard-demo";
import { DEMO_WRITE_MESSAGE, resolveDemoResponse } from "../src/data/demo-dataset";
import {
  DEMO_MODE_STORAGE_KEY,
  hasDemoQueryParam,
  installDemoFetchInterceptor,
  isDemoFetchInterceptorInstalled,
  isDemoModeEnabled,
  readDemoModePreference,
  uninstallDemoFetchInterceptor,
  writeDemoModePreference,
} from "../src/lib/demo-mode";
import { DemoBanner } from "../src/components/shell/DemoBanner";
import { DemoProvider, useDemoMode } from "../src/components/shell/DemoProvider";
import { TenantBar } from "../src/components/shell/TenantBar";
import { setCurrentTenantId } from "../src/lib/tenant-preference";

let baselineFetch: typeof fetch;

beforeEach(() => {
  uninstallDemoFetchInterceptor();
  baselineFetch = vi.fn(async () => {
    return new Response(JSON.stringify({ live: true, items: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  window.fetch = baselineFetch;
  globalThis.fetch = baselineFetch;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  setCurrentTenantId(null);
});

afterEach(() => {
  cleanup();
  uninstallDemoFetchInterceptor();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  setCurrentTenantId(null);
  vi.restoreAllMocks();
});

describe("Demo mode opt-in and fetch interceptor (T-0892)", () => {
  it("never engages implicitly in live mode and never intercepts fetch", async () => {
    expect(readDemoModePreference()).toBe(false);
    expect(hasDemoQueryParam()).toBe(false);
    expect(isDemoModeEnabled()).toBe(false);
    expect(isDemoFetchInterceptorInstalled()).toBe(false);

    render(
      <DemoProvider>
        <TenantBar />
        <DemoBanner />
      </DemoProvider>,
    );

    await waitFor(() => expect(baselineFetch).toHaveBeenCalledWith("/v1/tenants?limit=200"));
    expect(isDemoFetchInterceptorInstalled()).toBe(false);
    expect(screen.queryByTestId("demo-banner")).toBeNull();
    expect(screen.getByTestId("demo-mode-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles demo mode on/off via TenantBar, persists preference, and restores original fetch cleanly", async () => {
    render(
      <DemoProvider>
        <TenantBar />
        <DemoBanner />
      </DemoProvider>,
    );

    await waitFor(() => expect(baselineFetch).toHaveBeenCalledTimes(1));

    // Turn ON via explicit toggle click
    fireEvent.click(screen.getByTestId("demo-mode-toggle"));

    expect(readDemoModePreference()).toBe(true);
    expect(window.localStorage.getItem(DEMO_MODE_STORAGE_KEY)).toBe("true");
    expect(isDemoFetchInterceptorInstalled()).toBe(true);
    expect(screen.getByTestId("demo-mode-toggle").getAttribute("aria-pressed")).toBe("true");

    const banner = await screen.findByTestId("demo-banner");
    expect(banner.textContent).toContain(
      "Demo data active — Simulated tenant data is displayed; writes are not persisted.",
    );

    // TenantBar reloads tenants from demo dataset without calling baselineFetch again
    await waitFor(() => expect(screen.getByTestId("tenant-selector-trigger")).toBeTruthy());
    expect(baselineFetch).toHaveBeenCalledTimes(1);

    // Turn OFF via persistent banner's Exit demo mode button
    fireEvent.click(screen.getByTestId("exit-demo-mode-button"));

    expect(readDemoModePreference()).toBe(false);
    expect(isDemoFetchInterceptorInstalled()).toBe(false);
    expect(window.fetch).toBe(baselineFetch);
    expect(screen.queryByTestId("demo-banner")).toBeNull();

    // Live fetch resumes hitting the original fetch implementation
    await waitFor(() => expect(baselineFetch).toHaveBeenCalledTimes(2));
  });

  it("engages synchronously on ?demo=1 before child mount effects fire and exits cleanly", async () => {
    window.history.replaceState(null, "", "/runs?demo=1");
    expect(isDemoModeEnabled()).toBe(true);

    function ChildProbe(): React.ReactElement {
      const [header, setHeader] = useState<string | null>(null);
      useEffect(() => {
        void fetch("/v1/runs").then((res) => setHeader(res.headers.get("X-M365-Demo")));
      }, []);
      return <span data-testid="child-demo-header">{header ?? "pending"}</span>;
    }

    render(
      <DemoProvider>
        <DemoBanner />
        <ChildProbe />
      </DemoProvider>,
    );

    expect(isDemoFetchInterceptorInstalled()).toBe(true);
    expect(screen.getByTestId("demo-banner")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("child-demo-header").textContent).toBe("true"));
    expect(baselineFetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("exit-demo-mode-button"));
    expect(isDemoFetchInterceptorInstalled()).toBe(false);
    expect(screen.queryByTestId("demo-banner")).toBeNull();
    expect(window.location.search).not.toContain("demo=1");
  });

  it("intercepts /v1/* relative and absolute URLs while passing non-/v1/* requests through", async () => {
    installDemoFetchInterceptor();

    const relRes = await window.fetch("/v1/tenants");
    expect(relRes.status).toBe(200);
    expect(relRes.headers.get("X-M365-Demo")).toBe("true");
    const relJson = (await relRes.json()) as { items: Array<{ id: string }> };
    expect(relJson.items.length).toBeGreaterThanOrEqual(3);

    const absRes = await window.fetch("http://127.0.0.1:8080/v1/dashboard");
    expect(absRes.status).toBe(200);
    expect(absRes.headers.get("X-M365-Demo")).toBe("true");
    expect(await absRes.json()).toEqual(DEMO_FLEET_PAYLOAD);

    const urlObjRes = await window.fetch(new URL("http://localhost:3000/v1/health"));
    expect(urlObjRes.status).toBe(200);
    expect(urlObjRes.headers.get("X-M365-Demo")).toBe("true");

    // Non-/v1/ route falls through to baselineFetch
    const nonApiRes = await window.fetch("/api/auth/session");
    expect(baselineFetch).toHaveBeenCalledWith("/api/auth/session", undefined);
    expect(await nonApiRes.json()).toEqual({ live: true, items: [] });

    uninstallDemoFetchInterceptor();
    expect(window.fetch).toBe(baselineFetch);
  });

  it("blocks all write methods (POST, PUT, PATCH, DELETE) from hitting the network with explicit non-persistence marker", async () => {
    installDemoFetchInterceptor();

    const writeCases: Array<{ url: string; method: string; expectedStatus: number }> = [
      { url: "/v1/tenants", method: "POST", expectedStatus: 200 },
      { url: "/v1/runs", method: "POST", expectedStatus: 202 },
      { url: "/v1/settings", method: "PUT", expectedStatus: 200 },
      { url: "/v1/baselines/bl-demo-001", method: "PATCH", expectedStatus: 200 },
      { url: "/v1/custom-tests/ct-demo-01", method: "DELETE", expectedStatus: 200 },
      { url: "http://127.0.0.1:8080/v1/remediation/plans", method: "POST", expectedStatus: 202 },
    ];

    for (const testCase of writeCases) {
      const res = testCase.url.startsWith("http")
        ? await window.fetch(new Request(testCase.url, { method: testCase.method }))
        : await window.fetch(testCase.url, { method: testCase.method });
      expect(res.status).toBe(testCase.expectedStatus);
      expect(res.headers.get("X-M365-Demo")).toBe("true");
      const body = (await res.json()) as { demo: boolean; persisted: boolean; message: string };
      expect(body.demo).toBe(true);
      expect(body.persisted).toBe(false);
      expect(body.message).toBe(DEMO_WRITE_MESSAGE);
    }

    expect(baselineFetch).not.toHaveBeenCalled();
  });

  it("provides safe defaults when TenantBar and useDemoMode render outside DemoProvider", async () => {
    function Probe(): React.ReactElement {
      const demo = useDemoMode();
      return <span data-testid="probe">{String(demo.enabled)}</span>;
    }

    render(
      <>
        <Probe />
        <TenantBar />
      </>,
    );

    expect(screen.getByTestId("probe").textContent).toBe("false");
    expect(screen.getByTestId("demo-mode-toggle").getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(baselineFetch).toHaveBeenCalledWith("/v1/tenants?limit=200"));
  });
});

describe("Demo dataset route coverage across AppNav areas (T-0892)", () => {
  it("reuses DEMO_DASHBOARD_PAYLOAD and DEMO_FLEET_PAYLOAD directly", () => {
    const fleet = resolveDemoResponse("/v1/dashboard", "GET");
    expect(fleet?.status).toBe(200);
    expect(fleet?.body).toBe(DEMO_FLEET_PAYLOAD);

    const tenantDash = resolveDemoResponse(`/v1/dashboard/${DEMO_DASHBOARD_PAYLOAD.tenantId}`, "GET");
    expect(tenantDash?.status).toBe(200);
    expect(tenantDash?.body).toBe(DEMO_DASHBOARD_PAYLOAD);
  });

  it("returns null for non-/v1/* URLs", () => {
    expect(resolveDemoResponse("/dashboard", "GET")).toBeNull();
    expect(resolveDemoResponse("/_next/static/chunk.js", "GET")).toBeNull();
    expect(resolveDemoResponse("https://example.org/other", "POST")).toBeNull();
  });

  it.each([
    // Overview
    "/v1/dashboard",
    "/v1/dashboard/layout",
    "/v1/dashboard/widgets",
    "/v1/dashboard/demo-tenant-sample-01",
    // Tenants
    "/v1/tenants",
    "/v1/tenants/demo-tenant-sample-01",
    "/v1/tenants/demo-tenant-sample-01/credential",
    "/v1/tenants/demo-tenant-sample-01/variables",
    "/v1/tenants/demo-tenant-sample-01/audit",
    "/v1/tenant-groups",
    "/v1/tenant-variables",
    "/v1/variables",
    "/v1/gdap",
    "/v1/gdap/relationships",
    // Assessments
    "/v1/runs",
    "/v1/runs/run-demo-sample-001",
    "/v1/runs/run-demo-sample-001/results",
    "/v1/runs/run-demo-sample-001/artifacts",
    "/v1/reports",
    "/v1/report-templates",
    "/v1/remediation/plans/plan-demo-001",
    "/v1/remediation/instructions/ENTRA-MFA-001",
    "/v1/remediation/history?tenantId=demo-tenant-sample-01",
    // Standards & drift
    "/v1/standards/templates",
    "/v1/standards/catalog",
    "/v1/standards/alignment?view=summary",
    "/v1/standards/compare/demo-tenant-sample-01",
    "/v1/drift/demo-tenant-sample-01",
    "/v1/drift/demo-tenant-sample-01/report",
    "/v1/baselines",
    "/v1/baselines/fleet",
    "/v1/baselines/catalog",
    "/v1/baselines/bl-demo-001",
    // Identity
    "/v1/tenants/demo-tenant-sample-01/users",
    "/v1/user-templates",
    "/v1/tenants/demo-tenant-sample-01/groups",
    "/v1/tenants/demo-tenant-sample-01/groups/usage?inactiveDaysThreshold=90",
    "/v1/group-templates",
    "/v1/tenants/demo-tenant-sample-01/mfa-report",
    "/v1/tenants/demo-tenant-sample-01/auth-methods-policy",
    "/v1/tenants/demo-tenant-sample-01/registration-campaign",
    "/v1/tenants/demo-tenant-sample-01/role-assignments",
    "/v1/tenants/demo-tenant-sample-01/pim",
    "/v1/pim-settings-templates",
    "/v1/tenants/demo-tenant-sample-01/jit-grants",
    "/v1/jit-templates",
    // Conditional Access
    "/v1/tenants/demo-tenant-sample-01/ca/policies",
    "/v1/ca-templates",
    "/v1/tenants/demo-tenant-sample-01/ca/report-only",
    "/v1/tenants/demo-tenant-sample-01/ca/coverage",
    "/v1/tenants/demo-tenant-sample-01/ca/history",
    "/v1/tenants/demo-tenant-sample-01/ca/named-locations",
    // Intune & Devices
    "/v1/tenants/demo-tenant-sample-01/intune/configuration",
    "/v1/tenants/demo-tenant-sample-01/intune/compliance",
    "/v1/tenants/demo-tenant-sample-01/intune/app-protection",
    "/v1/tenants/demo-tenant-sample-01/intune/compare?left=a&right=b",
    "/v1/intune-templates",
    "/v1/tenants/demo-tenant-sample-01/intune/assignment-filters",
    "/v1/intune-assignment-filter-templates",
    "/v1/tenants/demo-tenant-sample-01/intune/reusable-settings",
    "/v1/intune-reusable-setting-templates",
    "/v1/tenants/demo-tenant-sample-01/devices",
    "/v1/tenants/demo-tenant-sample-01/devices/dev-demo-01",
    "/v1/tenants/demo-tenant-sample-01/apps",
    "/v1/tenants/demo-tenant-sample-01/apps/queue",
    "/v1/app-templates",
    "/v1/tenants/demo-tenant-sample-01/autopilot/devices",
    "/v1/tenants/demo-tenant-sample-01/autopilot/profiles",
    "/v1/tenants/demo-tenant-sample-01/enrollment-profiles",
    "/v1/tenants/demo-tenant-sample-01/apps/status?view=all",
    // Automation
    "/v1/schedules",
    "/v1/schedules/system",
    "/v1/scripts",
    "/v1/health",
    "/v1/diagnostics",
    // Defender
    "/v1/tenants/demo-tenant-sample-01/defender/status",
    "/v1/tenants/demo-tenant-sample-01/defender/mde-onboarding",
    "/v1/tenants/demo-tenant-sample-01/defender/vulnerabilities",
    "/v1/tenants/demo-tenant-sample-01/defender/cve-exceptions",
    // Email
    "/v1/tenants/demo-tenant-sample-01/mailboxes",
    "/v1/tenants/demo-tenant-sample-01/deleted-mailboxes",
    "/v1/tenants/demo-tenant-sample-01/mailbox-reports?report=statistics",
    "/v1/tenants/demo-tenant-sample-01/retention/policies",
    "/v1/tenants/demo-tenant-sample-01/retention/tags",
    "/v1/tenants/demo-tenant-sample-01/vacation-schedules",
    "/v1/tenants/demo-tenant-sample-01/connectors",
    "/v1/tenants/demo-tenant-sample-01/transport-rules",
    "/v1/tenants/demo-tenant-sample-01/filters/spam",
    "/v1/tenants/demo-tenant-sample-01/quarantine-policies",
    "/v1/tenants/demo-tenant-sample-01/quarantine",
    "/v1/tenants/demo-tenant-sample-01/allow-block",
    "/v1/tenants/demo-tenant-sample-01/contacts",
    "/v1/tenants/demo-tenant-sample-01/resources/rooms",
    "/v1/tenants/demo-tenant-sample-01/mail/encryption",
    // Collaboration
    "/v1/tenants/demo-tenant-sample-01/sharepoint/sites",
    "/v1/tenants/demo-tenant-sample-01/sharepoint/recyclebin",
    "/v1/tenants/demo-tenant-sample-01/sharepoint/sites/spo-site-demo-01/browse",
    "/v1/tenants/demo-tenant-sample-01/sharepoint/sites/spo-site-demo-01/storage",
    "/v1/tenants/demo-tenant-sample-01/onedrive",
    "/v1/tenants/demo-tenant-sample-01/teams",
    "/v1/tenants/demo-tenant-sample-01/teams/activity",
    "/v1/tenants/demo-tenant-sample-01/teams/lis",
    "/v1/tenants/demo-tenant-sample-01/teams/voice/numbers",
    "/v1/tenants/demo-tenant-sample-01/sharing/report",
    "/v1/tenants/demo-tenant-sample-01/sharing/permissions",
    "/v1/tenants/demo-tenant-sample-01/sharing/external-users",
    "/v1/tenants/demo-tenant-sample-01/mailbox-permissions",
    // Security & compliance
    "/v1/tenants/demo-tenant-sample-01/purview/dlp",
    "/v1/tenants/demo-tenant-sample-01/purview/labels",
    "/v1/tenants/demo-tenant-sample-01/purview/retention",
    "/v1/tenants/demo-tenant-sample-01/safelinks",
    "/v1/tenants/demo-tenant-sample-01/purview/sits",
    "/v1/compliance-templates",
    "/v1/secure-score/fleet",
    "/v1/tenants/demo-tenant-sample-01/secure-score",
    "/v1/tenants/demo-tenant-sample-01/audit/directory",
    "/v1/tenants/demo-tenant-sample-01/audit/coverage",
    "/v1/tenants/demo-tenant-sample-01/webhooks",
    "/v1/tenants/demo-tenant-sample-01/audit/exclusion-windows",
    "/v1/incidents",
    "/v1/tenants/demo-tenant-sample-01/alerts",
    "/v1/check-alerts",
    "/v1/test-packs",
    "/v1/custom-tests",
    "/v1/template-repos",
    // Administration
    "/v1/alert-rules",
    "/v1/alert-events",
    "/v1/notifications",
    "/v1/tenants/demo-tenant-sample-01/licenses",
    "/v1/license-pricing",
    "/v1/tenants/demo-tenant-sample-01/domains",
    "/v1/backups",
    "/v1/backup-settings",
    "/v1/settings",
    "/v1/branding",
    "/v1/feature-flags",
    "/v1/logbook",
    "/v1/preferences",
    "/v1/me",
    "/v1/users",
    "/v1/roles",
    "/v1/api-clients",
    "/v1/openapi.json",
    "/v1/template-library",
    "/v1/graph-presets",
    "/v1/tenant-lookup?domain=contoso.demo.example.com",
    "/v1/domain-check?domain=contoso.demo.example.com",
    "/v1/geoip/192.0.2.1",
    "/v1/tenants/demo-tenant-sample-01/consent-requests",
    "/v1/tenants/demo-tenant-sample-01/copilot/settings",
    "/v1/tenants/demo-tenant-sample-01/shadow-ai",
    "/v1/integrations",
  ])("resolves GET %s with status 200", (endpoint) => {
    const resolved = resolveDemoResponse(endpoint, "GET");
    expect(resolved, `missing demo handler for ${endpoint}`).not.toBeNull();
    expect(resolved!.status).toBe(200);
    expect(resolved!.body).toBeDefined();
  });
});

describe("Theme tokens and PII safety (T-0892)", () => {
  it("contains zero hardcoded colour literals in all demo-mode UI and data modules", () => {
    const files = [
      "src/data/demo-dataset.ts",
      "src/lib/demo-mode.ts",
      "src/components/shell/DemoProvider.tsx",
      "src/components/shell/DemoBanner.tsx",
      "src/components/shell/TenantBar.tsx",
      "src/app/layout.tsx",
    ];
    const rootDir = process.cwd();
    for (const file of files) {
      const code = readFileSync(join(rootDir, file), "utf8");
      expect(code, `${file} contains hex color literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${file} contains rgb color literal`).not.toMatch(/\brgba?\s*\(/i);
      expect(code, `${file} contains hsl color literal`).not.toMatch(/\bhsla?\s*\(/i);
    }
  });

  it("uses only reserved documentation domains in demo-dataset.ts", () => {
    const content = readFileSync(join(process.cwd(), "src/data/demo-dataset.ts"), "utf8");
    const emailMatches = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
    expect(emailMatches.length).toBeGreaterThan(0);
    for (const email of emailMatches) {
      expect(email).toMatch(/\.(example|example\.com|invalid)$/);
    }
  });
});
