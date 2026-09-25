// Authentication-method contracts for the MFA report (EPIC-012 SPEC.md §3.1, §9,
// §11.4). The report must classify phishing-resistant methods by reading the
// methods Graph reports, never by inferring them, so this module owns the
// canonical vocabulary the worker normalises Graph records to. The pure
// classifier that consumes it lives in
// `portal/bff/src/domain/auth-methods/phishing-resistant.ts`; its test pins the
// two modules together.

// Canonical method ids. Each is the short Graph `@odata.type` discriminator
// (`#microsoft.graph.<id>AuthenticationMethod`), except passkey and certificate
// based authentication, which the pre-report registration details split across
// several names and the report folds back into one.
export const AUTH_METHOD_IDS = [
  "fido2",
  "passkey",
  "windowsHelloForBusiness",
  "certificateBasedAuthentication",
  "microsoftAuthenticator",
  "softwareOath",
  "temporaryAccessPass",
  "phone",
  "email",
  "password",
] as const;

export type AuthMethodId = (typeof AUTH_METHOD_IDS)[number];

// §11.4 resolves phishing-resistance to FIDO2, passkey, Windows Hello for
// Business, and certificate-based authentication. Anything else is explicitly
// not phishing-resistant, and an unrecognised method is `unknown` rather than an
// error so a new Graph method type never breaks the report.
export const PhishingResistant = {
  Yes: "phishing-resistant",
  No: "not-phishing-resistant",
  Unknown: "unknown",
} as const;

export type PhishingResistant =
  (typeof PhishingResistant)[keyof typeof PhishingResistant];

export function isAuthMethodId(value: unknown): value is AuthMethodId {
  return (
    typeof value === "string" && (AUTH_METHOD_IDS as readonly string[]).includes(value)
  );
}

// The method-to-user mapping the report aggregates on: one row per user, their
// canonical method ids, and the default when Graph reports one. No other
// per-user method state is persisted (SPEC §5).
export interface UserAuthenticationMethods {
  userId: string;
  methods: AuthMethodId[];
  defaultMethod?: AuthMethodId;
}
