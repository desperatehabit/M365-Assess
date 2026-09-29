import { describe, expect, it } from "vitest";
import { defaultBrandingConfig, type BrandingConfig } from "./schema.js";
import { buildBrandingPreview } from "./preview.js";

function config(extra: Partial<BrandingConfig> = {}): BrandingConfig {
  return { ...defaultBrandingConfig(), ...extra };
}

const NO_ASSETS = { logoUrl: null, coverUrl: null };

describe("buildBrandingPreview", () => {
  it("maps the draft colours onto the report design tokens", () => {
    const preview = buildBrandingPreview(
      config({ colors: { primary: "#1B4F72", secondary: "#2E86C1" } }),
      NO_ASSETS,
    );
    expect(preview.cssOverrides).toContain('<style id="m365-branding-css">');
    expect(preview.cssOverrides).toContain("--accent: #1B4F72;");
    expect(preview.cssOverrides).toContain("--accent-soft: #1B4F7222;");
    expect(preview.cssOverrides).toContain("--surface: #ffffff;");
    expect(preview.cssOverrides).toContain("--text: #1a1a1a;");
    expect(preview.cssOverrides).toContain("--muted: #6b7280;");
    expect(preview.cssOverrides).toContain("--secondary: #2E86C1;");
  });

  it("renders the cover fragment with the resolved logo and watermark", () => {
    const preview = buildBrandingPreview(
      config({
        logoRef: "branding/logo-1.png",
        watermark: { enabled: true, text: "Confidential" },
      }),
      { logoUrl: "/v1/branding/assets/logo-1.png", coverUrl: null },
    );
    expect(preview.coverFragment).toBe(
      '<div class="m365-branding-cover" aria-hidden="true">' +
        '<img src="/v1/branding/assets/logo-1.png" alt="Company logo" class="m365-branding-logo" />' +
        '<div class="m365-branding-watermark" aria-hidden="true">Confidential</div>' +
        "</div>",
    );
  });

  it("omits the cover fragment when the draft has no logo and no watermark", () => {
    const preview = buildBrandingPreview(config(), NO_ASSETS);
    expect(preview.coverFragment).toBe("");
  });

  it("omits the watermark when it is disabled", () => {
    const preview = buildBrandingPreview(
      config({ watermark: { enabled: false, text: "Confidential" } }),
      { logoUrl: "/v1/branding/assets/logo-1.png", coverUrl: null },
    );
    expect(preview.coverFragment).not.toContain("m365-branding-watermark");
    expect(preview.coverFragment).toContain("m365-branding-logo");
  });

  it("renders the footer fragment with footer text and page numbers", () => {
    const preview = buildBrandingPreview(
      config({ footer: { show: true, text: "Contoso Consulting", coverText: "" } }),
      NO_ASSETS,
    );
    expect(preview.footerFragment).toContain('<style id="m365-branding-footer">');
    expect(preview.footerFragment).toContain('content: "Contoso Consulting";');
    expect(preview.footerFragment).toContain('content: counter(page) "/" counter(pages);');
  });

  it("hides the footer text and page numbers when they are switched off", () => {
    const preview = buildBrandingPreview(
      config({
        footer: { show: false, text: "Contoso Consulting", coverText: "" },
        pageNumbers: { show: false },
      }),
      NO_ASSETS,
    );
    expect(preview.footerFragment).toContain('content: "";');
    expect(preview.footerFragment).not.toContain("Contoso Consulting");
    expect(preview.footerFragment).not.toContain("counter(page)");
  });

  it("applies per-report defaults for the requested report kind", () => {
    const draft = config({
      colors: { primary: "#1B4F72", secondary: "#2E86C1" },
      watermark: { enabled: false, text: "" },
      footer: { show: true, text: "Base footer", coverText: "" },
      pageNumbers: { show: true },
      perReportDefaults: {
        executive: {
          primary: "#000000",
          watermarkText: "Executive draft",
          footerText: "Executive footer",
          showPageNumbers: false,
        },
      },
    });
    const preview = buildBrandingPreview(draft, NO_ASSETS, "executive");
    expect(preview.cssOverrides).toContain("--accent: #000000;");
    expect(preview.coverFragment).toContain("Executive draft");
    expect(preview.footerFragment).toContain('content: "Executive footer";');
    expect(preview.footerFragment).not.toContain("counter(page)");
  });

  it("ignores per-report defaults for an unknown report kind", () => {
    const draft = config({
      perReportDefaults: { executive: { primary: "#000000" } },
    });
    const preview = buildBrandingPreview(draft, NO_ASSETS, "monthly");
    expect(preview.cssOverrides).toContain("--accent: #1B4F72;");
  });

  it("escapes tenant-supplied text in the HTML and CSS fragments", () => {
    const preview = buildBrandingPreview(
      config({
        watermark: { enabled: true, text: '<script>alert("x")</script>' },
        footer: { show: true, text: 'A & B "quoted"', coverText: "" },
      }),
      { logoUrl: '/v1/branding/assets/logo-1.png?a="1"&b=2', coverUrl: null },
    );
    expect(preview.coverFragment).not.toContain("<script>");
    expect(preview.coverFragment).toContain("&lt;script&gt;");
    expect(preview.coverFragment).toContain('/v1/branding/assets/logo-1.png?a=&quot;1&quot;&amp;b=2');
    expect(preview.footerFragment).toContain('content: "A & B \\"quoted\\"";');
    expect(preview.footerFragment).not.toContain('content: "A & B "quoted""');
  });
});
