import { describe, expect, it } from "vitest";
import {
  AUTH_METHOD_IDS,
  PhishingResistant,
  isAuthMethodId,
  type UserAuthenticationMethods,
} from "./auth-methods.js";

describe("auth-method vocabulary", () => {
  it("declares every §11.4 phishing-resistant method", () => {
    for (const id of [
      "fido2",
      "passkey",
      "windowsHelloForBusiness",
      "certificateBasedAuthentication",
    ]) {
      expect(isAuthMethodId(id)).toBe(true);
    }
  });

  it("declares the strong-but-not-phishing-resistant methods", () => {
    for (const id of [
      "temporaryAccessPass",
      "softwareOath",
      "microsoftAuthenticator",
      "phone",
      "email",
      "password",
    ]) {
      expect(isAuthMethodId(id)).toBe(true);
    }
  });

  it("recognises every declared id and rejects anything else", () => {
    for (const id of AUTH_METHOD_IDS) {
      expect(isAuthMethodId(id)).toBe(true);
    }
    expect(isAuthMethodId("telepathy")).toBe(false);
    expect(isAuthMethodId(42)).toBe(false);
  });

  it("models the method-to-user mapping the report aggregates on", () => {
    const row: UserAuthenticationMethods = {
      userId: "user-1",
      methods: ["microsoftAuthenticator", "fido2"],
      defaultMethod: "microsoftAuthenticator",
    };
    expect(row.methods).toContain("fido2");
    expect(row.defaultMethod).toBe("microsoftAuthenticator");
  });
});

describe("PhishingResistant classification values", () => {
  it("has a safe unknown value and exactly three outcomes", () => {
    expect(PhishingResistant.Unknown).toBe("unknown");
    expect(new Set(Object.values(PhishingResistant))).toEqual(
      new Set(["phishing-resistant", "not-phishing-resistant", "unknown"]),
    );
  });
});
