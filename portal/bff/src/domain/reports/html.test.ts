import { describe, expect, it } from "vitest";
import { composeBuilderHtml, composeExecutiveHtml, composeReportHtml } from "./html.js";

const EXECUTIVE_PAYLOAD = {
  tenantId: "t-a",
  runId: "run-1",
  tenantFacts: { displayName: "Contoso", defaultDomain: "contoso.example" },
  compliance: { pass: 12, fail: 3 },
  secureScore: { current: 62, max: 100 },
  actionBuckets: { immediate: 2, compliance: 4 },
};

describe("composeExecutiveHtml (T-0835)", () => {
  it("renders the payload into a self-contained page the render worker accepts", () => {
    const html = composeExecutiveHtml(EXECUTIVE_PAYLOAD);
    expect(html).toContain("window.REPORT_DATA");
    expect(html).toContain('<div id="root"');
    expect(html).not.toMatch(/<script[^>]+src\s*=\s*["']https?:\/\//);
    expect(html).toContain("Contoso");
    expect(html).toContain("Tenant facts");
    expect(html).toContain("Secure score");
    expect(html).toContain("Action buckets");
    expect(html).toContain("pass");
  });

  it("escapes tenant values so facts cannot inject markup", () => {
    const html = composeExecutiveHtml({
      ...EXECUTIVE_PAYLOAD,
      tenantFacts: { displayName: "<img src=x onerror=alert(1)>" },
    });
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
  });

  it("renders empty sections without throwing", () => {
    const html = composeExecutiveHtml({ tenantId: "t-a", runId: null, tenantFacts: {}, compliance: {}, secureScore: {}, actionBuckets: {} });
    expect(html).toContain("None recorded.");
  });
});

describe("composeBuilderHtml (T-0835)", () => {
  const DOCUMENT = {
    schemaVersion: "v1",
    id: "tpl-1",
    name: "Quarterly",
    settings: { title: "Security posture", subtitle: "Q3", redact: false },
    pageSetup: { pageSize: "A4", orientation: "portrait", marginMm: 16, footerText: "Confidential" },
    brandingOverrides: { primaryColor: "#0b5fff" },
    blocks: [
      { id: "b1", type: "rich-text", title: "Note", static: true, settings: { body: "All clear." } },
      { id: "b2", type: "section-divider", title: "Findings", static: true, settings: {} },
      { id: "b3", type: "page-break", title: "", static: true, settings: {} },
      { id: "b4", type: "score-cards", title: "Scores", static: false, dataBinding: { entity: "secure-score" }, settings: { metrics: ["current"] } },
    ],
  };

  it("renders blocks, settings, page setup, and branding into the page", () => {
    const html = composeBuilderHtml(DOCUMENT);
    expect(html).toContain("window.REPORT_DATA");
    expect(html).toContain('<div id="root"');
    expect(html).toContain("Security posture");
    expect(html).toContain("Q3");
    expect(html).toContain("All clear.");
    expect(html).toContain("Findings");
    expect(html).toContain("page-break");
    expect(html).toContain("Data-backed block.");
    expect(html).toContain("#0b5fff");
    expect(html).toContain("@page { size: A4 portrait; margin: 16mm; }");
    expect(html).toContain("Confidential");
  });

  it("escapes block text so builder content cannot inject markup", () => {
    const html = composeBuilderHtml({
      ...DOCUMENT,
      blocks: [{ id: "b1", type: "rich-text", title: "Note", static: true, settings: { body: "<script>alert(1)</script>" } }],
    });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders a minimal page when the document is empty", () => {
    const html = composeBuilderHtml({});
    expect(html).toContain("window.REPORT_DATA");
    expect(html).toContain('<div id="root"');
    expect(html).toContain("Report");
  });
});

describe("composeReportHtml (T-0835)", () => {
  it("composes the executive payload for executive renders", () => {
    const html = composeReportHtml({ type: "executive", executivePayload: EXECUTIVE_PAYLOAD });
    expect(html).toContain("Tenant facts");
  });

  it("composes the builder document for custom and template renders", () => {
    const custom = composeReportHtml({ type: "custom", document: { settings: { title: "Custom" }, blocks: [] } });
    expect(custom).toContain("Custom");
    const template = composeReportHtml({ type: "template", template: { settings: { title: "Template" }, blocks: [] } });
    expect(template).toContain("Template");
  });
});
