import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_EXPIRY_WARNING_DAYS,
  deriveCredentialState,
} from "./expiry.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");

function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe("deriveCredentialState", () => {
  it("returns missing when there is no credential row", () => {
    expect(deriveCredentialState(null, NOW)).toBe("missing");
    expect(deriveCredentialState(undefined, NOW)).toBe("missing");
  });

  it("returns valid for a credential without an expiry", () => {
    expect(deriveCredentialState({ expiresOn: null }, NOW)).toBe("valid");
    expect(deriveCredentialState({ expiresOn: undefined }, NOW)).toBe("valid");
  });

  it("returns valid when expiry is beyond the warning window", () => {
    expect(deriveCredentialState({ expiresOn: daysFromNow(31) }, NOW)).toBe("valid");
    expect(deriveCredentialState({ expiresOn: daysFromNow(365) }, NOW)).toBe("valid");
  });

  it("returns expiring at or inside the 30-day window", () => {
    expect(CREDENTIAL_EXPIRY_WARNING_DAYS).toBe(30);
    expect(deriveCredentialState({ expiresOn: daysFromNow(30) }, NOW)).toBe("expiring");
    expect(deriveCredentialState({ expiresOn: daysFromNow(1) }, NOW)).toBe("expiring");
  });

  it("returns expired once the expiry has passed", () => {
    expect(deriveCredentialState({ expiresOn: daysFromNow(-1) }, NOW)).toBe("expired");
    expect(deriveCredentialState({ expiresOn: NOW.toISOString() }, NOW)).toBe("expired");
  });
});
