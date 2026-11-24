// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharePointTemplate } from "../../../lib/sharepointApi";
import SharePointTemplatesPage from "./page";

vi.mock("../../../lib/useCurrentTenant", () => ({
  useCurrentTenantId: () => "t-a",
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const INITIAL_TEMPLATES: SharePointTemplate[] = [
  {
    id: "tpl-1",
    name: "Standard Project Site",
    siteType: "team",
    settings: { sharing: "disabled" },
    variables: { department: "Engineering" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    deletedAt: null,
  },
  {
    id: "tpl-2",
    name: "Comms Hub",
    siteType: "communication",
    settings: { sharing: "externalUserSharingOnly" },
    variables: {},
    createdAt: "2026-01-03T00:00:00Z",
    updatedAt: "2026-01-04T00:00:00Z",
    deletedAt: null,
  },
];

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let templatesState: SharePointTemplate[] = [];
let calls: RecordedCall[] = [];

function installFetch(): void {
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (method === "GET" && url === "/v1/sharepoint/templates") {
      return jsonResponse({ items: templatesState });
    }
    if (method === "POST" && url === "/v1/sharepoint/templates") {
      const payload = body as {
        name: string;
        siteType: "team" | "communication";
        settings?: Record<string, unknown>;
        variables?: Record<string, unknown>;
      };
      const created: SharePointTemplate = {
        id: `tpl-${templatesState.length + 1}`,
        name: payload.name,
        siteType: payload.siteType,
        settings: payload.settings ?? {},
        variables: payload.variables ?? {},
        createdAt: "2026-01-05T00:00:00Z",
        updatedAt: "2026-01-05T00:00:00Z",
        deletedAt: null,
      };
      templatesState = [...templatesState, created];
      return jsonResponse(created, 201);
    }
    if (method === "PATCH" && url.startsWith("/v1/sharepoint/templates/")) {
      const id = decodeURIComponent(url.replace("/v1/sharepoint/templates/", ""));
      const patch = body as Partial<SharePointTemplate>;
      const existing = templatesState.find((t) => t.id === id);
      if (!existing) {
        return jsonResponse({ message: "Not found" }, 404);
      }
      const updated: SharePointTemplate = {
        ...existing,
        ...patch,
        updatedAt: "2026-01-06T00:00:00Z",
      };
      templatesState = templatesState.map((t) => (t.id === id ? updated : t));
      return jsonResponse(updated);
    }
    if (method === "DELETE" && url.startsWith("/v1/sharepoint/templates/")) {
      const id = decodeURIComponent(url.replace("/v1/sharepoint/templates/", ""));
      templatesState = templatesState.filter((t) => t.id !== id);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && url.endsWith("/deploy")) {
      const req = body as {
        targets?: string[];
        name?: string;
        alias?: string;
        preview?: boolean;
      };
      const targets = req.targets ?? [];
      if (req.preview) {
        return jsonResponse({
          templateId: "tpl-1",
          preview: true,
          allValid: true,
          plans: targets.map((tenantId) => ({
            tenantId,
            targetName: req.name ?? "Engineering Team Site",
            alias: req.alias ?? "eng-site",
            type: "team",
            owners: ["owner@contoso.example.com"],
            sharing: "disabled",
            diff: [`+ Create team site ${req.name ?? "Engineering Team Site"}`],
            valid: true,
            dryRun: true,
            error: null,
          })),
        });
      }
      return jsonResponse(
        {
          templateId: "tpl-1",
          preview: false,
          results: [
            {
              tenantId: targets[0] ?? "t-a",
              status: "created",
              targetName: req.name ?? "Engineering Team Site",
              alias: req.alias ?? "eng-site",
              siteId: "site-new-1",
              error: null,
            },
            ...(targets.slice(1).map((tenantId) => ({
              tenantId,
              status: "failed" as const,
              targetName: req.name ?? "Engineering Team Site",
              alias: req.alias ?? "eng-site",
              siteId: null,
              error: "Tenant consent missing",
            }))),
          ],
          summary: {
            total: targets.length,
            created: 1,
            failed: Math.max(0, targets.length - 1),
          },
        },
        targets.length > 1 ? 207 : 200,
      );
    }
    return jsonResponse({ message: `Unexpected request ${method} ${url}` }, 404);
  }) as unknown as typeof fetch;
}

describe("SharePoint templates page (T-0896)", () => {
  beforeEach(() => {
    templatesState = INITIAL_TEMPLATES.map((t) => ({ ...t }));
    calls = [];
    installFetch();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists templates, supports create validation, and creates a template", async () => {
    render(<SharePointTemplatesPage />);

    expect(await screen.findByText("Standard Project Site")).toBeTruthy();
    expect(screen.getByText("Comms Hub")).toBeTruthy();

    fireEvent.click(screen.getByTestId("create-template-button"));
    expect(screen.getByTestId("template-editor-dialog")).toBeTruthy();

    fireEvent.click(screen.getByTestId("template-editor-submit"));
    expect(screen.getByTestId("template-editor-error").textContent).toContain("Template name is required");

    fireEvent.change(screen.getByTestId("template-name-input"), { target: { value: "Finance Vault" } });
    fireEvent.change(screen.getByTestId("template-variables-input"), { target: { value: "{bad json" } });
    fireEvent.click(screen.getByTestId("template-editor-submit"));
    expect(screen.getByTestId("template-editor-error").textContent).toContain("Variables must be valid JSON");

    fireEvent.change(screen.getByTestId("template-site-type-select"), { target: { value: "communication" } });
    fireEvent.change(screen.getByTestId("template-sharing-select"), {
      target: { value: "existingExternalUserSharingOnly" },
    });
    fireEvent.change(screen.getByTestId("template-variables-input"), {
      target: { value: '{"region": "US"}' },
    });
    fireEvent.click(screen.getByTestId("template-editor-submit"));

    await waitFor(() => expect(screen.queryByTestId("template-editor-dialog")).toBeNull());
    expect(await screen.findByText("Finance Vault")).toBeTruthy();

    const postCall = calls.find((c) => c.method === "POST" && c.url === "/v1/sharepoint/templates");
    expect(postCall?.body).toEqual({
      name: "Finance Vault",
      siteType: "communication",
      settings: { sharing: "existingExternalUserSharingOnly" },
      variables: { region: "US" },
    });
  });

  it("edits and deletes a template", async () => {
    render(<SharePointTemplatesPage />);
    await screen.findByText("Standard Project Site");

    fireEvent.click(screen.getByTestId("edit-template-tpl-1"));
    expect(screen.getByTestId("template-editor-dialog")).toBeTruthy();
    fireEvent.change(screen.getByTestId("template-name-input"), {
      target: { value: "Updated Project Site" },
    });
    fireEvent.click(screen.getByTestId("template-editor-submit"));

    await waitFor(() => expect(screen.getByText("Updated Project Site")).toBeTruthy());
    const patchCall = calls.find((c) => c.method === "PATCH" && c.url === "/v1/sharepoint/templates/tpl-1");
    expect(patchCall?.body).toMatchObject({ name: "Updated Project Site" });

    fireEvent.click(screen.getByTestId("delete-template-tpl-2"));
    await waitFor(() => expect(screen.queryByText("Comms Hub")).toBeNull());
    const deleteCall = calls.find((c) => c.method === "DELETE" && c.url === "/v1/sharepoint/templates/tpl-2");
    expect(deleteCall).toBeTruthy();
  });

  it("previews and applies multi-tenant deployment including partial failures", async () => {
    render(<SharePointTemplatesPage />);
    await screen.findByText("Standard Project Site");

    fireEvent.click(screen.getByTestId("deploy-template-tpl-1"));
    expect(screen.getByTestId("template-deploy-dialog")).toBeTruthy();

    const targetsInput = screen.getByTestId("deploy-targets-input") as HTMLTextAreaElement;
    expect(targetsInput.value).toBe("t-a");

    fireEvent.change(targetsInput, { target: { value: "t-a, t-b" } });
    fireEvent.change(screen.getByTestId("deploy-name-input"), { target: { value: "{{department}} Space" } });
    fireEvent.change(screen.getByTestId("deploy-alias-input"), { target: { value: "eng-space" } });
    fireEvent.change(screen.getByTestId("deploy-owners-input"), {
      target: { value: "owner@contoso.example.com" },
    });

    fireEvent.click(screen.getByTestId("deploy-preview-button"));
    const plansEl = await screen.findByTestId("deploy-plans");
    expect(plansEl.textContent).toContain("t-a");
    expect(plansEl.textContent).toContain("t-b");
    expect(plansEl.textContent).toContain("{{department}} Space");

    fireEvent.click(screen.getByTestId("deploy-apply-button"));
    const resultsEl = await screen.findByTestId("deploy-results");
    expect(resultsEl.textContent).toContain("1/2 created");
    expect(resultsEl.textContent).toContain("1 failed");
    expect(resultsEl.textContent).toContain("site-new-1");
    expect(resultsEl.textContent).toContain("Tenant consent missing");

    const applyCall = calls.find(
      (c) =>
        c.method === "POST" &&
        c.url === "/v1/sharepoint/templates/tpl-1/deploy" &&
        (c.body as { preview?: boolean }).preview === false,
    );
    expect(applyCall?.body).toEqual({
      targets: ["t-a", "t-b"],
      name: "{{department}} Space",
      alias: "eng-space",
      owners: ["owner@contoso.example.com"],
      sharing: "disabled",
      variables: { department: "Engineering" },
      preview: false,
    });
  });

  it("uses CSS theme tokens without colour literals across updated SharePoint views", () => {
    const webSrc = path.resolve(__dirname, "../../..");
    const filesToCheck = [
      path.join(webSrc, "app/sharepoint/templates/page.tsx"),
      path.join(webSrc, "app/sharepoint/sites/page.tsx"),
      path.join(webSrc, "components/sharepoint/SiteDetailViews.tsx"),
    ];
    const colourLiteralPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;
    for (const filePath of filesToCheck) {
      const content = fs.readFileSync(filePath, "utf8");
      expect(content, `${filePath} must use CSS variables instead of colour literals`).not.toMatch(
        colourLiteralPattern,
      );
    }
  });
});
