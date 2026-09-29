/** @vitest-environment jsdom */
// Tests for DefenderSetupWizard (T-0365, EPIC-019 SPEC.md §3.2, §4.2, §11.4).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DefenderSetupWizard,
  defenderDeployUrl,
  type DefenderSetupOutcome,
  type DefenderSetupPlan,
  type DefenderSetupRequest,
} from "./DefenderSetupWizard";

afterEach(() => {
  cleanup();
});

function planFor(
  areas: readonly string[],
  conflicts: readonly string[] = [],
  overwrite = false,
): DefenderSetupPlan {
  return {
    tenantId: "tenant-1",
    overwrite,
    plans: areas.map((area) => ({
      area,
      displayName: area.toUpperCase(),
      supported: true,
      action: "create",
      policyName: `Defender ${area} Baseline`,
      targetScope: "allDevices",
      overwrite,
      conflict: conflicts.includes(area),
      conflictMessage: conflicts.includes(area)
        ? `A policy named 'Defender ${area} Baseline' already exists`
        : null,
      diff: [`+ Policy (${area}): Defender ${area} Baseline`],
      valid: overwrite || !conflicts.includes(area),
    })),
    allValid: areas.every((area) => overwrite || !conflicts.includes(area)),
  };
}

function outcomeFor(areas: readonly string[], states: readonly ("succeeded" | "failed")[] = []): DefenderSetupOutcome {
  return {
    success: states.every((state) => state === "succeeded"),
    state: states.every((state) => state === "succeeded") ? "succeeded" : "partial",
    results: areas.map((area, index) => ({
      area,
      policyId: `pol-${area}`,
      action: "create",
      state: states[index] ?? "succeeded",
      error: states[index] === "failed" ? `${area} failed to apply` : null,
    })),
  };
}

function goToPlanStep(): void {
  fireEvent.click(screen.getByTestId("wizard-area-av"));
  fireEvent.click(screen.getByTestId("wizard-area-edr"));
  fireEvent.click(screen.getByTestId("wizard-next"));
  fireEvent.click(screen.getByTestId("wizard-next"));
}

