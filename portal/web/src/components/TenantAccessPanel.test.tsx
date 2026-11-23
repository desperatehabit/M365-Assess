/** @vitest-environment jsdom */
// T-0942 — per-tenant Access tab: reader/write status, grant/change dialog,
// device-code relay, disable, PFX fallback, and API errors.
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  TenantAccessPanel,
  buildGrantCliCommand,
  type TenantCredentialSummary,
} from "./TenantAccessPanel";

const TENANT_ID = "tenant-1";
const ONBOARD_PATH = `/v1/tenants/${TENANT_ID}/onboard`;
const OPERATOR_CREDENTIAL_PATH = `/v1/tenants/${TENANT_ID}/credential?purpose=operator`;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const READER: TenantCredentialSummary = {
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

const OPERATOR: TenantCredentialSummary = {
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

const PFX_READER: TenantCredentialSummary = {
  ...READER,
  authMethod: "certificate-pfx",
  thumbprint: null,
  secretRef: "tenants/tenant-1/credential.pfx",
};

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
}

type FetchHandler = (call: FetchCall) => Response | Promise<Response> | undefined;

function stubFetch(handler: FetchHandler = () => undefined): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: FetchCall = {
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      const response = await handler(call);
      if (response) return response;
      if (call.url.includes("/onboard/progress/")) {
        return json(200, { state: "done", events: [] });
      }
      return json(404, { code: "request.not_found", message: `No route for ${call.method} ${call.url}` });
    }),
  );
  return calls;
}

function Harness({
  initial,
  reloaded,
}: {
  readonly initial: TenantCredentialSummary[];
  readonly reloaded?: TenantCredentialSummary[];
}): React.ReactElement {
  const [credentials, setCredentials] = useState<TenantCredentialSummary[]>(initial);
  return (
    <TenantAccessPanel
      tenantId={TENANT_ID}
      credentials={credentials}
      onReload={() => {
        if (reloaded) setCredentials(reloaded);
      }}
      progressPollIntervalMs={10}
    />
  );
}

function openGrantDialog(): void {
  fireEvent.click(screen.getByTestId("add-write-access"));
}

function fillAdminUpn(value = "admin@contoso.onmicrosoft.com"): void {
  fireEvent.change(screen.getByTestId("write-admin-upn"), { target: { value } });
}

