/** @vitest-environment jsdom */
// T-0648 — OptimizationCards, LicenseAssignDialog, and LicenseGateState.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OptimizationCards } from "./OptimizationCards";
import { LicenseAssignDialog } from "./LicenseAssignDialog";
import { LicenseGateState } from "./LicenseGateState";
import type {
  LicenseChangeOutcome,
  LicenseGateFeature,
  LicenseOptimizationResult,
  LicensePlanPreview,
} from "../../lib/licensingApi";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TENANT = "tenant-test";

function optimization(): LicenseOptimizationResult {
  return {
    tenantId: TENANT,
    generatedAt: "2026-01-02T00:00:00.000Z",
    inactivityDays: 30,
    advisory: true,
    unused: [
      {
        skuId: "sku-unused",
        skuPartNumber: "ENTERPRISEPACK",
        affectedUsers: [
          { userId: "u1", userPrincipalName: "u1@example.invalid", displayName: "User One", lastActivityDate: null },
        ],
      },
    ],
    overused: [
      {
        skuId: "sku-over",
        skuPartNumber: "POWER_BI_PRO",
        error: "license assignment limit reached",
        affectedUsers: [
          { userId: "u2", userPrincipalName: "u2@example.invalid", displayName: "User Two", lastActivityDate: "2026-01-01T00:00:00.000Z" },
        ],
      },
    ],
    expiring: [
      {
        skuId: "sku-exp",
        skuPartNumber: "AAD_PREMIUM_P2",
        expirationDateTime: "2026-02-01T00:00:00.000Z",
        daysRemaining: 30,
        affectedUsers: [
          { userId: "u3", userPrincipalName: "u3@example.invalid", displayName: "User Three", lastActivityDate: null },
        ],
      },
    ],
  };
}

