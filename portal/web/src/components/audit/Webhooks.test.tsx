// T-0629 — Webhooks and exclusion windows UI (EPIC-032 SPEC.md §3.5, §3.6).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ExclusionWindowsTable,
  createAuditExclusionWindow,
  listAuditExclusionWindows,
  type AuditExclusionWindow,
} from "./ExclusionWindowsTable";
import {
  WebhooksTable,
  deriveWebhookState,
  listWebhookSubscriptions,
  renewWebhookSubscription,
  type WebhookSubscription,
} from "./WebhooksTable";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function webhookSubscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: "sub-1",
    tenantId: "contoso",
    resource: "users",
    notificationUrl: "https://portal.example/v1/webhooks/notify",
    expirationDateTime: "2099-01-01T00:00:00Z",
    state: "active",
    ...overrides,
  };
}

function exclusionWindow(overrides: Partial<AuditExclusionWindow> = {}): AuditExclusionWindow {
  return {
    id: "win-1",
    tenantId: "contoso",
    startsAt: "2026-10-01T00:00:00Z",
    endsAt: "2026-10-08T00:00:00Z",
    reason: "Vacation",
    status: "upcoming",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

type FetchCalls = Array<{ url: string; init?: RequestInit }>;

function callsOf(fetcher: ReturnType<typeof vi.fn>): FetchCalls {
  return fetcher.mock.calls.map(([url, init]) => ({ url: String(url), init }));
}

// ─── WebhooksTable ──────────────────────────────────────────────────────────

describe("WebhooksTable", () => {
  it("renders the §3.5 columns and all four row actions", () => {
    const onRenew = vi.fn();
    const onRecreate = vi.fn();
    const onDelete = vi.fn();
    const onTest = vi.fn();
    render(
      <WebhooksTable
        subscriptions={[
          webhookSubscription({
            id: "sub-1",
            resource: "users",
            tenantId: "contoso",
            expirationDateTime: "2099-01-01T00:00:00Z",
          }),
        ]}
        onRenew={onRenew}
        onRecreate={onRecreate}
        onDelete={onDelete}
        onTest={onTest}
      />,
    );

    const table = screen.getByTestId("webhooks-grid");
    for (const column of ["Resource", "Tenant", "Expires", "State"]) {
      expect(table.textContent).toContain(column);
    }

    const row = screen.getByTestId("webhook-row-sub-1");
    expect(row.textContent).toContain("users");
    expect(row.textContent).toContain("contoso");
    expect(screen.getByTestId("webhook-expires-sub-1").textContent).toContain("2098");

    fireEvent.click(screen.getByTestId("webhook-renew-sub-1"));
    expect(onRenew).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sub-1" }),
    );

    fireEvent.click(screen.getByTestId("webhook-recreate-sub-1"));
    expect(onRecreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sub-1" }),
    );

    fireEvent.click(screen.getByTestId("webhook-delete-sub-1"));
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sub-1" }),
    );

    fireEvent.click(screen.getByTestId("webhook-test-sub-1"));
    expect(onTest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sub-1" }),
    );
  });

  it("shows the alert state for a near-expiry row", () => {
    render(
      <WebhooksTable
        subscriptions={[
          webhookSubscription({
            id: "sub-near",
            expirationDateTime: daysFromNow(5),
          }),
          webhookSubscription({
            id: "sub-far",
            expirationDateTime: daysFromNow(90),
          }),
          webhookSubscription({
            id: "sub-dead",
            expirationDateTime: daysFromNow(-1),
          }),
        ]}
      />,
    );

    const nearBadge = screen.getByTestId("webhook-state-badge-sub-near");
    expect(nearBadge.textContent).toBe("expiring");
    expect(nearBadge.className).toContain("status-badge");

    expect(screen.getByTestId("webhook-state-badge-sub-far").textContent).toBe("active");
    expect(screen.getByTestId("webhook-state-badge-sub-dead").textContent).toBe("expired");
  });

  it("renders the empty state", () => {
    render(<WebhooksTable subscriptions={[]} />);
    expect(screen.getByTestId("webhooks-empty")).toBeTruthy();
  });
});

// ─── deriveWebhookState ─────────────────────────────────────────────────────

describe("deriveWebhookState", () => {
  it("derives active, expiring, and expired from the expiry time", () => {
    const now = "2026-10-01T00:00:00Z";
    expect(deriveWebhookState({ expirationDateTime: daysFromNow(90) }, now)).toBe("active");
    expect(deriveWebhookState({ expirationDateTime: daysFromNow(5) }, now)).toBe("expiring");
    expect(deriveWebhookState({ expirationDateTime: daysFromNow(-1) }, now)).toBe("expired");
  });
});

// ─── ExclusionWindowsTable ──────────────────────────────────────────────────

