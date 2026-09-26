// Credential-store boundary (EPIC-002 SPEC.md §5, 03-database.md §4).
// The database holds only a `secretRef` reference, never secret material; this
// module owns the store behind that reference. Material is resolved only inside
// the worker child process (T-0011 `Resolve-TenantCredential` takes a
// `param([string]$SecretRef)` lookup against this same contract); the BFF
// writes material here on set/rotate and never reads it back into a response.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CredentialStore {
  readSecret(ref: string): Promise<string | null>;
  writeSecret(ref: string, value: string): Promise<void>;
  deleteSecret(ref: string): Promise<void>;
}

// Reference minted for secret-backed material. Thumbprint credentials carry no
// material, so their rows use `formatThumbprintRef` instead and never touch a
// backend.
export function formatSecretRef(tenantId: string): string {
  return `ref://tenants/${tenantId}/credential/${randomUUID()}`;
}

export function formatThumbprintRef(thumbprint: string): string {
  return `cert://thumbprint/${thumbprint.trim().toLowerCase()}`;
}

export function createInMemoryCredentialStore(
  seed: Readonly<Record<string, string>> = {},
): CredentialStore {
  const secrets = new Map<string, string>(Object.entries(seed));
  return {
    async readSecret(ref: string): Promise<string | null> {
      return secrets.get(ref) ?? null;
    },
    async writeSecret(ref: string, value: string): Promise<void> {
      secrets.set(ref, value);
    },
    async deleteSecret(ref: string): Promise<void> {
      secrets.delete(ref);
    },
  };
}

export interface OsKeystoreOptions {
  readonly directory?: string;
}

// Dev backend: one file per reference under an OS-appropriate directory with
// owner-only permissions. Key Vault implements `CredentialStore` later without
// touching callers (EPIC-002 SPEC.md §11 Q2). Values never appear in errors.
export function defaultOsKeystoreDirectory(): string {
  return join(homedir(), ".m365-assess", "credentials");
}

function keyFile(directory: string, ref: string): string {
  return join(directory, `${createHash("sha256").update(ref).digest("hex")}.cred`);
}

function requireRef(ref: string): void {
  if (ref.trim().length === 0) {
    throw new Error("credential reference must be a non-empty string");
  }
}

export function createOsKeystoreCredentialStore(
  options: OsKeystoreOptions = {},
): CredentialStore {
  const directory = options.directory ?? defaultOsKeystoreDirectory();
  return {
    async readSecret(ref: string): Promise<string | null> {
      requireRef(ref);
      try {
        return await readFile(keyFile(directory, ref), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw new Error(`credential store read failed for reference '${ref}'`);
      }
    },
    async writeSecret(ref: string, value: string): Promise<void> {
      requireRef(ref);
      if (value.length === 0) {
        throw new Error(`credential store write failed for reference '${ref}'`);
      }
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(keyFile(directory, ref), value, { mode: 0o600 });
      } catch {
        throw new Error(`credential store write failed for reference '${ref}'`);
      }
    },
    async deleteSecret(ref: string): Promise<void> {
      requireRef(ref);
      try {
        await rm(keyFile(directory, ref), { force: true });
      } catch {
        throw new Error(`credential store delete failed for reference '${ref}'`);
      }
    },
  };
}