describe("OptimizationCards", () => {
  it("renders unused, overused, and expiring cards with links to affected users", () => {
    render(<OptimizationCards tenantId={TENANT} optimization={optimization()} />);

    expect(screen.getByTestId("optimization-card-unused")).toBeTruthy();
    expect(screen.getByTestId("optimization-card-overused")).toBeTruthy();
    expect(screen.getByTestId("optimization-card-expiring")).toBeTruthy();

    expect(screen.getByTestId("optimization-unused-sku-unused-user-u1").getAttribute("href")).toBe("/users/u1");
    expect(screen.getByTestId("optimization-overused-sku-over-user-u2").getAttribute("href")).toBe("/users/u2");
    expect(screen.getByTestId("optimization-expiring-sku-exp-user-u3").getAttribute("href")).toBe("/users/u3");
  });

  it("offers no automatic removal action", () => {
    render(<OptimizationCards tenantId={TENANT} optimization={optimization()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("LicenseGateState", () => {
  const gated: LicenseGateFeature = {
    status: "gated",
    requiredPlans: ["AAD_PREMIUM_P2"],
    missingPlans: ["AAD_PREMIUM_P2"],
  };

  it("explains the required plan for a gated feature", () => {
    render(
      <LicenseGateState feature="ENTRA-PIM-001" gate={gated} label="Privileged Identity Management">
        <div data-testid="gated-content">secret</div>
      </LicenseGateState>,
    );
    const state = screen.getByTestId("license-gate-missing-ENTRA-PIM-001");
    expect(state.textContent).toContain("License missing");
    expect(state.textContent).toContain("AAD_PREMIUM_P2");
    expect(screen.queryByTestId("gated-content")).toBeNull();
  });

  it("renders children when the feature is available", () => {
    render(
      <LicenseGateState
        feature="CA-SIGNINRISK-001"
        gate={{ status: "available", requiredPlans: ["AAD_PREMIUM_P2"], missingPlans: [] }}
      >
        <div data-testid="gated-content">allowed</div>
      </LicenseGateState>,
    );
    expect(screen.getByTestId("gated-content").textContent).toBe("allowed");
    expect(screen.queryByTestId("license-gate-missing-CA-SIGNINRISK-001")).toBeNull();
  });
});

describe("LicenseAssignDialog", () => {
  function preview(): LicensePlanPreview {
    return {
      tenantId: TENANT,
      skuId: "sku-1",
      action: "remove",
      dryRun: true,
      applied: false,
      requiresConfirmation: true,
      planHash: "hash-1",
      rows: [
        { userId: "u1", displayName: "User One", userPrincipalName: "u1@example.invalid", before: { assigned: true }, after: { assigned: false }, change: "remove" },
        { userId: "u2", displayName: "User Two", userPrincipalName: "u2@example.invalid", before: { assigned: true }, after: { assigned: false }, change: "remove" },
      ],
    };
  }

  function outcome(): LicenseChangeOutcome {
    return {
      tenantId: TENANT,
      skuId: "sku-1",
      action: "remove",
      dryRun: false,
      applied: true,
      requiresConfirmation: true,
      planHash: "hash-1",
      stoppedOnFailure: false,
      rows: [
        { userId: "u1", skuId: "sku-1", action: "remove", state: "applied", before: null, after: null, error: null },
        { userId: "u2", skuId: "sku-1", action: "remove", state: "failed", before: null, after: null, error: "not assigned" },
      ],
      summary: { total: 2, applied: 1, planned: 0, failed: 1, skipped: 0 },
    };
  }

  function dialogFetcher() {
    return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { dryRun?: boolean };
      const payload = body.dryRun ? preview() : outcome();
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
  }

  it("shows the plan preview, requires confirmation, then renders per-row bulk results", async () => {
    const fetcher = dialogFetcher();
    let keyCounter = 0;
    render(
      <LicenseAssignDialog
        tenantId={TENANT}
        skuId="sku-1"
        skuPartNumber="ENTERPRISEPACK"
        action="remove"
        userIds={["u1", "u2"]}
        fetcher={fetcher as unknown as typeof fetch}
        idempotencyKeyFactory={() => `key-${++keyCounter}`}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("license-plan-preview")).toBeTruthy());
    expect(screen.getByTestId("license-plan-row-u1")).toBeTruthy();
    expect(screen.getByTestId("license-plan-row-u2")).toBeTruthy();
    expect(screen.getByTestId("license-plan-confirmation-notice")).toBeTruthy();

    // Confirmation is required before the apply button enables.
    expect((screen.getByTestId("license-dialog-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("license-dialog-confirm-checkbox"));
    expect((screen.getByTestId("license-dialog-confirm") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("license-dialog-confirm"));

    await waitFor(() => expect(screen.getByTestId("license-change-results")).toBeTruthy());
    expect(screen.getByTestId("license-result-state-u1").textContent).toContain("applied");
    expect(screen.getByTestId("license-result-state-u2").textContent).toContain("failed");

    const applyCall = fetcher.mock.calls.find((call) => {
      const body = JSON.parse(((call[1] as RequestInit).body as string) ?? "{}");
      return body.dryRun === false;
    });
    expect(applyCall).toBeTruthy();
    const init = applyCall![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-2");
    expect(JSON.parse(init.body as string)).toMatchObject({
      dryRun: false,
      confirm: true,
      confirmPlan: "hash-1",
      userIds: ["u1", "u2"],
    });
  });

  it("previews and confirms a single assign without a plan hash", async () => {
    const fetcher = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { dryRun?: boolean };
      const payload: LicensePlanPreview | LicenseChangeOutcome = body.dryRun
        ? {
            tenantId: TENANT,
            skuId: "sku-1",
            action: "assign",
            dryRun: true,
            applied: false,
            requiresConfirmation: false,
            planHash: "hash-2",
            rows: [
              { userId: "u1", displayName: "User One", userPrincipalName: "u1@example.invalid", before: { assigned: false }, after: { assigned: true }, change: "assign" },
            ],
          }
        : {
            tenantId: TENANT,
            skuId: "sku-1",
            action: "assign",
            dryRun: false,
            applied: true,
            requiresConfirmation: false,
            planHash: "hash-2",
            stoppedOnFailure: false,
            rows: [
              { userId: "u1", skuId: "sku-1", action: "assign", state: "applied", before: null, after: null, error: null },
            ],
            summary: { total: 1, applied: 1, planned: 0, failed: 0, skipped: 0 },
          };
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    });

    let assignKeyCounter = 0;
    render(
      <LicenseAssignDialog
        tenantId={TENANT}
        skuId="sku-1"
        action="assign"
        userIds={["u1"]}
        fetcher={fetcher as unknown as typeof fetch}
        idempotencyKeyFactory={() => `assign-key-${++assignKeyCounter}`}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("license-plan-preview")).toBeTruthy());
    expect(screen.getByTestId("license-dialog-target").textContent).toContain("Single assign");
    expect(screen.queryByTestId("license-plan-confirmation-notice")).toBeNull();

    fireEvent.click(screen.getByTestId("license-dialog-confirm-checkbox"));
    fireEvent.click(screen.getByTestId("license-dialog-confirm"));

    await waitFor(() => expect(screen.getByTestId("license-result-state-u1").textContent).toContain("applied"));
    const applyInit = fetcher.mock.calls[1]![1] as RequestInit;
    expect(JSON.parse(applyInit.body as string)).toMatchObject({ confirmPlan: null, userIds: ["u1"] });
  });
});
