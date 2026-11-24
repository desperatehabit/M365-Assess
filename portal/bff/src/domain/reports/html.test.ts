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

const RUN_DATA = {
  tenant: { tenantId: "t-a", displayName: "Contoso", defaultDomain: "contoso.example" },
  run: {
    id: "run-2",
    status: "succeeded",
    startedAt: "2026-02-01T00:00:00.000Z",
    finishedAt: "2026-02-01T00:05:00.000Z",
    summaryCounts: { pass: 10, fail: 4, warning: 2 },
  },
  baselineRun: {
    id: "run-1",
    summaryCounts: { pass: 8, fail: 5, warning: 3 },
  },
  findings: [
    {
      status: "Fail",
      severity: "Critical",
      category: "Identity",
      controlName: "<b>Require MFA</b>",
      recommendedValue: "Enforce",
    },
    {
      status: "Fail",
      severity: "High",
      category: "Exchange",
      controlName: "Enable DKIM",
    },
    {
      status: "Pass",
      severity: "Low",
      category: "Identity",
      controlName: "Audit logging",
    },
    {
      status: "Warning",
      severity: "Medium",
      category: "SharePoint",
      controlName: "External sharing",
    },
  ],
  secureScore: {
    history: [
      { at: "2026-01", current: 40, max: 100 },
      { at: "2026-02", current: 55, max: 100 },
    ],
  },
  frameworks: [
    { framework: "CIS", pass: 8, fail: 2, total: 10 },
    { framework: "NIST", pass: 6, fail: 4, total: 10 },
  ],
};

function dataBoundDocument(
  type: string,
  settings: Record<string, unknown>,
  entity = "findings",
): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    id: "tpl-data",
    name: "Data bound",
    settings: { title: "Data bound", redact: false },
    pageSetup: { pageSize: "A4", orientation: "portrait", marginMm: 16 },
    blocks: [
      {
        id: "block-1",
        type,
        title: "Block",
        static: false,
        dataBinding: { entity },
        settings,
      },
    ],
  };
}

describe("composeBuilderHtml data-bound blocks (T-0923)", () => {
  it("renders a findings table filtered by status, severity and section", () => {
    const html = composeBuilderHtml(
      dataBoundDocument("findings-table", {
        statuses: ["fail"],
        severities: ["critical"],
        sections: ["Identity"],
        limit: 10,
      }),
      RUN_DATA,
    );
    expect(html).toContain("Require MFA");
    expect(html).toContain("Identity");
    expect(html).not.toContain("Enable DKIM");
    expect(html).not.toContain("Audit logging");
    expect(html).toContain("&lt;b&gt;Require MFA&lt;/b&gt;");
  });

  it("derives framework coverage from finding frameworkRefs when no rollup is supplied", () => {
    const data = {
      ...RUN_DATA,
      frameworks: undefined,
      findings: RUN_DATA.findings.map((finding, index) => ({
        ...finding,
        frameworkRefs:
          index === 0 ? ["CIS 1.1.3", "E8 ML2"] : index === 2 ? ["CIS 2.1.2"] : [],
      })),
    };
    const html = composeBuilderHtml(
      dataBoundDocument("framework-coverage", { frameworks: ["CIS"] }, "compliance"),
      data,
    );
    expect(html).toContain(">CIS<");
    expect(html).toContain("50%");
    expect(html).not.toContain(">E8<");
  });

  it("renders framework coverage, secure score history and top risks", () => {
    const frameworks = composeBuilderHtml(
      dataBoundDocument("framework-coverage", { frameworks: ["CIS"] }, "compliance"),
      RUN_DATA,
    );
    expect(frameworks).toContain("CIS");
    expect(frameworks).toContain("80%");
    expect(frameworks).not.toContain("NIST");

    const trend = composeBuilderHtml(
      dataBoundDocument("secure-score-trend", { points: 1 }, "secure-score"),
      RUN_DATA,
    );
    expect(trend).toContain("2026-02");
    expect(trend).toContain("55%");
    expect(trend).not.toContain("2026-01");

    const risks = composeBuilderHtml(
      dataBoundDocument("top-risks", { limit: 1, minSeverity: "high" }),
      RUN_DATA,
    );
    expect(risks).toContain("Require MFA");
    expect(risks).not.toContain("Enable DKIM");
  });

  it("renders remediation progress, tenant summary and run comparison", () => {
    const progress = composeBuilderHtml(
      dataBoundDocument("remediation-progress", {
        groupBy: "severity",
        showPercentages: true,
      }),
      RUN_DATA,
    );
    expect(progress).toContain("Critical");
    expect(progress).toContain("25%");

    const tenant = composeBuilderHtml(
      dataBoundDocument(
        "tenant-summary",
        { fields: ["Tenant", "Status"] },
        "run-summary",
      ),
      RUN_DATA,
    );
    expect(tenant).toContain("Contoso");
    expect(tenant).toContain("succeeded");
    expect(tenant).not.toContain("Default domain");

    const comparison = composeBuilderHtml(
      dataBoundDocument(
        "run-comparison",
        { mode: "drift", showUnchanged: false },
        "run-summary",
      ),
      RUN_DATA,
    );
    expect(comparison).toContain("pass");
    expect(comparison).toContain("+2");
    expect(comparison).toContain("-1");
    expect(comparison).toContain("delta-up");
    expect(comparison).toContain("delta-down");
  });

  it("renders a placeholder for every new block when no run data is supplied", () => {
    for (const [type, entity] of [
      ["findings-table", "findings"],
      ["framework-coverage", "compliance"],
      ["secure-score-trend", "secure-score"],
      ["top-risks", "findings"],
      ["remediation-progress", "findings"],
      ["tenant-summary", "run-summary"],
      ["run-comparison", "run-summary"],
    ] as const) {
      const html = composeBuilderHtml(dataBoundDocument(type, {}, entity));
      expect(html).toContain("muted");
      expect(html).not.toContain("undefined");
    }
  });

  it("accepts run data embedded in the document or passed by composeReportHtml", () => {
    const document = {
      ...dataBoundDocument("tenant-summary", { fields: ["Tenant"] }, "run-summary"),
      data: RUN_DATA,
    };
    expect(composeBuilderHtml(document)).toContain("Contoso");

    const fromPayload = composeReportHtml({
      type: "custom",
      document: dataBoundDocument("tenant-summary", { fields: ["Tenant"] }, "run-summary"),
      runData: RUN_DATA,
    });
    expect(fromPayload).toContain("Contoso");
  });

  it("uses a captured snapshot stored on a static block", () => {
    const document = {
      ...dataBoundDocument("tenant-summary", { data: RUN_DATA }, "run-summary"),
      blocks: [
        {
          id: "block-1",
          type: "tenant-summary",
          title: "Captured",
          static: true,
          settings: { data: RUN_DATA },
        },
      ],
    };
    expect(composeBuilderHtml(document)).toContain("Contoso");
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
