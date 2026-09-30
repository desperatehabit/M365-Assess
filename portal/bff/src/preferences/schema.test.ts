import { describe, expect, it } from "vitest";
import {
  PREFERENCES_SCHEMA_VERSION,
  PreferencesValidationError,
  defaultUserPreferences,
  parseUserPreferences,
  serializeUserPreferences,
} from "./schema.js";

function expectPreferencesError(fn: () => unknown, field: string): PreferencesValidationError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(PreferencesValidationError);
  const preferencesError = thrown as PreferencesValidationError;
  expect(preferencesError.code).toBe("preferences.invalid");
  expect(preferencesError.field).toBe(field);
  return preferencesError;
}

function validInput(): Record<string, unknown> {
  return {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    general: {
      usageLocation: "Europe",
      tablePageSize: 50,
      tableViewMode: "card",
      defaultTestSuite: "CIS",
      persistFilters: true,
    },
    navigation: {
      bookmarks: [{ id: "dash", label: "Dashboard", path: "/dashboard" }],
      compactNav: true,
    },
    appearance: {
      theme: "dark",
      density: "compact",
      textScale: 1.25,
    },
    portalLinks: {
      links: [{ id: "partner", label: "Partner portal", url: "https://partner.example.test" }],
    },
  };
}

describe("preferences schema", () => {
  it("parses a complete §3.4 config", () => {
    const prefs = parseUserPreferences(validInput());
    expect(prefs.schemaVersion).toBe(PREFERENCES_SCHEMA_VERSION);
    expect(prefs.general).toEqual({
      usageLocation: "Europe",
      tablePageSize: 50,
      tableViewMode: "card",
      defaultTestSuite: "CIS",
      persistFilters: true,
    });
    expect(prefs.navigation.bookmarks).toEqual([{ id: "dash", label: "Dashboard", path: "/dashboard" }]);
    expect(prefs.navigation.compactNav).toBe(true);
    expect(prefs.appearance).toEqual({ theme: "dark", density: "compact", textScale: 1.25 });
    expect(prefs.portalLinks.links).toEqual([
      { id: "partner", label: "Partner portal", url: "https://partner.example.test" },
    ]);
  });

  it("defaults the schema version and accepts empty strings and collections", () => {
    const { schemaVersion: _removed, ...rest } = validInput();
    const prefs = parseUserPreferences({
      ...rest,
      general: { usageLocation: "", tablePageSize: 10, tableViewMode: "table", defaultTestSuite: "", persistFilters: false },
      navigation: { bookmarks: [], compactNav: false },
      portalLinks: { links: [] },
    });
    expect(prefs.schemaVersion).toBe(PREFERENCES_SCHEMA_VERSION);
    expect(prefs.general.usageLocation).toBe("");
    expect(prefs.general.defaultTestSuite).toBe("");
    expect(prefs.navigation.bookmarks).toEqual([]);
    expect(prefs.portalLinks.links).toEqual([]);
  });

  it("round-trips through serialize", () => {
    const prefs = parseUserPreferences(validInput());
    expect(parseUserPreferences(serializeUserPreferences(prefs))).toEqual(prefs);
  });

  it("provides defaults that parse", () => {
    expect(parseUserPreferences(defaultUserPreferences())).toEqual(defaultUserPreferences());
  });

  it("parses a JSON string input", () => {
    const prefs = parseUserPreferences(JSON.stringify(validInput()));
    expect(prefs.general.tablePageSize).toBe(50);
  });

  it("rejects an unknown top-level key", () => {
    expectPreferencesError(
      () => parseUserPreferences({ ...validInput(), userAttributes: {} }),
      "preferences.userAttributes",
    );
  });

  it("rejects an unknown key in each nested group", () => {
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          general: { ...validInput().general, theme: "dark" },
        }),
      "preferences.general.theme",
    );
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          navigation: { ...validInput().navigation, bookmarks: [], compactNav: false, roles: [] },
        }),
      "preferences.navigation.roles",
    );
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          appearance: { ...validInput().appearance, font: "serif" },
        }),
      "preferences.appearance.font",
    );
    expectPreferencesError(
      () => parseUserPreferences({ ...validInput(), portalLinks: { links: [], footer: "x" } }),
      "preferences.portalLinks.footer",
    );
  });

  it("rejects an unknown key inside a bookmark and a portal link", () => {
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          navigation: {
            bookmarks: [{ id: "dash", label: "Dashboard", path: "/dashboard", icon: "home" }],
            compactNav: false,
          },
        }),
      "preferences.navigation.bookmarks[0].icon",
    );
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          portalLinks: {
            links: [{ id: "partner", label: "Partner", url: "https://partner.example.test", new: true }],
          },
        }),
      "preferences.portalLinks.links[0].new",
    );
  });

  it("rejects type-mismatched values", () => {
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          general: { ...validInput().general, tablePageSize: "50" },
        }),
      "preferences.general.tablePageSize",
    );
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          general: { ...validInput().general, tablePageSize: 0 },
        }),
      "preferences.general.tablePageSize",
    );
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          general: { ...validInput().general, tablePageSize: 501 },
        }),
      "preferences.general.tablePageSize",
    );
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          general: { ...validInput().general, persistFilters: "yes" },
        }),
      "preferences.general.persistFilters",
    );
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          general: { ...validInput().general, tableViewMode: "grid" },
        }),
      "preferences.general.tableViewMode",
    );
    expectPreferencesError(
      () => parseUserPreferences({ ...validInput(), appearance: { ...validInput().appearance, theme: "blue" } }),
      "preferences.appearance.theme",
    );
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          appearance: { ...validInput().appearance, textScale: 2 },
        }),
      "preferences.appearance.textScale",
    );
  });

  it("rejects an over-long usage location and test suite", () => {
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          general: { ...validInput().general, usageLocation: "x".repeat(65) },
        }),
      "preferences.general.usageLocation",
    );
    expectPreferencesError(
      () =>
        parseUserPreferences({
          ...validInput(),
          general: { ...validInput().general, defaultTestSuite: "x".repeat(121) },
        }),
      "preferences.general.defaultTestSuite",
    );
  });

  it("rejects a bookmark path that is not a relative portal path", () => {
    for (const path of ["dashboard", "/../admin", "https://partner.example.test/x", "/dashboard with space"]) {
      expectPreferencesError(
        () =>
          parseUserPreferences({
            ...validInput(),
            navigation: { bookmarks: [{ id: "dash", label: "Dashboard", path }], compactNav: false },
          }),
        "preferences.navigation.bookmarks[0].path",
      );
    }
  });

  it("rejects a portal link that is not an absolute http(s) URL", () => {
    for (const url of ["partner.example.test", "ftp://partner.example.test", "data:text/html,AAAA"]) {
      expectPreferencesError(
        () =>
          parseUserPreferences({
            ...validInput(),
            portalLinks: { links: [{ id: "partner", label: "Partner", url }] },
          }),
        "preferences.portalLinks.links[0].url",
      );
    }
  });

  it("rejects an unsupported schemaVersion", () => {
    expectPreferencesError(
      () => parseUserPreferences({ ...validInput(), schemaVersion: "v2" }),
      "preferences.schemaVersion",
    );
  });

  it("rejects a non-object body and invalid JSON", () => {
    expectPreferencesError(() => parseUserPreferences([1, 2, 3]), "preferences");
    expectPreferencesError(() => parseUserPreferences("not json"), "preferences");
  });
});
