// Tests for the Intune app-type registry (T-0321).
import { describe, expect, it } from "vitest";
import {
  INTUNE_APP_TYPES,
  appTypeForOdataType,
  isKnownAppType,
  lookupAppType,
  supportedAppTypes,
  type IntuneAppType,
} from "./intune-app-types.js";

const SPEC_TYPES: IntuneAppType[] = ["win32", "store", "office", "edge", "msp", "choco"];

describe("INTUNE_APP_TYPES registry (T-0321)", () => {
  it("has exactly one entry for every SPEC §3.1 app type", () => {
    expect(INTUNE_APP_TYPES.map((e) => e.type).sort()).toEqual([...SPEC_TYPES].sort());
  });

  it("every entry has a display name, platform, and required scopes", () => {
    for (const entry of INTUNE_APP_TYPES) {
      expect(entry.displayName, entry.type).toBeTruthy();
      expect(entry.platform, entry.type).toBe("windows");
      expect(entry.requiredScopes, entry.type).toContain("DeviceManagementApps.Read.All");
    }
  });

  it("supports only Win32 and Store in v1 (SPEC §11.1)", () => {
    expect(supportedAppTypes()).toEqual(["win32", "store"]);
    for (const type of ["office", "edge", "msp", "choco"]) {
      expect(lookupAppType(type)!.supported, type).toBe(false);
    }
  });

  it("lists supported entries before unsupported ones", () => {
    const flags = INTUNE_APP_TYPES.map((e) => e.supported);
    expect(flags.indexOf(false)).toBeGreaterThan(flags.lastIndexOf(true));
  });

  it("gives Graph-backed types OData types and leaves MSP/Choco without any", () => {
    for (const type of ["win32", "store", "office", "edge"]) {
      expect(lookupAppType(type)!.odataTypes.length, type).toBeGreaterThan(0);
    }
    expect(lookupAppType("msp")!.odataTypes).toEqual([]);
    expect(lookupAppType("choco")!.odataTypes).toEqual([]);
  });

  it("claims each OData type from at most one entry", () => {
    const all = INTUNE_APP_TYPES.flatMap((e) => e.odataTypes);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("registry lookups (T-0321)", () => {
  it("recognises known types and rejects others", () => {
    for (const type of SPEC_TYPES) expect(isKnownAppType(type), type).toBe(true);
    expect(isKnownAppType("msi")).toBe(false);
    expect(isKnownAppType("")).toBe(false);
    expect(lookupAppType("msi")).toBeUndefined();
  });

  it("maps Graph OData types to their entry, case-insensitively", () => {
    expect(appTypeForOdataType("#microsoft.graph.win32LobApp")?.type).toBe("win32");
    expect(appTypeForOdataType("#microsoft.graph.WINGETAPP")?.type).toBe("store");
    expect(appTypeForOdataType("#microsoft.graph.microsoftStoreForBusinessApp")?.type).toBe("store");
    expect(appTypeForOdataType("#microsoft.graph.officeSuiteApp")?.type).toBe("office");
    expect(appTypeForOdataType("#microsoft.graph.iosStoreApp")).toBeUndefined();
  });
});