describe("DefenderSetupWizard stepper (T-0365)", () => {
  it("walks area selection, scope, plan preview, then apply", async () => {
    const seen: DefenderSetupRequest[] = [];
    const onPreviewPlan = vi.fn(async (request: DefenderSetupRequest) => {
      seen.push(request);
      return planFor([...request.policyAreas]);
    });
    const onExecuteDeploy = vi.fn(async () => outcomeFor(["av", "edr"]));
    render(<DefenderSetupWizard tenantId="tenant-1" onPreviewPlan={onPreviewPlan} onExecuteDeploy={onExecuteDeploy} />);

    expect(screen.getByTestId("wizard-step-areas")).toBeTruthy();
    expect(screen.queryByTestId("wizard-apply-button")).toBeNull();

    fireEvent.click(screen.getByTestId("wizard-area-av"));
    fireEvent.click(screen.getByTestId("wizard-area-edr"));
    fireEvent.click(screen.getByTestId("wizard-next"));
    expect(screen.getByTestId("wizard-step-scope")).toBeTruthy();

    fireEvent.click(screen.getByTestId("wizard-next"));
    expect(screen.getByTestId("wizard-step-plan")).toBeTruthy();
    expect(screen.queryByTestId("wizard-plan")).toBeNull();
    expect(screen.getByTestId("wizard-apply-button").hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByTestId("wizard-preview-button"));
    await waitFor(() => expect(screen.getByTestId("wizard-plan")).toBeTruthy());
    expect(screen.getByTestId("wizard-plan-row-av").textContent).toContain("Defender av Baseline");
    expect(screen.getByTestId("wizard-plan-row-edr").textContent).toContain("Defender edr Baseline");

    fireEvent.click(screen.getByTestId("wizard-apply-button"));
    await waitFor(() => expect(screen.getByTestId("wizard-results")).toBeTruthy());
    expect(onExecuteDeploy).toHaveBeenCalledTimes(1);
    expect(seen[0]).toMatchObject({ policyAreas: ["av", "edr"], targetScope: "allDevices" });
  });

  it("requires at least one policy area before leaving the first step", () => {
    render(<DefenderSetupWizard tenantId="tenant-1" />);
    expect(screen.getByTestId("wizard-next").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("wizard-area-unsupported-compliance")).toBeTruthy();
    expect(
      (screen.getByTestId("wizard-area-unsupported-compliance") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("defaults the save-as-template toggle off and passes it through to the deploy call", async () => {
    const previewSeen: DefenderSetupRequest[] = [];
    const deploySeen: DefenderSetupRequest[] = [];
    const onPreviewPlan = vi.fn(async (request: DefenderSetupRequest) => {
      previewSeen.push(request);
      return planFor([...request.policyAreas]);
    });
    const onExecuteDeploy = vi.fn(async (request: DefenderSetupRequest) => {
      deploySeen.push(request);
      return outcomeFor([...request.policyAreas]);
    });
    render(<DefenderSetupWizard tenantId="tenant-1" onPreviewPlan={onPreviewPlan} onExecuteDeploy={onExecuteDeploy} />);

    fireEvent.click(screen.getByTestId("wizard-area-av"));
    fireEvent.click(screen.getByTestId("wizard-area-edr"));
    fireEvent.click(screen.getByTestId("wizard-next"));
    expect((screen.getByTestId("wizard-save-template-toggle") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("wizard-preview-button"));
    await waitFor(() => expect(screen.getByTestId("wizard-plan")).toBeTruthy());

    expect(previewSeen[0]).toMatchObject({ saveAsTemplate: false });

    fireEvent.click(screen.getByTestId("wizard-apply-button"));
    await waitFor(() => expect(screen.getByTestId("wizard-results")).toBeTruthy());
    expect(deploySeen[0]).toMatchObject({ saveAsTemplate: false, overwrite: false });
  });

  it("sends the template name when save-as-template is enabled", async () => {
    const deploySeen: DefenderSetupRequest[] = [];
    const onPreviewPlan = vi.fn(async (request: DefenderSetupRequest) => planFor([...request.policyAreas]));
    const onExecuteDeploy = vi.fn(async (request: DefenderSetupRequest) => {
      deploySeen.push(request);
      return outcomeFor([...request.policyAreas]);
    });
    render(<DefenderSetupWizard tenantId="tenant-1" onPreviewPlan={onPreviewPlan} onExecuteDeploy={onExecuteDeploy} />);

    fireEvent.click(screen.getByTestId("wizard-area-asr"));
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("wizard-save-template-toggle"));
    fireEvent.change(screen.getByTestId("wizard-template-name-input"), { target: { value: "Pilot baseline" } });
    fireEvent.click(screen.getByTestId("wizard-next"));

    fireEvent.click(screen.getByTestId("wizard-preview-button"));
    await waitFor(() => expect(screen.getByTestId("wizard-plan")).toBeTruthy());

    fireEvent.click(screen.getByTestId("wizard-apply-button"));
    await waitFor(() => expect(screen.getByTestId("wizard-results")).toBeTruthy());
    expect(deploySeen[0]).toMatchObject({ saveAsTemplate: true, templateName: "Pilot baseline" });
  });

  it("surfaces the overwrite option when the plan reports existing policies", async () => {
    const deploySeen: DefenderSetupRequest[] = [];
    const onPreviewPlan = vi.fn(async (request: DefenderSetupRequest) =>
      planFor([...request.policyAreas], request.overwrite ? [] : ["edr"], request.overwrite),
    );
    const onExecuteDeploy = vi.fn(async (request: DefenderSetupRequest) => {
      deploySeen.push(request);
      return outcomeFor([...request.policyAreas]);
    });
    render(<DefenderSetupWizard tenantId="tenant-1" onPreviewPlan={onPreviewPlan} onExecuteDeploy={onExecuteDeploy} />);

    goToPlanStep();
    fireEvent.click(screen.getByTestId("wizard-preview-button"));
    await waitFor(() => expect(screen.getByTestId("wizard-conflict-callout")).toBeTruthy());
    expect(screen.getByTestId("wizard-conflict-edr").textContent).toContain("already exists");

    fireEvent.click(screen.getByTestId("wizard-overwrite-toggle"));
    expect(screen.queryByTestId("wizard-plan")).toBeNull();

    fireEvent.click(screen.getByTestId("wizard-preview-button"));
    await waitFor(() => expect(screen.getByTestId("wizard-plan")).toBeTruthy());
    expect(screen.queryByTestId("wizard-conflict-callout")).toBeNull();

    fireEvent.click(screen.getByTestId("wizard-apply-button"));
    await waitFor(() => expect(screen.getByTestId("wizard-results")).toBeTruthy());
    expect(deploySeen[0]).toMatchObject({ overwrite: true });
  });

  it("renders per-area success and failure results", async () => {
    const onPreviewPlan = vi.fn(async (request: DefenderSetupRequest) => planFor([...request.policyAreas]));
    const onExecuteDeploy = vi.fn(async () => outcomeFor(["av", "edr"], ["succeeded", "failed"]));
    render(<DefenderSetupWizard tenantId="tenant-1" onPreviewPlan={onPreviewPlan} onExecuteDeploy={onExecuteDeploy} />);

    goToPlanStep();
    fireEvent.click(screen.getByTestId("wizard-preview-button"));
    await waitFor(() => expect(screen.getByTestId("wizard-plan")).toBeTruthy());

    fireEvent.click(screen.getByTestId("wizard-apply-button"));
    await waitFor(() => expect(screen.getByTestId("wizard-results")).toBeTruthy());
    expect(screen.getByTestId("wizard-result-av").textContent).toContain("succeeded");
    expect(screen.getByTestId("wizard-result-edr").textContent).toContain("failed");
    expect(screen.getByTestId("wizard-result-summary").textContent).not.toContain("succeeded.");
  });

  it("posts to the T-0364 deploy route by default", () => {
    expect(defenderDeployUrl("tenant-1")).toBe("/v1/tenants/tenant-1/defender/deploy");
  });

  it("uses kit tokens with zero colour literals", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = (await import("node:path")).default;
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "DefenderSetupWizard.tsx"),
      "utf8",
    );
    for (const literal of ["#fff", "#000", "rgb(", "rgba("]) {
      expect(source).not.toContain(literal);
    }
    expect(source).toContain("var(--");
  });
});
