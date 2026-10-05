/** @vitest-environment jsdom */

// Mailbox administration UI (EPIC-020 SPEC.md §3; T-0389): list filters,
// plan-preview dialogs, forwarding flags, vacation End now, retention assign.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MailboxesView, buildMailboxesQuery, isSecuritySensitiveAction } from "./page";
import { RulesView, isForwardingRuleChange } from "./rules/page";
import { VacationView, sortVacationSchedules } from "./vacation/page";
import { RetentionView } from "./retention/page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE_MAILBOXES = {
  items: [
    {
      id: "mbx-1",
      displayName: "Example User",
      primarySmtpAddress: "user@example.invalid",
      type: "user",
      quotaUsed: "45 GB",
      quotaPercent: 90,
      archive: false,
      hold: false,
      forwarding: true,
      forwardingTo: "external@example.invalid",
      lastActivity: "2026-09-20T00:00:00.000Z",
    },
  ],
  nextCursor: null,
};

describe("buildMailboxesQuery", () => {
  it("maps every §3.1 filter to the BFF read API", () => {
    const query = buildMailboxesQuery({
      search: "user",
      type: "shared",
      hold: true,
      forwarding: false,
      archive: true,
      quotaPercent: 90,
      inactiveDays: 30,
    });
    const params = new URLSearchParams(query);
    expect(params.get("search")).toBe("user");
    expect(params.get("type")).toBe("shared");
    expect(params.get("hold")).toBe("true");
    expect(params.get("forwarding")).toBe("false");
    expect(params.get("archive")).toBe("true");
    expect(params.get("quotaPercent")).toBe("90");
    expect(params.get("inactiveDays")).toBe("30");
  });
});

describe("buildMailboxesQuery cursor (T-0895)", () => {
  it("adds the cursor only when one is supplied", () => {
    expect(new URLSearchParams(buildMailboxesQuery({}, 100, "c1")).get("cursor")).toBe("c1");
    expect(new URLSearchParams(buildMailboxesQuery({})).has("cursor")).toBe(false);
    expect(new URLSearchParams(buildMailboxesQuery({}, 100, null)).has("cursor")).toBe(false);
  });
});

describe("isSecuritySensitiveAction", () => {
  it("flags forwarding, convert, and delete as security-sensitive", () => {
    expect(isSecuritySensitiveAction("forwarding")).toBe(true);
    expect(isSecuritySensitiveAction("convert")).toBe(true);
    expect(isSecuritySensitiveAction("delete")).toBe(true);
    expect(isSecuritySensitiveAction("quota")).toBe(false);
    expect(isSecuritySensitiveAction("view")).toBe(false);
  });
});

describe("isForwardingRuleChange", () => {
  it("detects forwarding payloads that need the BEC flag and confirmation", () => {
    expect(isForwardingRuleChange({ forwardTo: "external@example.invalid" })).toBe(true);
    expect(isForwardingRuleChange({ redirectTo: "other@example.invalid" })).toBe(true);
    expect(isForwardingRuleChange({})).toBe(false);
    expect(isForwardingRuleChange({ forwardTo: "" })).toBe(false);
  });
});

