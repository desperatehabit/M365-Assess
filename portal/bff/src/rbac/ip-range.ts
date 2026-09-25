// IP allow-list matcher for API clients (EPIC-038 SPEC §4.3, §3.3).
// An allow-list entry is `Any` (case-insensitive, matches everything), a plain
// IP address (exact match), or a CIDR range. IPv4 and IPv6 never mix: an entry
// only matches an address of the same family. Anything unparseable matches
// nothing, so a malformed entry fails closed to deny.

const IPV4_BITS = 32;
const IPV6_BITS = 128;

type IpFamily = 4 | 6;

interface ParsedCidr {
  readonly family: IpFamily;
  readonly network: number | bigint;
  readonly prefix: number;
}

function stripZoneId(value: string): string {
  const zone = value.indexOf("%");
  return zone === -1 ? value : value.slice(0, zone);
}

function parseIPv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let result = 0;
  for (const part of parts) {
    if (part === undefined || !/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    result = result * 256 + octet;
  }
  return result;
}

function parseHextets(parts: string[]): bigint[] | null {
  const out: bigint[] = [];
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
      return null;
    }
    out.push(BigInt(`0x${part}`));
  }
  return out;
}

function parseIPv6(text: string): bigint | null {
  const bare = stripZoneId(text).toLowerCase();
  if (!bare.includes(":")) {
    return null;
  }
  let head = bare;
  if (bare.includes(".")) {
    const lastColon = bare.lastIndexOf(":");
    const v4 = parseIPv4(bare.slice(lastColon + 1));
    if (v4 === null) {
      return null;
    }
    head = `${bare.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const compressions = head.split("::");
  if (compressions.length > 2) {
    return null;
  }
  const split = (side: string): string[] => (side === "" ? [] : side.split(":"));
  const leftParts = split(compressions[0] ?? "");
  const rightParts = compressions.length === 2 ? split(compressions[1] ?? "") : [];
  const left = parseHextets(leftParts);
  const right = parseHextets(rightParts);
  if (left === null || right === null) {
    return null;
  }
  if (compressions.length === 2) {
    const fill = 8 - (left.length + right.length);
    if (fill < 0) {
      return null;
    }
    const groups = [...left, ...new Array<bigint>(fill).fill(0n), ...right];
    if (groups.length !== 8) {
      return null;
    }
    return packGroups(groups);
  }
  const groups = [...left, ...right];
  if (groups.length !== 8) {
    return null;
  }
  return packGroups(groups);
}

function packGroups(groups: bigint[]): bigint {
  let result = 0n;
  for (const group of groups) {
    result = (result << 16n) + group;
  }
  return result;
}

function parseAddress(text: string): { family: IpFamily; value: number | bigint } | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.includes(":")) {
    const v6 = parseIPv6(trimmed);
    return v6 === null ? null : { family: 6, value: v6 };
  }
  const v4 = parseIPv4(trimmed);
  return v4 === null ? null : { family: 4, value: v4 };
}

function parseCidrEntry(entry: string): ParsedCidr | "any" | null {
  const trimmed = entry.trim();
  if (trimmed.toLowerCase() === "any") {
    return "any";
  }
  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) {
    const address = parseAddress(trimmed);
    if (address === null) {
      return null;
    }
    return {
      family: address.family,
      network: address.value,
      prefix: address.family === 4 ? IPV4_BITS : IPV6_BITS,
    };
  }
  const address = parseAddress(trimmed.slice(0, slash));
  const rawPrefix = trimmed.slice(slash + 1).trim();
  if (address === null || !/^\d{1,3}$/.test(rawPrefix)) {
    return null;
  }
  const prefix = Number(rawPrefix);
  const width = address.family === 4 ? IPV4_BITS : IPV6_BITS;
  if (prefix > width) {
    return null;
  }
  return { family: address.family, network: address.value, prefix };
}

function networkMatches(address: number | bigint, cidr: ParsedCidr): boolean {
  if (cidr.prefix === 0) {
    return true;
  }
  if (typeof address === "number" && typeof cidr.network === "number") {
    const shift = IPV4_BITS - cidr.prefix;
    return (Math.floor(address / 2 ** shift) === Math.floor(cidr.network / 2 ** shift));
  }
  if (typeof address === "bigint" && typeof cidr.network === "bigint") {
    const shift = BigInt(IPV6_BITS - cidr.prefix);
    return (address >> shift) === (cidr.network >> shift);
  }
  return false;
}

// Analogue of `Test-IpInRange`: true when `ip` falls inside `range`.
// `range` accepts `Any`, a plain IP, or CIDR. Never throws; anything
// unparseable returns false.
export function isIpInRange(ip: string, range: string): boolean {
  const parsed = parseCidrEntry(range);
  if (parsed === null) {
    return false;
  }
  if (parsed === "any") {
    return true;
  }
  const address = parseAddress(ip);
  if (address === null || address.family !== parsed.family) {
    return false;
  }
  return networkMatches(address.value, parsed);
}

// True when `ip` matches at least one entry of the allow-list. An empty or
// entirely unparseable list matches nothing.
export function isIpAllowed(ip: string, ranges: readonly string[]): boolean {
  return ranges.some((range) => isIpInRange(ip, range));
}
