// Tests for the Defender policy-area registry (T-0361).
// Covers every registered area: presence, source, scopes, v1 support flag.
import { describe, expect, it } from "vitest";
import {
  DEFENDER_POLICY_AREAS,
  isKnownDefenderPolicyArea,
  lookupDefenderPolicyArea,
  supportedDefenderPolicyAreas,
  type DefenderPolicyArea,
} from "./defender-policy-areas.js";

describe("DEFENDER_POLICY_AREAS registry (T-0361)", () => {
  it("enumerates all six SPEC §3.1 policy areas", () => {
    const areas: DefenderPolicyArea[] = [
      "av",
      "edr",
      "asr",
      "compliance",
      "firewall",
      "exclusions",
    ];
    for (const area of areas) {
      const entry = DEFENDER_POLICY_AREAS.find((e) => e.area === area);
      expect(entry, `expected registry entry for area '${area}'`).toBeDefined();
    }
    expect(DEFENDER_POLICY_AREAS).toHaveLength(6);
  });

  it("every entry has a displayName, source, graphResource, scopes, and recommendation", () => {
    for (const entry of DEFENDER_POLICY_AREAS) {
      expect(entry.displayName, `displayName ${entry.area}`).toBeTruthy();
      expect(
        ["graph-security", "device-management", "exo"],
        `source ${entry.area}`,
      ).toContain(entry.source);
      expect(entry.graphResource, `graphResource ${entry.area}`).toBeTruthy();
      expect(entry.requiredScopes.length, `requiredScopes ${entry.area}`).toBeGreaterThan(0);
      expect(entry.recommended, `recommended ${entry.area}`).toBeTruthy();
    }
  });

  it("covers all three sources (Graph security, device management, EXO)", () => {
    const sources = new Set(DEFENDER_POLICY_AREAS.map((e) => e.source));
    expect(sources.has("graph-security")).toBe(true);
    expect(sources.has("device-management")).toBe(true);
    expect(sources.has("exo")).toBe(true);
  });

  it("uses beta for device-management resources that v1.0 does not expose", () => {
    // Live tenant: v1.0/configurationPolicies and v1.0/intents return
    // "Resource not found for the segment"; beta returns 200 (EPIC-019).
    const affected = DEFENDER_POLICY_AREAS.filter(
      (e) =>
        e.graphResource.includes("deviceManagement/intents") ||
        e.graphResource.includes("deviceManagement/configurationPolicies"),
    );
    expect(affected.length).toBeGreaterThan(0);
    for (const entry of affected) {
      expect(entry.graphResource.startsWith("beta/"), `${entry.area} should use beta`).toBe(true);
    }
  });

  it("supports AV/EDR/ASR in v1", () => {
    for (const area of ["av", "edr", "asr"] as const) {
      const entry = DEFENDER_POLICY_AREAS.find((e) => e.area === area);
      expect(entry).toBeDefined();
      expect(entry!.supported, `${area} should be supported`).toBe(true);
    }
  });

  it("marks compliance, firewall, and exclusions as not yet supported", () => {
    for (const area of ["compliance", "firewall", "exclusions"] as const) {
      const entry = DEFENDER_POLICY_AREAS.find((e) => e.area === area);
      expect(entry).toBeDefined();
      expect(entry!.supported, `${area} should be unsupported`).toBe(false);
    }
  });

  it("has no duplicate areas", () => {
    const seen = new Set<string>();
    for (const entry of DEFENDER_POLICY_AREAS) {
      expect(seen.has(entry.area), `duplicate entry for ${entry.area}`).toBe(false);
      seen.add(entry.area);
    }
  });

  it("lists supported entries before unsupported ones", () => {
    const flags = DEFENDER_POLICY_AREAS.map((e) => e.supported);
    const firstUnsupported = flags.indexOf(false);
    expect(firstUnsupported).toBeGreaterThan(0);
    expect(flags.slice(firstUnsupported)).toEqual([false, false, false]);
  });
});

describe("lookupDefenderPolicyArea (T-0361)", () => {
  it("returns the entry for a known area", () => {
    const entry = lookupDefenderPolicyArea("av");
    expect(entry).toBeDefined();
    expect(entry!.area).toBe("av");
    expect(entry!.source).toBe("device-management");
  });

  it("returns undefined for an unknown area", () => {
    expect(lookupDefenderPolicyArea("unknown-area")).toBeUndefined();
  });
});

describe("supportedDefenderPolicyAreas (T-0361)", () => {
  it("returns exactly AV/EDR/ASR", () => {
    const entries = supportedDefenderPolicyAreas();
    expect(entries.map((e) => e.area).sort()).toEqual(["asr", "av", "edr"]);
    for (const e of entries) {
      expect(e.supported).toBe(true);
    }
  });
});

describe("isKnownDefenderPolicyArea (T-0361)", () => {
  it("returns true for known areas", () => {
    for (const area of ["av", "edr", "asr", "compliance", "firewall", "exclusions"]) {
      expect(isKnownDefenderPolicyArea(area)).toBe(true);
    }
  });

  it("returns false for unknown areas", () => {
    expect(isKnownDefenderPolicyArea("unknown")).toBe(false);
    expect(isKnownDefenderPolicyArea("")).toBe(false);
    expect(isKnownDefenderPolicyArea("configuration")).toBe(false);
  });
});
