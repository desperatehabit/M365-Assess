/** @vitest-environment jsdom */

// CMMC Level 2 SSP questionnaire: renders the practices with their automated
// evidence, filters them, and saves an answer (evidence split one per line).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SSP_PRACTICES, type SspDocumentView, type SspPracticeView } from "@m365-assess/contracts/ssp";
import { SspQuestionnaire, filterPractices, initialAnswer } from "./SspQuestionnaire";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TENANT = "11111111-1111-1111-1111-111111111111";

function practiceView(id: string, overrides: Partial<SspPracticeView> = {}): SspPracticeView {
  const practice = SSP_PRACTICES.find((entry) => entry.id === id)!;
  return {
    practice,
    automated: { checkIds: [], findings: [], outcome: "none", runId: null },
    response: null,
    effectiveStatus: "not-assessed",
    effectiveResponsibility: practice.defaultResponsibility ?? "customer",
    statusSource: "none",
    ...overrides,
  };
}

function documentView(): SspDocumentView {
  return {
    tenantId: TENANT,
    profile: null,
    generatedAt: "2026-11-04T12:00:00.000Z",
    practices: [
      practiceView("3.1.1", {
        automated: {
          checkIds: ["CA-MFA-ALL-001"],
          findings: [{ checkId: "CA-MFA-ALL-001.1", status: "Pass", controlName: "MFA", currentValue: "Yes" }],
          outcome: "pass",
          runId: "run-1",
        },
        effectiveStatus: "implemented",
        statusSource: "automated",
      }),
      practiceView("3.10.1"),
    ],
    summary: {
      total: 2,
      byStatus: { implemented: 1, "partially-implemented": 0, planned: 0, "not-implemented": 0, "not-applicable": 0, "not-assessed": 1 },
      unanswered: 1,
      level1Implemented: 1,
      level1Total: 2,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("SSP questionnaire helpers", () => {
  const views = documentView().practices;
  it("filters by family and by what still needs an answer", () => {
    expect(filterPractices(views, "PE", "all").map((view) => view.practice.id)).toEqual(["3.10.1"]);
    expect(filterPractices(views, "all", "needs-answer").map((view) => view.practice.id)).toEqual(["3.10.1"]);
    expect(filterPractices(views, "all", "gaps").map((view) => view.practice.id)).toEqual(["3.10.1"]);
  });

  it("starts the form from the automated result and the catalog responsibility", () => {
    expect(initialAnswer(views[0]!)).toMatchObject({ implementationStatus: "implemented", responsibility: "customer" });
    expect(initialAnswer(views[1]!)).toMatchObject({ implementationStatus: "not-implemented", responsibility: "shared" });
  });
});

describe("SspQuestionnaire", () => {
  it("shows the practices and the questionnaire prompt, and saves an answer", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method === "PUT") return jsonResponse({ response: {} });
      return jsonResponse(documentView());
    }) as unknown as typeof fetch;

    render(<SspQuestionnaire tenantId={TENANT} fetcher={fetcher} />);
    await screen.findByText("CMMC Level 2 System Security Plan");
    expect(screen.getByText(/1 need an answer/)).toBeTruthy();
    expect(screen.getByText("Download SSP (Word)").getAttribute("href")).toBe(`/v1/tenants/${TENANT}/ssp/document?format=docx`);

    fireEvent.click(screen.getByText(/Limit physical access to organizational systems/));
    expect(screen.getByText(/How is physical access to offices/)).toBeTruthy();

    const card = screen.getByTestId("practice-3.10.1");
    fireEvent.change(card.querySelector("textarea")!, { target: { value: "Badge readers on every entrance." } });
    fireEvent.change(card.querySelectorAll("textarea")[1]!, { target: { value: "Access policy v3\n\nBadge roster" } });
    fireEvent.click(screen.getByText("Save answer"));

    await waitFor(() => expect(calls.some((call) => call.init?.method === "PUT")).toBe(true));
    const put = calls.find((call) => call.init?.method === "PUT")!;
    expect(put.url).toBe(`/v1/tenants/${TENANT}/ssp/practices/3.10.1`);
    expect(JSON.parse(String(put.init?.body))).toMatchObject({
      implementationStatus: "not-implemented",
      responsibility: "shared",
      narrative: "Badge readers on every entrance.",
      evidence: ["Access policy v3", "Badge roster"],
    });
  });

  it("shows a load error inline", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: { message: "tenant is outside the caller scope" } }, 403)) as unknown as typeof fetch;
    render(<SspQuestionnaire tenantId={TENANT} fetcher={fetcher} />);
    expect((await screen.findByRole("alert")).textContent).toContain("tenant is outside the caller scope");
  });
});
