import { describe, expect, it } from "vitest";
import {
  BLOCK_TYPES,
  REPORT_SCHEMA_VERSION,
  ReportValidationError,
  isBindableEntity,
  isBlockType,
  parseReportBlock,
  parseReportTemplate,
  serializeReportTemplate,
  type ReportTemplate,
} from "./reports.js";

const template: ReportTemplate = {
  schemaVersion: REPORT_SCHEMA_VERSION,
  id: "tpl-0001",
  name: "Quarterly executive summary",
  settings: {
    title: "Security posture",
    subtitle: "Quarterly review",
    redact: false,
  },
  pageSetup: {
    pageSize: "A4",
    orientation: "portrait",
    marginMm: 16,
    footerText: "Confidential",
  },
  brandingOverrides: {
    primaryColor: "#0b5fff",
    logoRef: "branding/logo.svg",
    showPageNumbers: true,
  },
  blocks: [
    {
      id: "block-1",
      type: "chart",
      title: "Findings over time",
      static: false,
      dataBinding: { entity: "findings" },
      settings: { chartKind: "line", series: ["pass", "fail"] },
    },
    {
      id: "block-2",
      type: "score-cards",
      title: "Posture at a glance",
      static: false,
      dataBinding: { entity: "secure-score" },
      settings: { metrics: ["current", "max"], columns: 2 },
    },
    {
      id: "block-3",
      type: "progress-bars",
      title: "Compliance coverage",
      static: false,
      dataBinding: { entity: "compliance" },
      settings: { metrics: ["aligned", "current"], showPercentages: true },
    },
    {
      id: "block-4",
      type: "section-divider",
      title: "Appendix",
      static: true,
      settings: { eyebrow: "Reference" },
    },
    {
      id: "block-5",
      type: "page-break",
      title: "Licenses",
      static: true,
      settings: {},
    },
    {
      id: "block-6",
      type: "rich-text",
      title: "Analyst note",
      static: true,
      settings: { body: "No critical exposure observed this quarter." },
    },
    {
      id: "block-7",
      type: "findings-table",
      title: "Failed controls",
      static: false,
      dataBinding: { entity: "findings" },
      settings: { statuses: ["fail", "warning"], severities: ["critical", "high"], limit: 25 },
    },
    {
      id: "block-8",
      type: "framework-coverage",
      title: "Framework coverage",
      static: false,
      dataBinding: { entity: "compliance" },
      settings: { frameworks: ["CIS", "NIST"], showGaps: true },
    },
    {
      id: "block-9",
      type: "secure-score-trend",
      title: "Secure score trend",
      static: false,
      dataBinding: { entity: "secure-score" },
      settings: { points: 6, includeTarget: true },
    },
    {
      id: "block-10",
      type: "top-risks",
      title: "Top risks",
      static: false,
      dataBinding: { entity: "findings" },
      settings: { limit: 5, minSeverity: "high" },
    },
    {
      id: "block-11",
      type: "remediation-progress",
      title: "Remediation progress",
      static: false,
      dataBinding: { entity: "findings" },
      settings: { groupBy: "status", showPercentages: true },
    },
    {
      id: "block-12",
      type: "tenant-summary",
      title: "Tenant summary",
      static: false,
      dataBinding: { entity: "run-summary" },
      settings: { fields: ["displayName", "defaultDomain", "status"] },
    },
    {
      id: "block-13",
      type: "run-comparison",
      title: "Run comparison",
      static: false,
      dataBinding: { entity: "run-summary" },
      settings: { mode: "drift", showUnchanged: false },
    },
  ],
};

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

function expectValidationError(fn: () => unknown, code: string): ReportValidationError {
  const error = capture(fn);
  expect(error).toBeInstanceOf(ReportValidationError);
  const validationError = error as ReportValidationError;
  expect(validationError.code).toBe(code);
  return validationError;
}

describe("report template round-trip", () => {
  it("round-trips a template carrying every v1 block type", () => {
    const parsed = parseReportTemplate(serializeReportTemplate(template));
    expect(parsed).toEqual(template);
    expect(parsed.blocks.map((block) => block.type)).toEqual([...BLOCK_TYPES]);
  });

  it("still parses templates stored before the data-bound blocks existed", () => {
    const legacy = {
      ...template,
      blocks: template.blocks.slice(0, 6),
    };
    expect(parseReportTemplate(legacy)).toEqual(legacy);
  });

  it("accepts an already-parsed object", () => {
    expect(parseReportTemplate(template)).toEqual(template);
  });

  it("round-trips a single block", () => {
    const block = template.blocks[3];
    expect(parseReportBlock(block)).toEqual(block);
  });
});

describe("report template schema version", () => {
  it("rejects an unknown schemaVersion", () => {
    const error = expectValidationError(
      () => parseReportTemplate({ ...template, schemaVersion: "v99" }),
      "report.unsupported_schema_version",
    );
    expect(error.path).toBe("template.schemaVersion");
  });

  it("rejects a payload that is not valid JSON", () => {
    expectValidationError(() => parseReportTemplate("{ not json"), "report.invalid_json");
  });

  it("rejects a missing required template field", () => {
    const incomplete = { ...template, name: undefined };
    const error = expectValidationError(
      () => parseReportTemplate(incomplete),
      "report.invalid",
    );
    expect(error.path).toBe("template.name");
  });
});

