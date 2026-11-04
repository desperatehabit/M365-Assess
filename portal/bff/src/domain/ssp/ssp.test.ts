import { inflateRawSync } from "node:zlib";
import { SSP_PRACTICES, type SspPracticeResponse, type SspSystemProfile } from "@m365-assess/contracts/ssp";
import { describe, expect, it } from "vitest";
import { buildSspBlocks } from "./document-content.js";
import { renderSspDocumentXml, renderSspDocx } from "./document-docx.js";
import { renderSspHtml } from "./document-html.js";
import { automatedOutcome, buildSspView } from "./merge.js";
import { buildPracticeCheckMap, loadPracticeCheckMap } from "./practice-map.js";
import { crc32 } from "./zip.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const NOW = "2026-11-04T12:00:00.000Z";

function response(practiceId: string, overrides: Partial<SspPracticeResponse> = {}): SspPracticeResponse {
  return {
    tenantId: TENANT,
    practiceId,
    implementationStatus: "implemented",
    responsibility: "customer",
    narrative: "Recorded by the consultant.",
    evidence: [],
    owner: null,
    plannedCompletion: null,
    updatedBy: "consultant-1",
    updatedAt: NOW,
    ...overrides,
  };
}

const PROFILE: SspSystemProfile = {
  tenantId: TENANT,
  organizationName: "Contoso Defense <LLC>",
  systemName: "Contoso CUI enclave",
  systemOwner: "Pat Lee",
  securityContact: "security@contoso.example",
  description: "Microsoft 365 GCC High tenant & 40 laptops",
  boundary: "Tenant plus managed endpoints",
  environment: "Two offices",
  interconnections: "None",
  cuiCategories: "CTI",
  updatedBy: "consultant-1",
  updatedAt: NOW,
};

describe("practice map", () => {
  it("maps Level 2 ids, drops objective suffixes, resolves FAR ids, and ignores Level 3", () => {
    const map = buildPracticeCheckMap([
      { checkId: "A-001", frameworks: { cmmc: { controlId: "AC.L2-3.1.1;IA.L1-B.1.VI[a]" } } },
      { checkId: "B-001", frameworks: { cmmc: { controlId: "PE.L1-B.1.IX;RA.L3-3.11.5E" } } },
      { checkId: "C-001", frameworks: { "nist-800-53": { controlId: "AC-02" } } },
    ]);
    expect(map.get("3.1.1")).toEqual(["A-001"]);
    expect(map.get("3.5.2")).toEqual(["A-001"]);
    expect(map.get("3.10.3")).toEqual(["B-001"]);
    expect(map.get("3.10.5")).toEqual(["B-001"]);
    expect([...map.keys()].some((key) => key.endsWith("E"))).toBe(false);
  });

  it("maps the shipped registry to most practices, including the new local firewall check", () => {
    const map = loadPracticeCheckMap();
    expect(map.size).toBeGreaterThanOrEqual(80);
    expect(map.get("3.13.6")).toContain("INTUNE-FIREWALL-001");
    for (const practiceId of map.keys()) {
      expect(SSP_PRACTICES.some((practice) => practice.id === practiceId)).toBe(true);
    }
  });
});

describe("automated outcome", () => {
  const finding = (status: string) => ({ checkId: "X-001.1", status, controlName: null, currentValue: null });
  it("classifies mapped findings", () => {
    expect(automatedOutcome([], [])).toBe("none");
    expect(automatedOutcome(["X-001"], [])).toBe("not-assessed");
    expect(automatedOutcome(["X-001"], [finding("Pass"), finding("Info")])).toBe("pass");
    expect(automatedOutcome(["X-001"], [finding("Fail"), finding("Review")])).toBe("fail");
    expect(automatedOutcome(["X-001"], [finding("Fail"), finding("Pass")])).toBe("partial");
    expect(automatedOutcome(["X-001"], [finding("Warning")])).toBe("partial");
    expect(automatedOutcome(["X-001"], [finding("Review"), finding("Skipped")])).toBe("review");
  });
});

