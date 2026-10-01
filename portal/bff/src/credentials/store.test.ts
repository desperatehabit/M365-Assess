import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CREDENTIAL_STORE_DIR_ENV,
  createInMemoryCredentialStore,
  createOsKeystoreCredentialStore,
  defaultOsKeystoreDirectory,
  formatSecretRef,
  formatThumbprintRef,
  type CredentialStore,
} from "./store.js";

const SECRET = "super-secret-client-value-9f8e7d6c5b4a";
const REF = "ref://tenants/tenant-a/credential/00000000-0000-0000-0000-000000000001";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "credential-store-"));
  dirs.push(dir);
  return dir;
}

// Every backend must satisfy the same contract, so both run these cases.
function storeContract(name: string, make: () => CredentialStore): void {
  describe(`${name} credential store contract`, () => {
    it("returns null for a reference it does not hold", async () => {
      await expect(make().readSecret(REF)).resolves.toBeNull();
    });

    it("round-trips material by reference and forgets it on delete", async () => {
      const store = make();
      await store.writeSecret(REF, SECRET);
      await expect(store.readSecret(REF)).resolves.toBe(SECRET);
      await store.deleteSecret(REF);
      await expect(store.readSecret(REF)).resolves.toBeNull();
    });

    it("overwrites material on rotation", async () => {
      const store = make();
      await store.writeSecret(REF, SECRET);
      await store.writeSecret(REF, `${SECRET}-rotated`);
      await expect(store.readSecret(REF)).resolves.toBe(`${SECRET}-rotated`);
    });
  });
}

storeContract("in-memory", () => createInMemoryCredentialStore());
storeContract("os-keystore", () => createOsKeystoreCredentialStore({ directory: tempDir() }));

describe("os-keystore validation (T-0827)", () => {
  it("rejects an empty reference", async () => {
    const store = createOsKeystoreCredentialStore({ directory: tempDir() });
    await expect(store.readSecret("  ")).rejects.toThrow(/reference/);
    await expect(store.writeSecret("", SECRET)).rejects.toThrow(/reference/);
    await expect(store.deleteSecret("")).rejects.toThrow(/reference/);
  });

  it("rejects an empty value", async () => {
    await expect(createOsKeystoreCredentialStore({ directory: tempDir() }).writeSecret(REF, "")).rejects.toThrow();
  });
});

describe("os-keystore persistence (T-0827)", () => {
  it("survives a new store instance over the same directory", async () => {
    const directory = tempDir();
    await createOsKeystoreCredentialStore({ directory }).writeSecret(REF, SECRET);
    await expect(createOsKeystoreCredentialStore({ directory }).readSecret(REF)).resolves.toBe(SECRET);
  });

  it("keeps each reference in its own owner-only file", async () => {
    const directory = tempDir();
    const store = createOsKeystoreCredentialStore({ directory });
    const otherRef = "ref://tenants/tenant-b/credential/2";
    await store.writeSecret(REF, SECRET);
    await store.writeSecret(otherRef, `${SECRET}-b`);
    const files = [REF, otherRef].map((ref) => join(directory, keyFileName(ref)));
    if (process.platform !== "win32") {
      for (const file of files) expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    await expect(store.readSecret(REF)).resolves.toBe(SECRET);
    await expect(store.readSecret(otherRef)).resolves.toBe(`${SECRET}-b`);
  });

  it("names key files by hash, never by the reference", async () => {
    const directory = tempDir();
    await createOsKeystoreCredentialStore({ directory }).writeSecret(REF, SECRET);
    expect(readdirSync(directory)).toEqual([keyFileName(REF)]);
  });

  it("names the reference, never the value, in a read error", async () => {
    const blocker = join(tempDir(), "not-a-directory");
    writeFileSync(blocker, "x");
    const store = createOsKeystoreCredentialStore({ directory: blocker });
    const message = await store.readSecret(REF).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(message).toContain(REF);
    expect(message).not.toContain(SECRET);
  });
});

describe("reference formatting", () => {
  it("mints a secret reference under the tenant and a thumbprint reference", () => {
    expect(formatSecretRef("tenant-a")).toMatch(/^ref:\/\/tenants\/tenant-a\/credential\//);
    expect(formatThumbprintRef(" AA11BB ")).toBe("cert://thumbprint/aa11bb");
  });
});

describe("default os-keystore directory", () => {
  it("honours the shared directory override and trims it", () => {
    expect(defaultOsKeystoreDirectory({ [CREDENTIAL_STORE_DIR_ENV]: "  /var/lib/creds  " })).toBe(
      "/var/lib/creds",
    );
  });

  it("falls back to a per-user directory when unset", () => {
    expect(defaultOsKeystoreDirectory({})).toContain(".m365-assess");
  });
});

function keyFileName(ref: string): string {
  return `${createHash("sha256").update(ref).digest("hex")}.cred`;
}