describe("ExclusionWindowsTable", () => {
  it("lists active and upcoming windows", () => {
    render(
      <ExclusionWindowsTable
        windows={[
          exclusionWindow({ id: "win-1", status: "active", reason: "Maintenance" }),
          exclusionWindow({ id: "win-2", status: "upcoming", reason: "Vacation" }),
        ]}
      />,
    );

    const table = screen.getByTestId("exclusion-windows-grid");
    for (const column of ["Reason", "Starts", "Ends", "Status"]) {
      expect(table.textContent).toContain(column);
    }

    expect(screen.getByTestId("exclusion-window-row-win-1").textContent).toContain("Maintenance");
    expect(screen.getByTestId("exclusion-window-status-badge-win-1").textContent).toBe("active");
    expect(screen.getByTestId("exclusion-window-status-badge-win-2").textContent).toBe("upcoming");
  });

  it("creates a new window with a valid range", async () => {
    const onCreate = vi.fn();
    render(<ExclusionWindowsTable windows={[]} onCreate={onCreate} />);

    fireEvent.change(screen.getByTestId("exclusion-window-starts"), {
      target: { value: "2026-10-01T00:00" },
    });
    fireEvent.change(screen.getByTestId("exclusion-window-ends"), {
      target: { value: "2026-10-08T00:00" },
    });
    fireEvent.change(screen.getByTestId("exclusion-window-reason"), {
      target: { value: "Vacation" },
    });
    fireEvent.click(screen.getByTestId("exclusion-window-create-submit"));

    expect(onCreate).toHaveBeenCalledWith({
      startsAt: "2026-10-01T00:00",
      endsAt: "2026-10-08T00:00",
      reason: "Vacation",
    });
    expect(screen.queryByTestId("exclusion-window-validation-error")).toBeNull();
  });

  it("rejects an invalid range where endsAt is not after startsAt", () => {
    const onCreate = vi.fn();
    render(<ExclusionWindowsTable windows={[]} onCreate={onCreate} />);

    fireEvent.change(screen.getByTestId("exclusion-window-starts"), {
      target: { value: "2026-10-08T00:00" },
    });
    fireEvent.change(screen.getByTestId("exclusion-window-ends"), {
      target: { value: "2026-10-01T00:00" },
    });
    fireEvent.click(screen.getByTestId("exclusion-window-create-submit"));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByTestId("exclusion-window-validation-error").textContent).toContain(
      "endsAt must be after startsAt",
    );
  });

  it("rejects an invalid range where endsAt equals startsAt", () => {
    const onCreate = vi.fn();
    render(<ExclusionWindowsTable windows={[]} onCreate={onCreate} />);

    fireEvent.change(screen.getByTestId("exclusion-window-starts"), {
      target: { value: "2026-10-01T00:00" },
    });
    fireEvent.change(screen.getByTestId("exclusion-window-ends"), {
      target: { value: "2026-10-01T00:00" },
    });
    fireEvent.click(screen.getByTestId("exclusion-window-create-submit"));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByTestId("exclusion-window-validation-error").textContent).toContain(
      "endsAt must be after startsAt",
    );
  });

  it("requires both startsAt and endsAt", () => {
    const onCreate = vi.fn();
    render(<ExclusionWindowsTable windows={[]} onCreate={onCreate} />);

    fireEvent.change(screen.getByTestId("exclusion-window-starts"), {
      target: { value: "2026-10-01T00:00" },
    });
    fireEvent.click(screen.getByTestId("exclusion-window-create-submit"));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByTestId("exclusion-window-validation-error").textContent).toContain(
      "required",
    );
  });
});

// ─── API clients ────────────────────────────────────────────────────────────

describe("webhook API client", () => {
  it("lists subscriptions from the T-0625 endpoint", async () => {
    const fetcher = vi.fn(async (): Promise<Response> =>
      jsonResponse({
        success: true,
        tenantId: "contoso",
        subscriptions: [webhookSubscription()],
      }),
    );
    const result = await listWebhookSubscriptions("contoso", fetcher as unknown as typeof fetch);
    expect(result.subscriptions).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith("/v1/tenants/contoso/webhooks");
  });

  it("renews a subscription via the T-0625 renew endpoint", async () => {
    const fetcher = vi.fn(async (): Promise<Response> =>
      jsonResponse({ success: true, subscription: webhookSubscription() }),
    );
    const result = await renewWebhookSubscription("contoso", "sub-1", fetcher as unknown as typeof fetch);
    expect(result.success).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/tenants/contoso/webhooks/sub-1/renew",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("exclusion-window API client", () => {
  it("lists windows from the T-0626 endpoint", async () => {
    const fetcher = vi.fn(async (): Promise<Response> =>
      jsonResponse({ items: [exclusionWindow()] }),
    );
    const result = await listAuditExclusionWindows("contoso", fetcher as unknown as typeof fetch);
    expect(result.items).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith("/v1/tenants/contoso/audit/exclusion-windows");
  });

  it("creates a window via the T-0626 endpoint", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => jsonResponse(exclusionWindow(), 201));
    const created = await createAuditExclusionWindow(
      "contoso",
      { startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-08T00:00:00Z", reason: "Vacation" },
      fetcher as unknown as typeof fetch,
    );
    expect(created.id).toBe("win-1");
    const call = callsOf(fetcher).find((entry) => entry.url === "/v1/tenants/contoso/audit/exclusion-windows");
    expect(call?.init?.method).toBe("POST");
    const body = JSON.parse(call?.init?.body as string) as Record<string, unknown>;
    expect(body["startsAt"]).toBe("2026-10-01T00:00:00Z");
    expect(body["endsAt"]).toBe("2026-10-08T00:00:00Z");
    expect(body["reason"]).toBe("Vacation");
  });
});