describe("SSP view", () => {
  const practiceChecks = new Map<string, readonly string[]>([
    ["3.1.1", ["AC-001"]],
    ["3.5.3", ["MFA-001"]],
  ]);
  const view = buildSspView({
    tenantId: TENANT,
    practiceChecks,
    findings: [
      { checkId: "AC-001.1", status: "Pass", controlName: "Access", currentValue: "ok" },
      { checkId: "MFA-001.1", status: "Fail", controlName: "MFA", currentValue: "off" },
    ],
    runId: "run-1",
    responses: [
      response("3.5.3", { implementationStatus: "planned", plannedCompletion: "2027-02-01", owner: "IT" }),
      response("3.10.1", { responsibility: "shared", evidence: ["Badge list"] }),
    ],
    profile: PROFILE,
    now: () => NOW,
  });
  const byId = (id: string) => view.practices.find((entry) => entry.practice.id === id)!;

  it("covers all 110 practices", () => {
    expect(view.practices).toHaveLength(110);
    expect(view.summary.total).toBe(110);
    expect(view.summary.level1Total).toBe(17);
  });

  it("uses the automated outcome when nothing is recorded", () => {
    expect(byId("3.1.1")).toMatchObject({ effectiveStatus: "implemented", statusSource: "automated" });
    expect(byId("3.1.1").automated.findings).toHaveLength(1);
  });

  it("lets a recorded answer override a failing automated result", () => {
    expect(byId("3.5.3")).toMatchObject({ effectiveStatus: "planned", statusSource: "response" });
    expect(byId("3.5.3").automated.outcome).toBe("fail");
  });

  it("defaults responsibility from the catalog and marks unanswered practices", () => {
    expect(byId("3.5.11")).toMatchObject({ effectiveResponsibility: "inherited", effectiveStatus: "not-assessed", statusSource: "none" });
    expect(byId("3.10.1").effectiveResponsibility).toBe("shared");
    expect(view.summary.unanswered).toBe(110 - 3);
  });

  it("lists not-implemented, planned, and unanswered practices in the POA&M", () => {
    const blocks = buildSspBlocks(view);
    const poam = blocks.find((block) => block.kind === "table" && block.header[0] === "Practice");
    expect(poam && poam.kind === "table" ? poam.rows.map((row) => row[0]) : []).toContain("IA.L2-3.5.3");
    const planned = poam && poam.kind === "table" ? poam.rows.find((row) => row[0] === "IA.L2-3.5.3") : undefined;
    expect(planned).toEqual(["IA.L2-3.5.3", "Planned", "IT", "2027-02-01", "Recorded by the consultant."]);
  });

  it("renders escaped, self-contained HTML", () => {
    const html = renderSspHtml(view);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Contoso Defense &lt;LLC&gt;");
    expect(html).toContain("AC.L2-3.1.1");
    expect(html).not.toMatch(/<script|https?:\/\/(?!schemas)/);
  });

  it("renders a valid .docx package with well-formed, escaped XML", () => {
    const docx = renderSspDocx(view);
    const entries = readZip(docx);
    expect(Object.keys(entries)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/_rels/document.xml.rels",
      "word/styles.xml",
      "word/numbering.xml",
      "docProps/core.xml",
    ]);
    const documentXml = entries["word/document.xml"]!;
    expect(documentXml).toBe(renderSspDocumentXml(view));
    expect(documentXml).toContain("Contoso Defense &lt;LLC&gt;");
    expect(documentXml).toContain('w:val="Heading3"');
    expect(documentXml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#)/);
  });
});

/** Reads a ZIP built by createZip, checking each entry's CRC. */
function readZip(buffer: Buffer): Record<string, string> {
  const entries: Record<string, string> = {};
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const crc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    const data = inflateRawSync(buffer.subarray(start, start + compressedSize));
    expect(crc32(data)).toBe(crc);
    entries[name] = data.toString("utf8");
    offset = start + compressedSize;
  }
  expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
  return entries;
}
