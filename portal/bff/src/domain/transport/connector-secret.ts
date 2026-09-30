// Connector secret boundary (EPIC-021 SPEC.md §11.2; T-0404).
// Connector secrets (e.g. partner TLS certificates) are stored by reference in
// the credential store; secret material is exchanged for its reference here and
// resolved back to material only inside the tenant child process (T-0011).
// No function in this module returns material: storeConnectorSecret writes the
// material and hands back a reference-only record, and redactConnectorSecret
// strips material from any payload before it reaches an API response or an
// audit event, so no secret value is returned to the BFF or persisted.
import { randomUUID } from "node:crypto";
import type { CredentialStore } from "../../credentials/store.js";

export const CONNECTOR_SECRET_KIND = "connector-tls";

export interface ConnectorSecretRecord {
  readonly tenantId: string;
  readonly secretRef: string;
  readonly kind: string;
  readonly createdAt: string;
}

// Reference minted for connector-secret material. Mirrors the tenant
// credential reference shape (credentials/store.js) so both backends key the
// same way: ref://tenants/<tenantId>/connector-secret/<uuid>.
export function formatConnectorSecretRef(tenantId: string): string {
  return `ref://tenants/${tenantId}/connector-secret/${randomUUID()}`;
}

const CONNECTOR_SECRET_REF_PATTERN =
  /^ref:\/\/tenants\/[^/]+\/connector-secret\/[A-Za-z0-9][A-Za-z0-9-]*$/;

export function isConnectorSecretRef(value: unknown): value is string {
  return typeof value === "string" && CONNECTOR_SECRET_REF_PATTERN.test(value);
}

export interface StoreConnectorSecretInput {
  readonly secrets: CredentialStore;
  readonly tenantId: string;
  readonly material: string;
  readonly now?: () => string;
}

// Writes the material to the credential store under a fresh reference and
// returns the reference-only record. The material is never placed on the
// record, so a persisted row or an API response built from it cannot leak it.
export async function storeConnectorSecret(
  input: StoreConnectorSecretInput,
): Promise<ConnectorSecretRecord> {
  if (input.material.length === 0) {
    throw new Error("connector secret material must be a non-empty string");
  }
  const secretRef = formatConnectorSecretRef(input.tenantId);
  await input.secrets.writeSecret(secretRef, input.material);
  return {
    tenantId: input.tenantId,
    secretRef,
    kind: CONNECTOR_SECRET_KIND,
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  };
}

// Field names that can carry secret material. redactConnectorSecret removes
// them from any payload; references (secretRef, credentialRef) are not
// secrets and pass through untouched.
const SECRET_MATERIAL_FIELDS: ReadonlySet<string> = new Set([
  "partnerCert",
  "partnerCertificate",
  "clientCert",
  "clientCertificate",
  "certificate",
  "certificatePassword",
  "secret",
  "secretMaterial",
  "password",
]);

export function isSecretMaterialField(field: string): boolean {
  return SECRET_MATERIAL_FIELDS.has(field);
}

// Recursively strips secret material from an arbitrary payload (plan, audit
// event, response body). Objects have material fields removed; arrays are
// walked; primitives pass through. The return type matches the input so
// callers can drop it straight into a response or audit sink.
export function redactConnectorSecret<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactConnectorSecret(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const [field, nested] of Object.entries(source)) {
      if (isSecretMaterialField(field)) {
        continue;
      }
      safe[field] = redactConnectorSecret(nested);
    }
    return safe as T;
  }
  return value;
}
