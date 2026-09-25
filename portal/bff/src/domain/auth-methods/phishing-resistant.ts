// Pure phishing-resistant classifier over a Graph authentication-method record
// (EPIC-012 SPEC.md §9, §11.4). The record is read from Graph by the worker;
// this module performs no SDK or Graph call so the classification is pure and
// unit-testable. `@m365-assess/contracts/auth-methods` owns the canonical method
// vocabulary and the same `PhishingResistant` values; the classifier test pins
// this module to them (the bff tsconfig rootDir cannot reach the contracts
// source, so the values are declared here rather than imported).

export const PhishingResistant = {
  Yes: "phishing-resistant",
  No: "not-phishing-resistant",
  Unknown: "unknown",
} as const;

export type PhishingResistant =
  (typeof PhishingResistant)[keyof typeof PhishingResistant];

export interface GraphAuthenticationMethodRecord {
  "@odata.type": string;
  id?: string;
}

// SPEC §11.4: phishing-resistant means FIDO2, passkey, Windows Hello for
// Business, or certificate-based authentication. Temporary Access Pass and the
// one-time methods are deliberately excluded even though they are strong.
const PHISHING_RESISTANT_METHODS: readonly string[] = [
  "fido2",
  "passkey",
  "windowsHelloForBusiness",
  "certificateBasedAuthentication",
];

// Graph reports the method in `@odata.type`. Normalise it to the canonical id
// the report aggregates on; an unlisted suffix stays unmapped and the caller
// records it as `unknown` instead of throwing (SPEC §9: read, do not infer).
const GRAPH_TYPE_TO_METHOD: Readonly<Record<string, string>> = Object.freeze({
  "#microsoft.graph.fido2AuthenticationMethod": "fido2",
  "#microsoft.graph.passkeyAuthenticationMethod": "passkey",
  "#microsoft.graph.platformCredentialAuthenticationMethod": "passkey",
  "#microsoft.graph.windowsHelloForBusinessAuthenticationMethod": "windowsHelloForBusiness",
  "#microsoft.graph.x509CertificateAuthenticationMethod": "certificateBasedAuthentication",
  "#microsoft.graph.microsoftAuthenticatorAuthenticationMethod": "microsoftAuthenticator",
  "#microsoft.graph.softwareOathAuthenticationMethod": "softwareOath",
  "#microsoft.graph.temporaryAccessPassAuthenticationMethod": "temporaryAccessPass",
  "#microsoft.graph.phoneAuthenticationMethod": "phone",
  "#microsoft.graph.emailAuthenticationMethod": "email",
  "#microsoft.graph.passwordAuthenticationMethod": "password",
});

const GRAPH_TYPE_TO_METHOD_FOLDED: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(GRAPH_TYPE_TO_METHOD).map(([type, id]) => [type.toLowerCase(), id]),
  ),
);

export function authMethodIdFromGraphRecord(
  method: GraphAuthenticationMethodRecord,
): string | undefined {
  const type = method["@odata.type"];
  if (typeof type !== "string") {
    return undefined;
  }
  return GRAPH_TYPE_TO_METHOD_FOLDED[type.trim().toLowerCase()];
}

export function isPhishingResistantMethod(method: string): boolean {
  return PHISHING_RESISTANT_METHODS.includes(method);
}

export function classifyPhishingResistant(
  method: GraphAuthenticationMethodRecord,
): PhishingResistant {
  const id = authMethodIdFromGraphRecord(method);
  if (id === undefined) {
    return PhishingResistant.Unknown;
  }
  return isPhishingResistantMethod(id) ? PhishingResistant.Yes : PhishingResistant.No;
}
