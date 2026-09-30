/** @vitest-environment jsdom */
// T-0508 — VoiceNumbers against the T-0508 API: license gate renders the
// requirement message and disables writes when unlicensed, the inventory
// renders when licensed, assign/policy run preview → apply, and release
// requires confirmation.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VoiceNumbers, type VoiceLicenseState, type VoiceNumber } from "./VoiceNumbers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LICENSED: VoiceLicenseState = { licensed: true, missingPlans: [], activePlans: ["MCOEV"] };
const UNLICENSED: VoiceLicenseState = { licensed: false, missingPlans: ["MCOEV"], activePlans: [] };

const NUMBERS: VoiceNumber[] = [
  { id: "num-1", number: "+15550100", type: "DirectRouting", assignedTo: "user-1", state: "Assigned" },
  { id: "num-2", number: "+15550101", type: "DirectRouting", assignedTo: "", state: "Unassigned" },
];

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function voiceFetcher(license: VoiceLicenseState, calls: RecordedCall[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), method, body });
    if (method === "GET") {
      return jsonResponse({ tenantId: "tenant-a", license, numbers: license.licensed ? NUMBERS : [] });
    }
    if (method === "POST" && String(url).includes("/policy")) {
      if (body["preview"] === true) {
        return jsonResponse({ action: "policy", diff: ["Assign voice routing policy 'policy-1' to 'user-1'"], valid: true, dryRun: true, requiresConfirmation: false });
      }
      return jsonResponse({ success: true, plan: { action: "policy", diff: [], valid: true, dryRun: false, requiresConfirmation: false } });
    }
    if (method === "POST") {
      if (body["preview"] === true) {
        return jsonResponse({ action: "assign", diff: ["Assign phone number '+15550100' to 'user-2'"], valid: true, dryRun: true, requiresConfirmation: false });
      }
      return jsonResponse({ success: true, plan: { action: "assign", diff: [], valid: true, dryRun: false, requiresConfirmation: false } });
    }
    if (method === "DELETE") {
      return jsonResponse({ success: true, plan: { action: "release", diff: [], valid: true, dryRun: false, requiresConfirmation: true } });
    }
    return jsonResponse({ message: "unexpected call" }, 400);
  }) as unknown as typeof fetch;
}

function textOf(testId: string): string {
  return screen.getByTestId(testId).textContent ?? "";
}

function renderVoice(license: VoiceLicenseState, canWrite = true): RecordedCall[] {
  const calls: RecordedCall[] = [];
  render(<VoiceNumbers tenantId="tenant-a" canWrite={canWrite} fetcher={voiceFetcher(license, calls)} />);
  return calls;
}

describe("VoiceNumbers license gate (T-0508)", () => {
  it("renders the requirement message and disables writes when voice is not licensed", async () => {
    renderVoice(UNLICENSED);
    await waitFor(() => expect(screen.getByTestId("voice-license-gate")).toBeTruthy());
    expect(textOf("voice-license-gate")).toContain("not licensed");
    expect(textOf("voice-license-gate")).toContain("MCOEV");
    expect((screen.getByTestId("voice-assign") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("voice-policy") as HTMLButtonElement).disabled).toBe(true);
    expect(textOf("voice-numbers-table")).toContain("Voice is not licensed.");
  });

  it("renders the inventory when licensed", async () => {
    renderVoice(LICENSED);
    await waitFor(() => expect(screen.getByTestId("voice-numbers-table")).toBeTruthy());
    expect(screen.queryByTestId("voice-license-gate")).toBeNull();
    expect(textOf("voice-number-num-1")).toContain("+15550100");
    expect(textOf("voice-number-num-1")).toContain("user-1");
    expect((screen.getByTestId("voice-assign") as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables writes when the caller lacks permission", async () => {
    renderVoice(LICENSED, false);
    await waitFor(() => expect((screen.getByTestId("voice-assign") as HTMLButtonElement).disabled).toBe(true));
  });
});

describe("VoiceNumbers assign flow (T-0508)", () => {
  it("assign runs preview then apply", async () => {
    const calls = renderVoice(LICENSED);
    await waitFor(() => expect((screen.getByTestId("voice-assign") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("voice-assign"));
    fireEvent.change(screen.getByTestId("voice-assign-number"), { target: { value: "+15550100" } });
    fireEvent.change(screen.getByTestId("voice-assign-target"), { target: { value: "user-2" } });
    fireEvent.click(screen.getByTestId("voice-assign-preview"));
    await waitFor(() => expect(textOf("voice-assign-plan")).toContain("Assign phone number"));
    fireEvent.click(screen.getByTestId("voice-assign-confirm"));
    await waitFor(() => expect(textOf("voice-notice")).toContain("assigned"));
    const preview = calls.find((c) => c.method === "POST" && c.body["preview"] === true);
    const apply = calls.find((c) => c.method === "POST" && c.body["preview"] === false);
    expect(preview?.body).toMatchObject({ phoneNumber: "+15550100", targetId: "user-2" });
    expect(apply?.body).toMatchObject({ phoneNumber: "+15550100", targetId: "user-2" });
  });
});

describe("VoiceNumbers release confirmation (T-0508)", () => {
  it("release requires confirmation before calling the API", async () => {
    const calls = renderVoice(LICENSED);
    await waitFor(() => expect((screen.getByTestId("voice-release-num-1") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("voice-release-num-1"));
    expect(textOf("voice-release-dialog")).toContain("+15550100");
    fireEvent.click(screen.getByTestId("voice-release-confirm"));
    await waitFor(() => expect(textOf("voice-notice")).toContain("released"));
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/teams/voice/numbers/num-1");
    expect(del?.url).toContain("confirm=true");
  });
});

describe("VoiceNumbers policy flow (T-0508)", () => {
  it("policy assignment runs preview then apply", async () => {
    const calls = renderVoice(LICENSED);
    await waitFor(() => expect((screen.getByTestId("voice-policy") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("voice-policy"));
    fireEvent.change(screen.getByTestId("voice-policy-id"), { target: { value: "policy-1" } });
    fireEvent.change(screen.getByTestId("voice-policy-target"), { target: { value: "user-1" } });
    fireEvent.click(screen.getByTestId("voice-policy-preview"));
    await waitFor(() => expect(textOf("voice-policy-plan")).toContain("Assign voice routing policy"));
    fireEvent.click(screen.getByTestId("voice-policy-confirm"));
    await waitFor(() => expect(textOf("voice-notice")).toContain("policy"));
    const preview = calls.find((c) => c.method === "POST" && String(c.url).includes("/policy") && c.body["preview"] === true);
    const apply = calls.find((c) => c.method === "POST" && String(c.url).includes("/policy") && c.body["preview"] === false);
    expect(preview?.body).toMatchObject({ policyId: "policy-1", targetId: "user-1" });
    expect(apply?.body).toMatchObject({ policyId: "policy-1", targetId: "user-1" });
  });
});
