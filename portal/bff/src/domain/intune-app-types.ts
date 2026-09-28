// Intune app-type registry (EPIC-017 SPEC.md §3.1, §11.1; T-0321).
//
// Maps every app type the Applications page names (Win32/Store/Office/Edge/MSP/Choco)
// to the Graph `mobileApp` OData types it covers, its platform, and required Graph
// scopes. Drives the list route and later upload/assign/template tickets.
//
// v1 supports Win32 and Store apps only (§11.1). Unsupported types must return a
// structured "not yet supported" error rather than an empty list. MSP and Choco are
// deployment sources rather than Graph types, so they carry no OData types.

export type IntuneAppType = "win32" | "store" | "office" | "edge" | "msp" | "choco";
export type IntuneAppPlatform = "windows";

/** The row label for a Graph app whose OData type no registry entry claims. */
export const OTHER_APP_TYPE = "other";

export interface IntuneAppTypeEntry {
  /** The type (matches the `type` query value). */
  readonly type: IntuneAppType;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Target platform. */
  readonly platform: IntuneAppPlatform;
  /** Graph `mobileApp` OData types this entry covers; empty for non-Graph sources. */
  readonly odataTypes: readonly string[];
  /** Required Graph application scopes (SPEC §7). */
  readonly requiredScopes: readonly string[];
  /**
   * Whether v1 supports this type.
   * When false the route returns 501 with `intune.app-type.unsupported`.
   */
  readonly supported: boolean;
}

const APP_SCOPES = ["DeviceManagementApps.Read.All"] as const;

/**
 * The shared Intune app-type registry.
 *
 * Order: supported entries first, then unsupported, in the SPEC §3.1 column order.
 */
export const INTUNE_APP_TYPES: readonly IntuneAppTypeEntry[] = [
  // ---- Supported in v1 ----
  {
    type: "win32",
    displayName: "Windows app (Win32)",
    platform: "windows",
    odataTypes: ["#microsoft.graph.win32LobApp"],
    requiredScopes: APP_SCOPES,
    supported: true,
  },
  {
    type: "store",
    displayName: "Microsoft Store app",
    platform: "windows",
    odataTypes: ["#microsoft.graph.winGetApp", "#microsoft.graph.microsoftStoreForBusinessApp"],
    requiredScopes: APP_SCOPES,
    supported: true,
  },
  // ---- Not yet supported (v1 deferred) ----
  {
    type: "office",
    displayName: "Microsoft 365 Apps",
    platform: "windows",
    odataTypes: ["#microsoft.graph.officeSuiteApp"],
    requiredScopes: APP_SCOPES,
    supported: false,
  },
  {
    type: "edge",
    displayName: "Microsoft Edge",
    platform: "windows",
    odataTypes: ["#microsoft.graph.windowsMicrosoftEdgeApp"],
    requiredScopes: APP_SCOPES,
    supported: false,
  },
  {
    type: "msp",
    displayName: "MSP app",
    platform: "windows",
    odataTypes: [],
    requiredScopes: APP_SCOPES,
    supported: false,
  },
  {
    type: "choco",
    displayName: "Chocolatey app",
    platform: "windows",
    odataTypes: [],
    requiredScopes: APP_SCOPES,
    supported: false,
  },
];

const KNOWN_TYPES: readonly string[] = INTUNE_APP_TYPES.map((e) => e.type);

/** Returns true if the supplied string is a known IntuneAppType. */
export function isKnownAppType(type: string): type is IntuneAppType {
  return KNOWN_TYPES.includes(type);
}

/** Returns the registry entry for a type, or undefined if the type is unknown. */
export function lookupAppType(type: string): IntuneAppTypeEntry | undefined {
  return INTUNE_APP_TYPES.find((e) => e.type === type);
}

/** The types v1 lists and deploys. */
export function supportedAppTypes(): readonly IntuneAppType[] {
  return INTUNE_APP_TYPES.filter((e) => e.supported).map((e) => e.type);
}

/** Returns the entry that claims a Graph OData type, or undefined when none does. */
export function appTypeForOdataType(odataType: string): IntuneAppTypeEntry | undefined {
  const needle = odataType.toLowerCase();
  return INTUNE_APP_TYPES.find((e) => e.odataTypes.some((t) => t.toLowerCase() === needle));
}
