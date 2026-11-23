// Shared assertions for the operator-credential sweep (T-0940).
//
// Test-only support: the file name deliberately does not match vitest's
// `*.test.ts` include, so it is imported by adapter/route tests rather than run
// as a suite. Keeping the credential ref here makes every domain assert the
// same literal the worker resolver expects.
import { expect } from "vitest";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import type { CredentialPurpose } from "./workers.js";

export interface RecordedWorkerCall {
  readonly entrypoint: string;
  readonly job: Record<string, unknown>;
}

export const READER_CREDENTIAL_REF = (tenantId: string): string => `tenants/${tenantId}/credential`;
export const OPERATOR_CREDENTIAL_REF = (tenantId: string): string =>
  `tenants/${tenantId}/operator-credential`;

function credentialRecord(tenantId: string, purpose: CredentialPurpose): CredentialRecord {
  return {
    id: `${tenantId}-${purpose}`,
    tenantId,
    authMethod: "certificate-thumbprint",
    clientId: purpose === "operator" ? "operator-app" : "reader-app",
    secretRef: "thumbprint://ABC",
    thumbprint: "ABC",
    environment: "commercial",
    expiresOn: null,
    lastValidated: null,
    purpose,
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * A purpose-aware credential store. `operator: false` models a tenant that has
 * not opted in to write access, so an operator lookup returns undefined and the
 * worker seam must answer 409 instead of falling back to the reader record.
 */
export function purposeAwareCredentials(
  tenants: readonly string[] = ["t-a"],
  options: { readonly operator?: boolean } = {},
): CredentialStoreRow {
  const operator = options.operator ?? true;
  return {
    async getCredential(tenantId, purpose = "reader") {
      if (!tenants.includes(tenantId)) return undefined;
      if (purpose === "operator" && !operator) return undefined;
      return credentialRecord(tenantId, purpose);
    },
    async upsertCredential(input) {
      return input;
    },
    async listCredentials(tenantId) {
      return tenants.includes(tenantId) ? [credentialRecord(tenantId, "reader")] : [];
    },
    async deleteCredential() {
      return false;
    },
    async appendAuditEvent() {
      return undefined;
    },
  };
}

/** The credential block a recorded worker call carried. */
export function credentialBlockOf(call: RecordedWorkerCall): Record<string, unknown> {
  const block = call.job["credential"];
  expect(block, `${call.entrypoint} carried no credential block`).toBeTypeOf("object");
  return block as Record<string, unknown>;
}

/** Asserts a write call signed in with `tenants/<id>/operator-credential`. */
export function expectOperatorCall(call: RecordedWorkerCall, tenantId = "t-a"): void {
  expect(credentialBlockOf(call)).toMatchObject({
    credentialRef: OPERATOR_CREDENTIAL_REF(tenantId),
    purpose: "operator",
  });
}

/** Asserts an adjacent read call kept `tenants/<id>/credential`. */
export function expectReaderCall(call: RecordedWorkerCall, tenantId = "t-a"): void {
  expect(credentialBlockOf(call)).toMatchObject({
    credentialRef: READER_CREDENTIAL_REF(tenantId),
    purpose: "reader",
  });
}

/**
 * Asserts the purpose of every recorded call, in order. A single call can pass
 * the purpose directly instead of a one-item array.
 */
export function expectCallPurposes(
  calls: readonly RecordedWorkerCall[],
  tenantId: string,
  purposes: readonly CredentialPurpose[] | CredentialPurpose,
): void {
  const expected = Array.isArray(purposes) ? purposes : [purposes];
  expect(calls).toHaveLength(expected.length);
  expected.forEach((purpose, index) => {
    const call = calls[index]!;
    if (purpose === "operator") expectOperatorCall(call, tenantId);
    else expectReaderCall(call, tenantId);
  });
}