describe("sortVacationSchedules", () => {
  it("lists active schedules before upcoming and ended ones", () => {
    const sorted = sortVacationSchedules([
      { id: "s-ended", tenantId: "t", mailboxId: "m", startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-02T00:00:00Z", oooMessage: "x", forwardTo: null, state: "ended" },
      { id: "s-upcoming", tenantId: "t", mailboxId: "m", startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-12-02T00:00:00Z", oooMessage: "x", forwardTo: null, state: "upcoming" },
      { id: "s-active", tenantId: "t", mailboxId: "m", startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-10-01T00:00:00Z", oooMessage: "x", forwardTo: null, state: "active" },
    ]);
    expect(sorted.map((schedule) => schedule.id)).toEqual(["s-active", "s-upcoming", "s-ended"]);
  });
});

describe("MailboxesView", () => {
  it("renders the §3.1 columns, filters, and row actions from the BFF read API", async () => {
    const fetcher = vi.fn(async () => jsonResponse(SAMPLE_MAILBOXES));
    render(<MailboxesView tenantId="tenant-1" fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId("mailbox-row-mbx-1")).toBeTruthy());
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/v1/tenants/tenant-1/mailboxes"));
    const headers = screen.getByTestId("mailboxes-table").querySelector("thead")?.textContent ?? "";
    for (const column of ["Display name", "Primary SMTP", "Type", "Quota used", "Archive", "Hold", "Forwarding", "Last activity"]) {
      expect(headers).toContain(column);
    }
    expect(screen.getByTestId("mailboxes-search")).toBeTruthy();
    expect(screen.getByTestId("mailboxes-filter-type")).toBeTruthy();
    expect(screen.getByTestId("mailboxes-filter-forwarding")).toBeTruthy();
    expect(screen.getByTestId("mailbox-row-mbx-1")).toBeTruthy();
    expect(screen.getByTestId("forwarding-flag-mbx-1").textContent).toContain("Forwarding");
    expect(screen.getByTestId("mailbox-convert-mbx-1")).toBeTruthy();
    expect(screen.getByTestId("mailbox-permissions-mbx-1")).toBeTruthy();
    expect(screen.getByTestId("mailbox-rules-mbx-1")).toBeTruthy();
  });

  it("disables write actions the caller cannot use (RBAC)", async () => {
    const fetcher = vi.fn(async () => jsonResponse(SAMPLE_MAILBOXES));
    render(<MailboxesView tenantId="tenant-1" canWrite={false} fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId("mailbox-row-mbx-1")).toBeTruthy());
    const convert = screen.getByTestId("mailbox-convert-mbx-1") as HTMLButtonElement;
    expect(convert.disabled).toBe(true);
    expect(convert.title).toContain("mailboxes.write");
  });

  it("previews the plan before applying a convert", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(init?.body ?? "").includes('"preview":true')) {
        return jsonResponse({ action: "convert", targetName: "mbx-1", diff: ["Convert mbx-1 to shared"], valid: true, dryRun: true, requiresConfirmation: true });
      }
      if (String(init?.body ?? "").includes('"preview":false')) {
        return jsonResponse({ success: true });
      }
      return jsonResponse(SAMPLE_MAILBOXES);
    });
    render(<MailboxesView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("mailbox-row-mbx-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("mailbox-convert-mbx-1"));

    await waitFor(() => expect(screen.getByTestId("mailbox-action-dialog")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("mailbox-plan-diff").textContent).toContain("Convert mbx-1 to shared"));
    fireEvent.click(screen.getByTestId("mailbox-dialog-confirm"));

    await waitFor(() => expect(screen.getByTestId("mailboxes-notice")).toBeTruthy());
    const apply = calls.find((call) => call.body.includes('"preview":false'));
    expect(apply?.body).toContain('"confirm":true');
  });
});

function mailboxRow(id: string) {
  return { ...SAMPLE_MAILBOXES.items[0]!, id, displayName: `Mailbox ${id}`, primarySmtpAddress: `${id}@example.invalid` };
}

describe("MailboxesView paging (T-0895)", () => {
  it("offers Load more while the BFF returns a nextCursor and appends the next page", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(String(url));
      const cursor = new URL(String(url), "http://x").searchParams.get("cursor");
      if (cursor === null) return jsonResponse({ items: [mailboxRow("m1"), mailboxRow("m2")], nextCursor: "cursor-2" });
      if (cursor === "cursor-2") return jsonResponse({ items: [mailboxRow("m3")], nextCursor: "cursor-3" });
      return jsonResponse({ items: [mailboxRow("m4")], nextCursor: null });
    });
    render(<MailboxesView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("mailbox-row-m2")).toBeTruthy());
    expect(screen.queryByTestId("mailbox-row-m3")).toBeNull();

    fireEvent.click(screen.getByTestId("mailboxes-load-more"));
    await waitFor(() => expect(screen.getByTestId("mailbox-row-m3")).toBeTruthy());
    expect(screen.getByTestId("mailbox-row-m1")).toBeTruthy();
    expect(urls[1]).toContain("cursor=cursor-2");

    fireEvent.click(screen.getByTestId("mailboxes-load-more"));
    await waitFor(() => expect(screen.getByTestId("mailbox-row-m4")).toBeTruthy());
    expect(urls[2]).toContain("cursor=cursor-3");
    expect(screen.getAllByTestId(/^mailbox-row-/)).toHaveLength(4);
    expect(screen.queryByTestId("mailboxes-load-more")).toBeNull();
  });

  it("shows no Load more when the first page is the whole list", async () => {
    const fetcher = vi.fn(async () => jsonResponse(SAMPLE_MAILBOXES));
    render(<MailboxesView tenantId="tenant-1" fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId("mailbox-row-mbx-1")).toBeTruthy());
    expect(screen.queryByTestId("mailboxes-load-more")).toBeNull();
  });

  it("keeps the active filters on the next page request and restarts from page one when a filter changes", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(String(url));
      const params = new URL(String(url), "http://x").searchParams;
      if (params.get("type") === "shared") return jsonResponse({ items: [mailboxRow("s1")], nextCursor: null });
      if (params.get("cursor") === null) return jsonResponse({ items: [mailboxRow("m1")], nextCursor: "cursor-2" });
      return jsonResponse({ items: [mailboxRow("m2")], nextCursor: "cursor-3" });
    });
    render(<MailboxesView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("mailbox-row-m1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("mailboxes-load-more"));
    await waitFor(() => expect(screen.getByTestId("mailbox-row-m2")).toBeTruthy());

    fireEvent.change(screen.getByTestId("mailboxes-filter-type"), { target: { value: "shared" } });
    await waitFor(() => expect(screen.getByTestId("mailbox-row-s1")).toBeTruthy());

    const last = new URL(urls[urls.length - 1]!, "http://x").searchParams;
    expect(last.get("type")).toBe("shared");
    expect(last.has("cursor")).toBe(false);
    expect(screen.queryByTestId("mailbox-row-m1")).toBeNull();
    expect(screen.queryByTestId("mailbox-row-m2")).toBeNull();
    expect(screen.queryByTestId("mailboxes-load-more")).toBeNull();
  });

  it("keeps the loaded rows and shows the error when a later page fails", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const cursor = new URL(String(url), "http://x").searchParams.get("cursor");
      if (cursor === null) return jsonResponse({ items: [mailboxRow("m1")], nextCursor: "cursor-2" });
      return jsonResponse({ message: "EXO unreachable" }, 502);
    });
    render(<MailboxesView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("mailbox-row-m1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("mailboxes-load-more"));

    await waitFor(() => expect(screen.getByTestId("mailboxes-error").textContent).toContain("EXO unreachable"));
    expect(screen.getByTestId("mailbox-row-m1")).toBeTruthy();
  });
});

