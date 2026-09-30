// T-0765 — CloneToTenantDrawer (EPIC-039 SPEC §3.3, §4.1).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  CloneToTenantDrawer,
  clonePlanPath,
  type ClonePlan,
} from "../src/components/CloneToTenantDrawer";
import type { TemplateLibraryItem } from "../src/components/TemplateLibraryTable";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function item(overrides: Partial<TemplateLibraryItem> = {}): TemplateLibraryItem {
  return {
    id: "lib-1",
    name: "Require MFA",
    type: "conditional-access",
    body: JSON.stringify({ displayName: "Require MFA" }),
    source: "local",
    repoId: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function plan(overrides: Partial<ClonePlan> = {}): ClonePlan {
  return {
    itemId: "lib-1",
    itemType: "conditional-access",
    itemName: "Require MFA",
    itemSource: "local",
    flow: {
      id: "ca-template-deploy",
      epic: "EPIC-015",
      label: "Conditional Access deploy drawer",
      method: "POST",
      path: "/v1/ca-templates/:id/deploy",
    },
    targets: ["tenant-a", "tenant-b"],
    actions: [
      {
        tenantId: "tenant-a",
        action: "deploy",
        templateId: "lib-1",
        flowId: "ca-template-deploy",
        epic: "EPIC-015",
        deployPath: "/v1/ca-templates/:id/deploy",
        description: "Conditional Access deploy drawer → tenant-a",
        diff: ['+ Conditional Access deploy drawer → tenant-a: "Require MFA"'],
      },
      {
        tenantId: "tenant-b",
        action: "deploy",
        templateId: "lib-1",
        flowId: "ca-template-deploy",
        epic: "EPIC-015",
        deployPath: "/v1/ca-templates/:id/deploy",
        description: "Conditional Access deploy drawer → tenant-b",
        diff: ['+ Conditional Access deploy drawer → tenant-b: "Require MFA"'],
      },
    ],
    diff: [
      '+ Conditional Access deploy drawer → tenant-a: "Require MFA"',
      '+ Conditional Access deploy drawer → tenant-b: "Require MFA"',
    ],
    valid: true,
    dryRun: true,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CloneToTenantDrawer", () => {
  it("shows the plan (targets, actions, diff) from the read-only clone route", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(plan()));

    render(
      <CloneToTenantDrawer
        item={item()}
        isOpen
        targets={["tenant-a", "tenant-b"]}
        onClose={vi.fn()}
        fetcher={fetcher as unknown as typeof fetch}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("clone-plan")).toBeTruthy());
    expect(screen.getByTestId("clone-target-tenant-a")).toBeTruthy();
    expect(screen.getByTestId("clone-target-tenant-b")).toBeTruthy();
    expect(screen.getByTestId("clone-action-tenant-a").textContent).toContain("tenant-a");
    expect(screen.getByTestId("clone-diff").textContent).toContain("Require MFA");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      clonePlanPath("lib-1"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("routes confirmation through the owning epic's deploy flow and issues no write itself", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(plan()));
    const onOpenDeployFlow = vi.fn();

    render(
      <CloneToTenantDrawer
        item={item()}
        isOpen
        targets={["tenant-a", "tenant-b"]}
        onClose={vi.fn()}
        fetcher={fetcher as unknown as typeof fetch}
        onOpenDeployFlow={onOpenDeployFlow}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("clone-plan")).toBeTruthy());
    fireEvent.click(screen.getByTestId("clone-continue"));

    expect(onOpenDeployFlow).toHaveBeenCalledWith(expect.objectContaining({ flow: plan().flow }));
    // The only request is the clone plan; the deploy write belongs to the target flow.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalledWith(
      "/v1/ca-templates/:id/deploy",
      expect.anything(),
    );
  });

  it("surfaces a planning failure", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "Missing required permission 'templates.clone'" }, 403));

    render(
      <CloneToTenantDrawer
        item={item()}
        isOpen
        targets={["tenant-a"]}
        onClose={vi.fn()}
        fetcher={fetcher as unknown as typeof fetch}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("clone-error").textContent).toContain("templates.clone"),
    );
  });
});
