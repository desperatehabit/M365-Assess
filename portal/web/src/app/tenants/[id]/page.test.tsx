/** @vitest-environment jsdom */
// T-0910 — tenant detail Variables and History tabs load from mounted routes
// and show a load failure instead of an empty list.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TenantDetailPage, {
  tenantCredentialsPath,
  tenantHistoryPath,
  tenantVariablesPath,
} from "./page";

const TENANT_ID = "tenant-1";

const TENANT = {
  id: TENANT_ID,
  displayName: "Test Tenant",
  defaultDomain: "tenant.example",
  initialDomain: "tenant.onmicrosoft.example",
  source: "direct",
  status: "active",
  excluded: false,
  excludeReason: null,
  environment: "commercial",
  errorCount: 0,
  lastError: null,
  lastRunAt: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Responder = (url: string) => Response | undefined;

function stubFetch(responder: Responder): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const custom = responder(url);
      if (custom) return custom;
      if (url === `/v1/tenants/${TENANT_ID}`) return json(200, TENANT);
      if (url === tenantVariablesPath(TENANT_ID)) {
        return json(200, {
          items: [
            { id: "v1", tenantId: TENANT_ID, name: "SupportEmail", value: "help@tenant.example", isSecret: false },
            { id: "v2", tenantId: TENANT_ID, name: "ApiToken", value: "********", isSecret: true },
          ],
          nextCursor: null,
        });
      }
      if (url === tenantHistoryPath(TENANT_ID)) {
        return json(200, {
          items: [
            {
              id: "e1",
              timestamp: "2026-06-15T12:00:00.000Z",
              actor: "operator-1",
              actorType: "user",
              tenantId: TENANT_ID,
              action: "tenant.update",
              targetType: "tenant",
              targetId: TENANT_ID,
              result: "success",
              error: null,
              correlationId: null,
            },
          ],
          nextCursor: null,
          totalCount: 1,
        });
      }
      return json(404, { code: "request.not_found", message: `No route for GET ${url}` });
    }),
  );
  return calls;
}

async function renderPage(): Promise<void> {
  render(<TenantDetailPage params={{ id: TENANT_ID }} />);
  await screen.findByTestId("tab-variables");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Tenant detail tabs (T-0910)", () => {
  it("builds paths to the mounted tenant-variables and logbook routes", () => {
    expect(tenantVariablesPath("a b")).toBe("/v1/tenant-variables?tenantId=a%20b&includeGlobal=false");
    expect(tenantHistoryPath("a b")).toBe("/v1/logbook?tenant=a%20b");
  });

  it("loads variables and history from the mounted routes, not the old tenant sub-paths", async () => {
    const calls = stubFetch(() => undefined);
    await renderPage();

    expect(calls).toContain(tenantVariablesPath(TENANT_ID));
    expect(calls).toContain(tenantHistoryPath(TENANT_ID));
    expect(calls).not.toContain(`/v1/tenants/${TENANT_ID}/variables`);
    expect(calls).not.toContain(`/v1/tenants/${TENANT_ID}/audit`);
  });

  it("lists the tenant's variables and masks secrets", async () => {
    stubFetch(() => undefined);
    await renderPage();

    await waitFor(() => expect(screen.getByTestId("tab-variables").textContent).toContain("(2)"));
    fireEvent.click(screen.getByTestId("tab-variables"));
    const tab = screen.getByTestId("variables-tab-content");
    expect(tab.textContent).toContain("%SupportEmail%");
    expect(tab.textContent).toContain("help@tenant.example");
    expect(tab.textContent).toContain("%ApiToken%");
    expect(tab.textContent).not.toContain("********");
  });

  it("shows the tenant's logbook entries with the actor", async () => {
    stubFetch(() => undefined);
    await renderPage();

    fireEvent.click(screen.getByTestId("tab-history"));
    const tab = await screen.findByTestId("history-tab-content");
    await waitFor(() => expect(tab.textContent).toContain("tenant.update"));
    expect(tab.textContent).toContain("operator-1");
    expect(tab.textContent).toContain("success");
  });

  it("shows an error, not an empty list, when either load fails", async () => {
    stubFetch((url) => {
      if (url === tenantVariablesPath(TENANT_ID)) {
        return json(403, { code: "auth.forbidden", message: "forbidden" });
      }
      if (url === tenantHistoryPath(TENANT_ID)) {
        return json(500, { code: "internal", message: "boom" });
      }
      return undefined;
    });
    await renderPage();

    fireEvent.click(screen.getByTestId("tab-variables"));
    const variablesError = await screen.findByTestId("variables-error");
    expect(variablesError.textContent).toContain("HTTP 403");
    expect(screen.getByTestId("variables-tab-content").textContent).not.toContain(
      "No tenant-specific variables defined.",
    );

    fireEvent.click(screen.getByTestId("tab-history"));
    const historyError = await screen.findByTestId("history-error");
    expect(historyError.textContent).toContain("HTTP 500");
    expect(screen.getByTestId("history-tab-content").textContent).not.toContain(
      "No audit events recorded for this tenant.",
    );
  });
});