describe("RulesView", () => {
  it("flags forwarding rules as security-sensitive", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        rules: [
          { identity: "rule-1", name: "Forward out", enabled: true, priority: 1, forwardTo: "external@example.invalid", forwardAsAttachmentTo: null, redirectTo: null, deleteMessage: false },
          { identity: "rule-2", name: "Archive", enabled: true, priority: 2, forwardTo: null, forwardAsAttachmentTo: null, redirectTo: null, deleteMessage: false },
        ],
      }),
    );
    render(<RulesView tenantId="tenant-1" mailboxId="mbx-1" fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId("rules-table")).toBeTruthy());
    expect(screen.getByTestId("rule-forwarding-flag-rule-1").textContent).toContain("Forwarding");
    expect(screen.queryByTestId("rule-forwarding-flag-rule-2")).toBeNull();
    expect(screen.getByTestId("forwarding-sensitive-legend")).toBeTruthy();
  });
});

describe("VacationView", () => {
  it("lists schedules with End now and ends immediately on confirm", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (init?.method === "DELETE") return jsonResponse({ ended: true });
      // The BFF's list shape: { tenantId, items: [{ ...schedule, status }] }.
      return jsonResponse({
        tenantId: "tenant-1",
        items: [
          { id: "sched-1", tenantId: "tenant-1", mailboxId: "mbx-1", startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-10-01T00:00:00Z", oooMessage: "Away", forwardTo: "cover@example.invalid", state: "active", status: "active" },
          { id: "sched-2", tenantId: "tenant-1", mailboxId: "mbx-2", startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-08T00:00:00Z", oooMessage: "Away", forwardTo: null, state: "scheduled", status: "upcoming" },
        ],
      });
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<VacationView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("vacation-end-sched-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("vacation-end-sched-1"));

    expect(screen.getByTestId("vacation-row-sched-2").textContent).toContain("upcoming");
    await waitFor(() =>
      expect(calls).toContainEqual({ url: "/v1/tenants/tenant-1/vacation-schedules/sched-1", method: "DELETE" }),
    );
  });
});

describe("RetentionView", () => {
  it("previews affected mailboxes before assigning a tag", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).endsWith("/retention/policies")) return jsonResponse({ policies: [] });
      if (String(url).endsWith("/retention/tags")) {
        return jsonResponse({ tags: [{ id: "tag-1", name: "One year", type: "Personal", retentionDays: 365 }] });
      }
      return jsonResponse({ diff: ["Assign tag-1 to mbx-1"], valid: true, dryRun: true, requiresConfirmation: true, affectedMailboxes: ["mbx-1"] });
    });
    render(<RetentionView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("retention-tags-table")).toBeTruthy());
    fireEvent.click(screen.getByTestId("retention-assign"));
    fireEvent.change(screen.getByTestId("retention-assign-tag"), { target: { value: "tag-1" } });
    fireEvent.change(screen.getByTestId("retention-assign-mailboxes"), { target: { value: "mbx-1" } });
    fireEvent.click(screen.getByTestId("retention-assign-preview"));

    await waitFor(() => expect(screen.getByTestId("retention-affected").textContent).toContain("mbx-1"));
  });
});

describe("RetentionView tag read unavailable", () => {
  it("shows an explicit not-available state instead of an empty tag list when the BFF answers 501", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).endsWith("/retention/policies")) return jsonResponse({ policies: [{ id: "p-1", name: "Policy" }] });
      return jsonResponse({ code: "mailboxes.retention_tag_read_unavailable", message: "retention tag list is not available yet: no worker backs the read" }, 501);
    });
    render(<RetentionView tenantId="tenant-1" fetcher={fetcher as unknown as typeof fetch} />);

    await waitFor(() => expect(screen.getByTestId("retention-tags-unavailable").textContent).toContain("not available yet"));
    expect(screen.getByTestId("retention-policy-p-1")).toBeTruthy();
    expect(screen.queryByTestId("retention-error")).toBeNull();
  });
});
