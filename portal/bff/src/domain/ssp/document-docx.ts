// Renders the SSP blocks as a Word (.docx) document: WordprocessingML parts in a
// ZIP package, built with the in-repo zip writer so the BFF needs no document
// library. Headings use the built-in Heading 1-3 styles, so Word's navigation
// pane and table of contents work, and the client can restyle the document.
import type { SspDocumentView } from "@m365-assess/contracts/ssp";
import { buildSspBlocks, type SspBlock } from "./document-content.js";
import { createZip } from "./zip.js";

export function escapeXml(value: string): string {
  return value
    // XML 1.0 forbids most control characters; drop them rather than emit an invalid part.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function run(text: string, options: { bold?: boolean; color?: string } = {}): string {
  const props = [options.bold ? "<w:b/>" : "", options.color ? `<w:color w:val="${options.color}"/>` : ""].join("");
  const lines = text.split("\n");
  const content = lines
    .map((line, index) => `${index > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join("");
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${content}</w:r>`;
}

function paragraph(text: string, options: { style?: string; bold?: boolean; color?: string; shade?: string } = {}): string {
  const pPr = [
    options.style ? `<w:pStyle w:val="${options.style}"/>` : "",
    options.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.shade}"/>` : "",
  ].join("");
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${run(text, options)}</w:p>`;
}

function cell(text: string, options: { header?: boolean; bold?: boolean; width?: number } = {}): string {
  const tcPr = [
    options.width ? `<w:tcW w:w="${options.width}" w:type="dxa"/>` : "",
    options.header ? `<w:shd w:val="clear" w:color="auto" w:fill="EEF2F6"/>` : "",
  ].join("");
  return `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ""}${paragraph(text, { bold: (options.header ?? false) || (options.bold ?? false) })}</w:tc>`;
}

// Letter page (12240 twips) less 1080-twip margins on each side.
const TEXT_WIDTH = 10080;

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const width = Math.floor(TEXT_WIDTH / Math.max(header.length, 1));
  const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${header.map((text) => cell(text, { header: true, width })).join("")}</w:tr>`;
  const body = rows.map((row) => `<w:tr>${row.map((text) => cell(text, { width })).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblStyle w:val="SspTable"/><w:tblW w:w="${TEXT_WIDTH}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${header
    .map(() => `<w:gridCol w:w="${width}"/>`)
    .join("")}</w:tblGrid>${headerRow}${body}</w:tbl>${paragraph("")}`;
}

function renderBlock(block: SspBlock): string {
  switch (block.kind) {
    case "title":
      return [paragraph(block.text, { style: "Title" }), ...block.subtitle.map((line) => paragraph(line, { style: "Subtitle" }))].join("");
    case "heading":
      return paragraph(block.text, { style: `Heading${block.level}` });
    case "paragraph":
      if (block.tone === "notice") return paragraph(block.text, { shade: "FFF8C5" });
      if (block.tone === "muted") return paragraph(block.text, { color: "57606A" });
      return paragraph(block.text);
    case "fields":
      return `<w:tbl><w:tblPr><w:tblW w:w="${TEXT_WIDTH}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="2600"/><w:gridCol w:w="${TEXT_WIDTH - 2600}"/></w:tblGrid>${block.rows
        .map(([key, value]) => `<w:tr>${cell(key, { width: 2600, bold: true })}${cell(value, { width: TEXT_WIDTH - 2600 })}</w:tr>`)
        .join("")}</w:tbl>${paragraph("")}`;
    case "table":
      return table(block.header, block.rows);
    case "list":
      return block.items.map((item) => paragraph(item, { style: "ListBullet" })).join("");
    case "pageBreak":
      return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  }
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

function heading(id: string, name: string, size: number, level: number): string {
  return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${level}"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4E79"/><w:sz w:val="${size}"/></w:rPr></w:style>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:color w:val="1F4E79"/><w:sz w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="57606A"/><w:sz w:val="24"/></w:rPr></w:style>
${heading("Heading1", "heading 1", 32, 0)}
${heading("Heading2", "heading 2", 26, 1)}
${heading("Heading3", "heading 3", 22, 2)}
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
<w:style w:type="table" w:styleId="SspTable"><w:name w:val="SSP Table"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D0D7DE"/><w:left w:val="single" w:sz="4" w:color="D0D7DE"/><w:bottom w:val="single" w:sz="4" w:color="D0D7DE"/><w:right w:val="single" w:sz="4" w:color="D0D7DE"/><w:insideH w:val="single" w:sz="4" w:color="D0D7DE"/><w:insideV w:val="single" w:sz="4" w:color="D0D7DE"/></w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${NS}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

function coreProperties(view: SspDocumentView): string {
  const title = `System Security Plan${view.profile?.systemName ? ` — ${view.profile.systemName}` : ""}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>M365-Assess</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(view.generatedAt)}</dcterms:created>
</cp:coreProperties>`;
}

export function renderSspDocumentXml(view: SspDocumentView): string {
  const body = buildSspBlocks(view).map(renderBlock).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

export function renderSspDocx(view: SspDocumentView): Buffer {
  return createZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "word/document.xml", data: renderSspDocumentXml(view) },
    { name: "word/_rels/document.xml.rels", data: DOCUMENT_RELS },
    { name: "word/styles.xml", data: STYLES },
    { name: "word/numbering.xml", data: NUMBERING },
    { name: "docProps/core.xml", data: coreProperties(view) },
  ]);
}