describe("report blocks", () => {
  it("rejects an unknown block type", () => {
    const unknown = {
      ...template,
      blocks: [{ ...template.blocks[5], type: "iframe" }],
    };
    const error = expectValidationError(
      () => parseReportTemplate(unknown),
      "report.unknown_block_type",
    );
    expect(error.path).toBe("template.blocks[0].type");
  });

  it("rejects a missing required field per block type", () => {
    const cases: Array<{ type: string; settings: Record<string, unknown>; path: string }> = [
      {
        type: "chart",
        settings: { series: ["pass"] },
        path: "template.blocks[0].settings.chartKind",
      },
      {
        type: "score-cards",
        settings: {},
        path: "template.blocks[0].settings.metrics",
      },
      {
        type: "progress-bars",
        settings: { metrics: [] },
        path: "template.blocks[0].settings.metrics",
      },
      {
        type: "rich-text",
        settings: {},
        path: "template.blocks[0].settings.body",
      },
      {
        type: "findings-table",
        settings: { statuses: ["failed"] },
        path: "template.blocks[0].settings.statuses",
      },
      {
        type: "top-risks",
        settings: { limit: 0 },
        path: "template.blocks[0].settings.limit",
      },
      {
        type: "remediation-progress",
        settings: { groupBy: "owner" },
        path: "template.blocks[0].settings.groupBy",
      },
      {
        type: "run-comparison",
        settings: { mode: "diff" },
        path: "template.blocks[0].settings.mode",
      },
    ];
    for (const testCase of cases) {
      const invalidTemplate = {
        ...template,
        blocks: [
          {
            id: "block-1",
            type: testCase.type,
            title: "Broken",
            static: true,
            settings: testCase.settings,
          },
        ],
      };
      const error = expectValidationError(
        () => parseReportTemplate(invalidTemplate),
        "report.invalid_settings",
      );
      expect(error.path).toBe(testCase.path);
    }
  });

  it("requires a dataBinding for a live block", () => {
    const live = {
      ...template,
      blocks: [
        { id: "block-1", type: "chart", title: "Live", static: false, settings: { chartKind: "bar" } },
      ],
    };
    const error = expectValidationError(
      () => parseReportTemplate(live),
      "report.missing_binding",
    );
    expect(error.path).toBe("template.blocks[0].dataBinding");
  });

  it("requires a dataBinding for every new live block type", () => {
    for (const type of [
      "findings-table",
      "framework-coverage",
      "secure-score-trend",
      "top-risks",
      "remediation-progress",
      "tenant-summary",
      "run-comparison",
    ] as const) {
      const live = {
        ...template,
        blocks: [{ id: "block-1", type, title: "Live", static: false, settings: {} }],
      };
      const error = expectValidationError(
        () => parseReportTemplate(live),
        "report.missing_binding",
      );
      expect(error.path).toBe("template.blocks[0].dataBinding");
    }
  });

  it("accepts the documented filters on data-bound blocks", () => {
    const filtered = {
      ...template,
      blocks: [
        {
          id: "block-1",
          type: "findings-table",
          title: "Filtered",
          static: false,
          dataBinding: { entity: "findings" },
          settings: { statuses: ["fail"], severities: ["critical", "high"], sections: ["Identity"], limit: 10 },
        },
      ],
    };
    expect(parseReportTemplate(filtered)).toEqual(filtered);
  });

  it("rejects an unknown dataBinding entity", () => {
    const bound = {
      ...template,
      blocks: [
        {
          id: "block-1",
          type: "chart",
          title: "Live",
          static: false,
          dataBinding: { entity: "billing" },
          settings: { chartKind: "bar" },
        },
      ],
    };
    const error = expectValidationError(
      () => parseReportTemplate(bound),
      "report.unknown_binding",
    );
    expect(error.path).toBe("template.blocks[0].dataBinding.entity");
  });

  it("allows a static block with no dataBinding", () => {
    expect(parseReportBlock(template.blocks[3])).toEqual(template.blocks[3]);
  });

  it("rejects a block missing its settings object", () => {
    const error = expectValidationError(
      () =>
        parseReportBlock({
          id: "block-1",
          type: "page-break",
          title: "Break",
          static: true,
        }),
      "report.invalid",
    );
    expect(error.path).toBe("block.settings");
  });
});

describe("block type guards", () => {
  it("recognises every v1 block type and bindable entity", () => {
    for (const type of BLOCK_TYPES) {
      expect(isBlockType(type)).toBe(true);
    }
    expect(isBlockType("iframe")).toBe(false);
    expect(isBindableEntity("findings")).toBe(true);
    expect(isBindableEntity("billing")).toBe(false);
  });
});
