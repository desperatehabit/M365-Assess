import { describe, expect, it } from "vitest";
import { createInMemoryCredentialStore } from "../../credentials/store.js";
import {
  CONNECTOR_SECRET_KIND,
  formatConnectorSecretRef,
  isConnectorSecretRef,
  redactConnectorSecret,
  storeConnectorSecret,
} from "./connector-secret.js";

const TENANT = "tenant-test";
const MATERIAL = "-----BEGIN CERTIFICATE-----partner-tls-material-----END CERTIFICATE-----";

describe("connector-secret references (T-0404)", () => {
  it("mints a reference under the tenant connector-secret namespace", () => {
    const ref = formatConnectorSecretRef(TENANT);
    expect(ref).toMatch(/^ref:\/\/tenants\/tenant-test\/connector-secret\/[A-Za-z0-9-]+$/);
    expect(isConnectorSecretRef(ref)).toBe(true);
  });

  it("rejects material, foreign namespaces, and malformed values", () => {
    expect(isConnectorSecretRef(MATERIAL)).toBe(false);
    expect(isConnectorSecretRef("ref://tenants/tenant-test/credential/abc")).toBe(false);
    expect(isConnectorSecretRef("ref://tenants/tenant-test/connector-secret/")).toBe(false);
    expect(isConnectorSecretRef("")).toBe(false);
    expect(isConnectorSecretRef(null)).toBe(false);
    expect(isConnectorSecretRef(undefined)).toBe(false);
    expect(isConnectorSecretRef(42)).toBe(false);
  });
});

describe("storeConnectorSecret (T-0404)", () => {
  it("writes the material to the store and returns a reference-only record", async () => {
    const secrets = createInMemoryCredentialStore();
    const record = await storeConnectorSecret({ secrets, tenantId: TENANT, material: MATERIAL });

    expect(record.tenantId).toBe(TENANT);
    expect(record.kind).toBe(CONNECTOR_SECRET_KIND);
    expect(isConnectorSecretRef(record.secretRef)).toBe(true);
    expect(record.createdAt).toBeTruthy();
    expect(JSON.stringify(record)).not.toContain(MATERIAL);
    await expect(secrets.readSecret(record.secretRef)).resolves.toBe(MATERIAL);
  });

  it("mints a fresh reference per call", async () => {
    const secrets = createInMemoryCredentialStore();
    const first = await storeConnectorSecret({ secrets, tenantId: TENANT, material: MATERIAL });
    const second = await storeConnectorSecret({ secrets, tenantId: TENANT, material: MATERIAL });
    expect(first.secretRef).not.toBe(second.secretRef);
  });

  it("refuses empty material", async () => {
    const secrets = createInMemoryCredentialStore();
    await expect(
      storeConnectorSecret({ secrets, tenantId: TENANT, material: "" }),
    ).rejects.toThrow(/non-empty/);
  });
});

describe("redactConnectorSecret (T-0404)", () => {
  it("strips secret material fields from a nested payload and keeps references", () => {
    const payload = {
      name: "Partner outbound",
      secretRef: "ref://tenants/tenant-test/connector-secret/abc",
      partnerCert: MATERIAL,
      nested: {
        clientCertificate: MATERIAL,
        certificatePassword: "p@ssw0rd",
        tls: true,
      },
      list: [{ secretMaterial: MATERIAL, state: "enabled" }],
    };

    const safe = redactConnectorSecret(payload) as Record<string, unknown>;

    expect(safe["secretRef"]).toBe(payload.secretRef);
    expect(safe["partnerCert"]).toBeUndefined();
    expect(safe["name"]).toBe("Partner outbound");
    const nested = safe["nested"] as Record<string, unknown>;
    expect(nested["clientCertificate"]).toBeUndefined();
    expect(nested["certificatePassword"]).toBeUndefined();
    expect(nested["tls"]).toBe(true);
    const item = (safe["list"] as Record<string, unknown>[])[0]!;
    expect(item["secretMaterial"]).toBeUndefined();
    expect(item["state"]).toBe("enabled");
    expect(JSON.stringify(safe)).not.toContain(MATERIAL);
    expect(JSON.stringify(safe)).not.toContain("p@ssw0rd");
  });

  it("passes primitives, arrays, and null through", () => {
    expect(redactConnectorSecret("plain")).toBe("plain");
    expect(redactConnectorSecret(7)).toBe(7);
    expect(redactConnectorSecret(null)).toBeNull();
    expect(redactConnectorSecret([1, "two", false])).toEqual([1, "two", false]);
  });
});