function submittedBody(calls: FetchCall[]): Record<string, unknown> {
  const call = calls.find((item) => item.method === "POST" && item.url === ONBOARD_PATH);
  expect(call?.body).toBeTruthy();
  return JSON.parse(call!.body!) as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TenantAccessPanel (T-0942)", () => {
  it("shows the reader credential and that write access is not enabled", () => {
    stubFetch();
    render(<TenantAccessPanel tenantId={TENANT_ID} credentials={[READER]} onReload={() => {}} />);

    expect(screen.getByTestId("reader-client-id").textContent).toBe("reader-client");
    expect(screen.getByTestId("reader-auth-method").textContent).toBe("certificate-thumbprint");
    expect(screen.getByTestId("reader-thumbprint").textContent).toBe("AAAA1111BBBB2222");
    expect(screen.getByTestId("reader-state").textContent).toBe("valid");
    expect(screen.getByTestId("write-access-status").textContent).toBe("Not enabled");
    expect(screen.getByTestId("write-access-not-enabled").textContent).toContain(
      "tenant.operator_credential_missing",
    );
    expect(screen.getByTestId("add-write-access")).toBeTruthy();
    expect(screen.queryByTestId("operator-client-id")).toBeNull();
  });

  it("shows the enabled operator card with groups and last update", () => {
    stubFetch();
    render(
      <TenantAccessPanel
        tenantId={TENANT_ID}
        credentials={[READER, OPERATOR]}
        onReload={() => {}}
      />,
    );

    expect(screen.getByTestId("write-access-status").textContent).toBe("Enabled");
    expect(screen.getByTestId("operator-client-id").textContent).toBe("operator-client");
    expect(screen.getByTestId("operator-groups").textContent).toContain("Security");
    expect(screen.getByTestId("operator-last-updated").textContent).not.toBe("Not recorded");
    expect(screen.getByTestId("change-write-groups")).toBeTruthy();
    expect(screen.getByTestId("disable-write-access")).toBeTruthy();
    expect(screen.queryByTestId("add-write-access")).toBeNull();
  });

  it("opens the grant dialog, flags dangerous groups, and posts the expected body", async () => {
    const calls = stubFetch((call) => {
      if (call.url === ONBOARD_PATH) {
        return json(201, { onboarding: { operatorClientId: "operator-new" } });
      }
      return undefined;
    });
    render(
      <Harness
        initial={[READER]}
        reloaded={[READER, { ...OPERATOR, clientId: "operator-new", permissionGroups: ["identity"] }]}
      />,
    );

    openGrantDialog();
    expect(screen.getByTestId("write-access-dialog")).toBeTruthy();
    const identityLabel = screen.getByTestId("write-group-checkbox-identity").closest("label");
    expect(identityLabel?.textContent).toContain("Dangerous");
    expect(screen.getByTestId("write-group-checkbox-security").closest("label")?.textContent).not.toContain(
      "Dangerous",
    );

    fillAdminUpn();
    fireEvent.click(screen.getByTestId("write-group-checkbox-identity"));

    const submit = screen.getByTestId("submit-write-access") as HTMLButtonElement;
    // A dangerous group needs its own confirmation before submit is allowed.
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("confirm-dangerous-grant"));
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByTestId("write-access-dialog")).toBeNull());

    const body = submittedBody(calls);
    expect(body).toMatchObject({
      confirmed: true,
      createNew: false,
      clientId: "reader-client",
      certificateThumbprint: "AAAA1111BBBB2222",
      adminUpn: "admin@contoso.onmicrosoft.com",
      includeWritePermissions: true,
      writePermissionGroups: ["identity"],
      confirmDangerous: true,
      replaceWriteGroups: false,
    });
    expect(typeof body["progressId"]).toBe("string");
    expect((body["progressId"] as string).length).toBeGreaterThan(0);

    await waitFor(() =>
      expect(screen.getByTestId("write-access-status").textContent).toBe("Enabled"),
    );
    expect(screen.getByTestId("write-access-result").textContent).toContain("operator-new");
  });

  it("shows each device code and verification URL, then clears them when sign-in completes", async () => {
    let release: (response: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const snapshots = [
      {
        state: "pending" as const,
        events: [
          {
            sequence: 1,
            kind: "device-code" as const,
            signIn: "graph-operator",
            provider: "Microsoft Graph",
            code: "OPER-1234",
            verificationUrl: "https://microsoft.com/devicelogin",
            expiresAt: "2026-06-01T12:15:00.000Z",
          },
        ],
      },
      {
        state: "pending" as const,
        events: [
          {
            sequence: 2,
            kind: "sign-in-complete" as const,
            signIn: "graph-operator",
            provider: "Microsoft Graph",
            account: "admin@contoso.onmicrosoft.com",
          },
        ],
      },
    ];
    let snapshotIndex = 0;

    stubFetch((call) => {
      if (call.url === ONBOARD_PATH) return gate;
      if (call.url.includes("/onboard/progress/")) {
        return json(
          200,
          snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
        );
      }
      return undefined;
    });

    render(<Harness initial={[READER]} reloaded={[READER, OPERATOR]} />);
    openGrantDialog();
    fillAdminUpn();
    fireEvent.click(screen.getByTestId("write-group-checkbox-security"));
    fireEvent.click(screen.getByTestId("submit-write-access"));

    await waitFor(() => {
      expect(screen.getByTestId("access-device-code").textContent).toBe("OPER-1234");
      expect(screen.getByTestId("access-device-code-url").textContent).toBe(
        "https://microsoft.com/devicelogin",
      );
    });

    // sign-in-complete clears the code and shows the signed-in stage instead.
    await waitFor(() => {
      expect(screen.queryByTestId("access-device-code")).toBeNull();
      expect(screen.getByTestId("access-device-code-signed-in")).toBeTruthy();
    });

    release(json(201, { operatorClientId: "operator-client" }));
    await waitFor(() => expect(screen.getByTestId("write-access-status").textContent).toBe("Enabled"));
    expect(screen.queryByTestId("access-device-code-panel")).toBeNull();
  });

  it("sends replaceWriteGroups when changing an existing grant", async () => {
    const calls = stubFetch((call) => {
      if (call.url === ONBOARD_PATH) return json(201, {});
      return undefined;
    });
    render(
      <Harness
        initial={[READER, OPERATOR]}
        reloaded={[READER, { ...OPERATOR, permissionGroups: ["security", "exchange"] }]}
      />,
    );

    fireEvent.click(screen.getByTestId("change-write-groups"));
    expect(screen.getByTestId("write-access-dialog")).toBeTruthy();
    // Existing groups are preselected so the reconcile keeps them unless removed.
    expect((screen.getByTestId("write-group-checkbox-security") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("write-group-checkbox-exchange") as HTMLInputElement).checked).toBe(false);

    fillAdminUpn();
    fireEvent.click(screen.getByTestId("write-group-checkbox-exchange"));
    fireEvent.click(screen.getByTestId("submit-write-access"));

    await waitFor(() => expect(screen.queryByTestId("write-access-dialog")).toBeNull());
    expect(submittedBody(calls)).toMatchObject({
      replaceWriteGroups: true,
      writePermissionGroups: ["security", "exchange"],
      confirmDangerous: false,
      createNew: false,
    });
    await waitFor(() =>
      expect(screen.getByTestId("operator-groups").textContent).toContain("Exchange & Purview"),
    );
  });

  it("disables write access through DELETE and updates the card", async () => {
    const calls = stubFetch((call) => {
      if (call.url === OPERATOR_CREDENTIAL_PATH && call.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    render(<Harness initial={[READER, OPERATOR]} reloaded={[READER]} />);

    fireEvent.click(screen.getByTestId("disable-write-access"));
    const confirmation = screen.getByTestId("disable-write-confirmation");
    expect(confirmation.textContent).toContain("retained");

    fireEvent.click(screen.getByTestId("confirm-disable-write"));
    await waitFor(() =>
      expect(calls.some((call) => call.method === "DELETE" && call.url === OPERATOR_CREDENTIAL_PATH)).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("write-access-status").textContent).toBe("Not enabled"),
    );
    expect(screen.getByTestId("write-access-result").textContent).toContain("retained");
  });

  it("shows a copyable CLI fallback instead of submitting for a PFX credential", () => {
    const calls = stubFetch();
    render(
      <TenantAccessPanel
        tenantId={TENANT_ID}
        credentials={[PFX_READER]}
        onReload={() => {}}
        progressPollIntervalMs={10}
      />,
    );

    expect(screen.getByTestId("reader-thumbprint").textContent).toContain("PFX");
    openGrantDialog();

    fillAdminUpn();
    fireEvent.click(screen.getByTestId("write-group-checkbox-exchange"));

    const fallback = screen.getByTestId("access-cli-fallback");
    expect(fallback.textContent).toContain("BFF host");
    const command = screen.getByTestId("access-cli-fallback-command").textContent ?? "";
    expect(command).toContain("Grant-M365AssessConsent");
    expect(command).toContain("-AdminUpn 'admin@contoso.onmicrosoft.com'");
    expect(command).toContain("-WritePermissionGroups exchange");
    expect(command).toContain("-ReplaceWriteGroups");
    expect(command).not.toContain("-CertificateThumbprint");
    expect(screen.queryByTestId("submit-write-access")).toBeNull();

    fireEvent.click(screen.getByTestId("copy-access-cli"));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("renders the API error code and message, not a generic failure", async () => {
    stubFetch((call) => {
      if (call.url === ONBOARD_PATH) {
        return json(400, {
          code: "tenant.write_group_invalid",
          message: "Unknown write group 'root'",
        });
      }
      return undefined;
    });
    render(<TenantAccessPanel tenantId={TENANT_ID} credentials={[READER]} onReload={() => {}} />);

    openGrantDialog();
    fillAdminUpn();
    fireEvent.click(screen.getByTestId("write-group-checkbox-security"));
    fireEvent.click(screen.getByTestId("submit-write-access"));

    const error = await screen.findByTestId("write-access-error");
    expect(error.textContent).toContain("tenant.write_group_invalid");
    expect(error.textContent).toContain("Unknown write group 'root'");
    expect(screen.getByTestId("write-access-dialog")).toBeTruthy();
  });

  it("says it is loading, and surfaces a credential-list load failure", () => {
    stubFetch();
    const view = render(
      <TenantAccessPanel tenantId={TENANT_ID} credentials={null} onReload={() => {}} />,
    );
    expect(screen.getByTestId("access-loading").textContent).toContain("Loading");
    view.unmount();

    render(
      <TenantAccessPanel
        tenantId={TENANT_ID}
        credentials={[]}
        error="Could not load tenant credentials: HTTP 403: auth.forbidden: forbidden"
        onReload={() => {}}
      />,
    );
    expect(screen.getByTestId("access-error").textContent).toContain("auth.forbidden");
    expect(screen.getByTestId("reader-credential-missing")).toBeTruthy();
    expect(screen.getByTestId("write-access-status").textContent).toBe("Not enabled");
  });

  it("builds the documented cmdlet fallback", () => {
    const command = buildGrantCliCommand({
      tenantId: TENANT_ID,
      clientId: "reader-client",
      thumbprint: null,
      adminUpn: "admin@contoso.onmicrosoft.com",
      groups: ["identity", "security"],
      confirmDangerous: true,
      replaceWriteGroups: true,
    });
    expect(command).toContain("Grant-M365AssessConsent");
    expect(command).toContain("-WritePermissionGroups identity,security");
    expect(command).toContain("-ConfirmDangerous");
    expect(command).toContain("-ReplaceWriteGroups");
    expect(command).not.toContain("-CertificateThumbprint");
  });
});
