/** @vitest-environment jsdom */

// T-0882 — MFA report row actions are wired to the dialogs and the typed client.
// Asserts a full reset round trip from a report row: open the dialog, supply the
// reason and confirmation, and observe the BFF call.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as mfaApi from "../../lib/mfaApi";
import type { MfaUserRow } from "../../lib/mfaApi";

vi.mock("../../lib/useCurrentTenant", () => ({
  useCurrentTenantId: () => "tenant-a",
}));

import MfaReportPage from "../../app/mfa-report/page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ROW: MfaUserRow = {
  userId: "user-1",
  displayName: "Alice Admin",
  userPrincipalName: "alice@example.invalid",
  methods: ["fido2", "microsoftAuthenticator"],
  defaultMethod: "fido2",
  phishingResistant: "phishing-resistant",
  lastAuthDateTime: null,
  state: "registered",
  licenses: [],
  isAdmin: true,
};

function report(): mfaApi.MfaReport {
  return {
    tenantId: "tenant-a",
    rows: [ROW],
    kpis: { total: 1, registered: 1, notRegistered: 0, phishingResistant: 1, perMethod: { fido2: 1 } },
    nextCursor: null,
    retrievedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("MfaReportPage actions (T-0882)", () => {
  it("performs a reset round trip from a report row", async () => {
    vi.spyOn(mfaApi, "fetchMfaReport").mockResolvedValue(report());
    const resetSpy = vi.spyOn(mfaApi, "resetUserMfa").mockResolvedValue({
      userId: "user-1",
      status: "applied",
      methods: [],
      state: "notRegistered",
      error: null,
    });

    render(<MfaReportPage />);

    fireEvent.click(await screen.findByTestId("action-reset-user-1"));
    expect(screen.getByTestId("reset-mfa-dialog")).toBeTruthy();

    fireEvent.change(screen.getByTestId("reset-reason-input"), { target: { value: "User lost device" } });
    fireEvent.click(screen.getByTestId("reset-confirm-checkbox"));

    const submit = screen.getByTestId("reset-submit-button") as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() =>
      expect(resetSpy).toHaveBeenCalledWith(
        "tenant-a",
        "user-1",
        expect.objectContaining({ reason: "User lost device" }),
      ),
    );
    expect(await screen.findByTestId("mfa-status")).toBeTruthy();
  });

  it("opens the TAP and push dialogs for their row actions", async () => {
    vi.spyOn(mfaApi, "fetchMfaReport").mockResolvedValue(report());
    render(<MfaReportPage />);

    fireEvent.click(await screen.findByTestId("action-tap-user-1"));
    expect(screen.getByTestId("tap-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tap-cancel-button"));

    fireEvent.click(screen.getByTestId("action-push-user-1"));
    expect(screen.getByTestId("push-dialog")).toBeTruthy();
  });
});
