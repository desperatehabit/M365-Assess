import { describe, expect, it } from "vitest";
import {
  BRANDING_SCHEMA_VERSION,
  BrandingValidationError,
  defaultBrandingConfig,
  parseBrandingConfig,
  serializeBrandingConfig,
} from "./schema.js";

function expectBrandingError(fn: () => unknown, field: string): BrandingValidationError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BrandingValidationError);
  const brandingError = thrown as BrandingValidationError;
  expect(brandingError.code).toBe("branding.invalid");
  expect(brandingError.field).toBe(field);
  return brandingError;
}

function validInput(): Record<string, unknown> {
  return {
    schemaVersion: BRANDING_SCHEMA_VERSION,
    colors: { primary: "#1B4F72", secondary: "#2E86C1" },
    logoRef: "branding/logo.png",
    coverRef: "branding/cover.jpg",
    watermark: { enabled: true, text: "Contoso" },
    footer: { show: true, text: "Contoso Consulting", coverText: "Cover footer" },
    pageNumbers: { show: true },
    presets: [{ id: "default", name: "Default", colors: { primary: "#111111", secondary: "#222222" } }],
    perReportDefaults: {
      executive: { primary: "#000000", showPageNumbers: false },
    },
  };
}

describe("branding schema", () => {
  it("parses a complete §3.2 config", () => {
    const config = parseBrandingConfig(validInput());
    expect(config.colors).toEqual({ primary: "#1B4F72", secondary: "#2E86C1" });
    expect(config.logoRef).toBe("branding/logo.png");
    expect(config.coverRef).toBe("branding/cover.jpg");
    expect(config.watermark).toEqual({ enabled: true, text: "Contoso" });
    expect(config.footer.show).toBe(true);
    expect(config.pageNumbers.show).toBe(true);
    expect(config.presets).toHaveLength(1);
    expect(config.perReportDefaults["executive"]?.primary).toBe("#000000");
  });

  it("defaults the schema version and empty collections", () => {
    const { schemaVersion: _removed, presets: _p, perReportDefaults: _d, ...rest } = validInput();
    const config = parseBrandingConfig({ ...rest, logoRef: null, coverRef: null });
    expect(config.schemaVersion).toBe(BRANDING_SCHEMA_VERSION);
    expect(config.presets).toEqual([]);
    expect(config.perReportDefaults).toEqual({});
  });

  it("round-trips through serialize", () => {
    const config = parseBrandingConfig(validInput());
    expect(parseBrandingConfig(serializeBrandingConfig(config))).toEqual(config);
  });

  it("provides defaults that parse", () => {
    expect(parseBrandingConfig(defaultBrandingConfig())).toEqual(defaultBrandingConfig());
  });

  it("rejects a non-hex colour", () => {
    expectBrandingError(
      () => parseBrandingConfig({ ...validInput(), colors: { primary: "blue", secondary: "#2E86C1" } }),
      "branding.colors.primary",
    );
  });

  it("rejects an inline data URL as a logo reference", () => {
    expectBrandingError(
      () => parseBrandingConfig({ ...validInput(), logoRef: "data:image/png;base64,AAAA" }),
      "branding.logoRef",
    );
  });

  it("rejects an absolute path as a cover reference", () => {
    expectBrandingError(
      () => parseBrandingConfig({ ...validInput(), coverRef: "/etc/branding/cover.png" }),
      "branding.coverRef",
    );
  });

  it("rejects an enabled watermark without text", () => {
    expectBrandingError(
      () => parseBrandingConfig({ ...validInput(), watermark: { enabled: true, text: "" } }),
      "branding.watermark.text",
    );
  });

  it("rejects duplicate preset ids", () => {
    const preset = { id: "dup", name: "Dup", colors: { primary: "#111111", secondary: "#222222" } };
    expectBrandingError(
      () => parseBrandingConfig({ ...validInput(), presets: [preset, preset] }),
      "branding.presets",
    );
  });

  it("rejects unknown top-level fields", () => {
    expectBrandingError(
      () => parseBrandingConfig({ ...validInput(), blob: "AAAA" }),
      "branding.blob",
    );
  });

  it("rejects an unsupported schema version", () => {
    expectBrandingError(
      () => parseBrandingConfig({ ...validInput(), schemaVersion: "v9" }),
      "branding.schemaVersion",
    );
  });
});
