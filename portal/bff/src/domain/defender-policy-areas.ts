// Defender policy-area registry (EPIC-019 SPEC.md §2 US-1, §3.1, §6, §11.2; T-0361).
//
// Maps every Defender policy area to its data source (Graph security,
// device management, or EXO — the same sources the module's Defender
// assessment uses: Get-DefenderPolicyReport.ps1 and Defender*Checks.ps1),
// its required scopes, and its recommended baseline. Drives the status
// handler and later setup-wizard tickets.
//
// v1 supports AV/EDR/ASR only (SPEC §11.2). The remaining areas must return
// a structured "not yet supported" marker rather than an empty result.

export type DefenderPolicyArea =
  | "av"
  | "edr"
  | "asr"
  | "compliance"
  | "firewall"
  | "exclusions";

export type DefenderPolicySource = "graph-security" | "device-management" | "exo";

export interface DefenderPolicyAreaEntry {
  /** The area (matches the optional `area` query on the status route). */
  readonly area: DefenderPolicyArea;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Where the area's state is read from. */
  readonly source: DefenderPolicySource;
  /**
   * Graph resource path (relative, no leading /) for Graph sources, or the
   * EXO read cmdlet for `exo` sources. Read-only in both cases.
   */
  readonly graphResource: string;
  /** Required scopes to read this area. */
  readonly requiredScopes: readonly string[];
  /** Recommended baseline surfaced as `recommended` on the status route. */
  readonly recommended: string;
  /**
   * Whether v1 supports this area.
   * When false the status route marks the area as not yet supported.
   */
  readonly supported: boolean;
}

/**
 * The shared Defender policy-area registry.
 *
 * Order: supported entries first, then unsupported, alphabetical within group.
 */
export const DEFENDER_POLICY_AREAS: readonly DefenderPolicyAreaEntry[] = [
  // ---- Supported in v1 (SPEC §11.2: AV/EDR/ASR first) ----
  {
    area: "asr",
    displayName: "Attack Surface Reduction (ASR)",
    source: "device-management",
    graphResource: "beta/deviceManagement/intents",
    requiredScopes: ["DeviceManagementConfiguration.Read.All"],
    recommended: "ASR rules in block or warn mode per baseline",
    supported: true,
  },
  {
    area: "av",
    displayName: "Antivirus (AV)",
    source: "device-management",
    graphResource: "beta/deviceManagement/configurationPolicies",
    requiredScopes: ["DeviceManagementConfiguration.Read.All"],
    recommended: "Real-time protection enabled with up-to-date signatures",
    supported: true,
  },
  {
    area: "edr",
    displayName: "Endpoint Detection and Response (EDR)",
    source: "graph-security",
    graphResource: "v1.0/security/alerts_v2",
    requiredScopes: ["SecurityEvents.Read.All"],
    recommended: "Devices onboarded to Defender for Endpoint in block mode",
    supported: true,
  },
  // ---- Not yet supported (v1 deferred, SPEC §11.2) ----
  {
    area: "compliance",
    displayName: "Device Compliance",
    source: "device-management",
    graphResource: "v1.0/deviceManagement/deviceCompliancePolicies",
    requiredScopes: ["DeviceManagementConfiguration.Read.All"],
    recommended: "Compliance policies assigned with conditional access",
    supported: false,
  },
  {
    area: "exclusions",
    displayName: "Exclusions",
    source: "exo",
    graphResource: "exo:Get-TenantAllowBlockList",
    requiredScopes: ["Exchange.Manage"],
    recommended: "No standing allow-list entries without expiry",
    supported: false,
  },
  {
    area: "firewall",
    displayName: "Firewall",
    source: "device-management",
    graphResource: "beta/deviceManagement/intents",
    requiredScopes: ["DeviceManagementConfiguration.Read.All"],
    recommended: "Host firewall enabled on all profiles",
    supported: false,
  },
];

/** Returns the registry entry for an area, or undefined when unknown. */
export function lookupDefenderPolicyArea(
  area: string,
): DefenderPolicyAreaEntry | undefined {
  return DEFENDER_POLICY_AREAS.find((e) => e.area === area);
}

/** Returns the v1-supported areas, in registry order. */
export function supportedDefenderPolicyAreas(): readonly DefenderPolicyAreaEntry[] {
  return DEFENDER_POLICY_AREAS.filter((e) => e.supported);
}

/** Returns true if the supplied string is a known DefenderPolicyArea. */
export function isKnownDefenderPolicyArea(area: string): area is DefenderPolicyArea {
  return DEFENDER_POLICY_AREAS.some((e) => e.area === area);
}
