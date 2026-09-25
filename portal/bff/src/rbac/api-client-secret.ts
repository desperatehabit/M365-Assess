// API client secrets are generated server-side, shown to the caller exactly
// once, and persisted only as a salted scrypt hash (EPIC-038 SPEC §5, §9).
// Nothing in this module logs or returns a plaintext secret.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SECRET_BYTES = 32;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_ALGORITHM = "scrypt";
const SECRET_PREFIX = "m365_";

export function generateApiClientSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

export function hashApiClientSecret(secret: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(secret, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    HASH_ALGORITHM,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

interface ParsedHash {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6) {
    return null;
  }
  const [algorithm, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  if (
    algorithm !== HASH_ALGORITHM ||
    rawN === undefined ||
    rawR === undefined ||
    rawP === undefined ||
    rawSalt === undefined ||
    rawKey === undefined
  ) {
    return null;
  }
  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n < 2 ||
    r < 1 ||
    p < 1
  ) {
    return null;
  }
  const salt = Buffer.from(rawSalt, "base64url");
  const key = Buffer.from(rawKey, "base64url");
  if (salt.length === 0 || key.length === 0) {
    return null;
  }
  return { n, r, p, salt, key };
}

export function verifyApiClientSecret(secret: string, storedHash: string): boolean {
  const parsed = parseHash(storedHash);
  if (parsed === null) {
    return false;
  }
  let derived: Buffer;
  try {
    derived = scryptSync(secret, parsed.salt, parsed.key.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
    });
  } catch {
    return false;
  }
  if (derived.length !== parsed.key.length) {
    return false;
  }
  return timingSafeEqual(derived, parsed.key);
}
