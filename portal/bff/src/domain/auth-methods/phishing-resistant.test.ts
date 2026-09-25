import { describe, expect, it } from "vitest";
import {
  PhishingResistant,
  authMethodIdFromGraphRecord,
  classifyPhishingResistant,
  isPhishingResistantMethod,
  type GraphAuthenticationMethodRecord,
} from "./phishing-resistant.js";
import {
  AUTH_METHOD_IDS,
  PhishingResistant as ContractPhishingResistant,
  isAuthMethodId,
} from "../../../../contracts/src/auth-methods.js";

function record(type: string): GraphAuthenticationMethodRecord {
  return { "@odata.type": type };
}

// [Graph @odata.type, human name, canonical report id]
const PHISHING_RESISTANT_CASES: ReadonlyArray<[string, string, string]> = [
  ["#microsoft.graph.fido2AuthenticationMethod", "FIDO2", "fido2"],
  ["#microsoft.graph.passkeyAuthenticationMethod", "passkey", "passkey"],
  [
    "#microsoft.graph.platformCredentialAuthenticationMethod",
    "platform passkey",
    "passkey",
  ],
  [
    "#microsoft.graph.windowsHelloForBusinessAuthenticationMethod",
    "Windows Hello for Business",
    "windowsHelloForBusiness",
  ],
  [
    "#microsoft.graph.x509CertificateAuthenticationMethod",
    "certificate-based authentication",
    "certificateBasedAuthentication",
  ],
];

const NOT_PHISHING_RESISTANT_CASES: ReadonlyArray<[string, string, string]> = [
  [
    "#microsoft.graph.temporaryAccessPassAuthenticationMethod",
    "Temporary Access Pass",
    "temporaryAccessPass",
  ],
  ["#microsoft.graph.passwordAuthenticationMethod", "password", "password"],
  ["#microsoft.graph.phoneAuthenticationMethod", "SMS/voice", "phone"],
  ["#microsoft.graph.emailAuthenticationMethod", "email", "email"],
  [
    "#microsoft.graph.softwareOathAuthenticationMethod",
    "software OATH",
    "softwareOath",
  ],
  [
    "#microsoft.graph.microsoftAuthenticatorAuthenticationMethod",
    "Microsoft Authenticator",
    "microsoftAuthenticator",
  ],
];

describe("classifyPhishingResistant", () => {
  it.each(PHISHING_RESISTANT_CASES)(
    "classifies %s (%s) as phishing-resistant",
    (type) => {
      expect(classifyPhishingResistant(record(type))).toBe(
        ContractPhishingResistant.Yes,
      );
      expect(classifyPhishingResistant(record(type))).toBe(PhishingResistant.Yes);
    },
  );

  it.each(NOT_PHISHING_RESISTANT_CASES)(
    "classifies %s (%s) as not phishing-resistant",
    (type) => {
      expect(classifyPhishingResistant(record(type))).toBe(
        ContractPhishingResistant.No,
      );
    },
  );

  it("maps every mapped Graph type to a canonical contract id", () => {
    for (const [, , id] of [
      ...PHISHING_RESISTANT_CASES,
      ...NOT_PHISHING_RESISTANT_CASES,
    ]) {
      expect(isAuthMethodId(id)).toBe(true);
      expect(isPhishingResistantMethod(id)).toBe(
        PHISHING_RESISTANT_CASES.some(([, , expected]) => expected === id),
      );
    }
  });
});

describe("unknown methods are safe", () => {
  it("classifies an unrecognised Graph type as unknown instead of throwing", () => {
    expect(
      classifyPhishingResistant(record("#microsoft.graph.quantumAuthenticationMethod")),
    ).toBe(ContractPhishingResistant.Unknown);
  });

  it("classifies a record without a usable @odata.type as unknown", () => {
    expect(classifyPhishingResistant({} as GraphAuthenticationMethodRecord)).toBe(
      ContractPhishingResistant.Unknown,
    );
    expect(
      classifyPhishingResistant({ "@odata.type": "" }),
    ).toBe(ContractPhishingResistant.Unknown);
  });

  it("returns undefined for an unmapped Graph type", () => {
    expect(
      authMethodIdFromGraphRecord(record("#microsoft.graph.quantumAuthenticationMethod")),
    ).toBeUndefined();
  });

  it("is case- and whitespace-insensitive", () => {
    expect(
      classifyPhishingResistant(record("  #MICROSOFT.GRAPH.FIDO2AUTHENTICATIONMETHOD  ")),
    ).toBe(ContractPhishingResistant.Yes);
  });

  it("does not mutate the record it classifies", () => {
    const frozen = Object.freeze(record("#microsoft.graph.fido2AuthenticationMethod"));
    expect(classifyPhishingResistant(frozen)).toBe(ContractPhishingResistant.Yes);
  });
});

describe("contract lockstep", () => {
  it("keeps the classifier enum in lockstep with the contracts enum", () => {
    expect(PhishingResistant).toEqual(ContractPhishingResistant);
  });

  it("covers the full canonical union with graph-type mappings", () => {
    const mapped = new Set(
      [...PHISHING_RESISTANT_CASES, ...NOT_PHISHING_RESISTANT_CASES].map(
        ([, , id]) => id,
      ),
    );
    for (const id of mapped) {
      expect(AUTH_METHOD_IDS).toContain(id);
    }
  });
});