describe("Tenant detail Access tab (T-0942)", () => {
  const READER = {
    purpose: "reader",
    clientId: "reader-client",
    authMethod: "certificate-thumbprint",
    thumbprint: "AAAA1111BBBB2222",
    secretRef: "tenants/tenant-1/credential",
    environment: "commercial",
    expiresOn: "2027-06-01T00:00:00.000Z",
    lastValidated: "2026-06-01T10:00:00.000Z",
    state: "valid",
    permissionGroups: [],
  };

  const OPERATOR = {
    purpose: "operator",
    clientId: "operator-client",
    authMethod: "certificate-thumbprint",
    thumbprint: "AAAA1111BBBB2222",
    secretRef: "tenants/tenant-1/operator-credential",
    environment: "commercial",
    expiresOn: "2027-06-01T00:00:00.000Z",
    lastValidated: "2026-06-10T09:30:00.000Z",
    state: "valid",
    permissionGroups: ["security"],
  };

  it("loads reader and operator credentials from /credentials and shows write status", async () => {
    const calls = stubFetch((url) => {
      if (url === tenantCredentialsPath(TENANT_ID)) {
        return json(200, { items: [READER, OPERATOR] });
      }
      return undefined;
    });
    render(<TenantDetailPage params={{ id: TENANT_ID }} />);
    await screen.findByTestId("tab-access");

    expect(calls).toContain(tenantCredentialsPath(TENANT_ID));
    expect(calls).not.toContain(`/v1/tenants/${TENANT_ID}/credential`);

    fireEvent.click(screen.getByTestId("tab-access"));
    const tab = await screen.findByTestId("access-tab-content");
    await waitFor(() => expect(tab.textContent).toContain("reader-client"));

    expect(screen.getByTestId("reader-thumbprint").textContent).toBe("AAAA1111BBBB2222");
    expect(screen.getByTestId("write-access-status").textContent).toBe("Enabled");
    expect(screen.getByTestId("operator-client-id").textContent).toBe("operator-client");
    expect(screen.getByTestId("operator-groups").textContent).toContain("Security");
  });

  it("shows a credential load failure inside the Access tab", async () => {
    stubFetch((url) => {
      if (url === tenantCredentialsPath(TENANT_ID)) {
        return json(500, { code: "internal", message: "credential store offline" });
      }
      return undefined;
    });
    render(<TenantDetailPage params={{ id: TENANT_ID }} />);
    await screen.findByTestId("tab-access");

    fireEvent.click(screen.getByTestId("tab-access"));
    const error = await screen.findByTestId("access-error");
    expect(error.textContent).toContain("HTTP 500");
    expect(error.textContent).toContain("credential store offline");
    expect(screen.getByTestId("write-access-status").textContent).toBe("Not enabled");
  });
});
