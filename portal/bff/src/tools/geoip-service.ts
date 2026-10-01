// GeoIP lookup service (EPIC-040 SPEC §3.5, §6; T-0787).
// Offline v1: answers from a small embedded IP-range database, so the portal
// needs no external paid GeoIP API. Lookups are cached in memory; the service
// is read-only and has no tenant write path.

export interface GeoIpRecord {
  readonly network: string;
  readonly country: string;
  readonly countryName: string;
  readonly region: string;
  readonly city: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly isp: string;
  readonly organization: string;
}

export interface GeoIpLookupResult {
  readonly ip: string;
  readonly version: 4 | 6;
  readonly country: string;
  readonly countryName: string;
  readonly region: string;
  readonly city: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly isp: string;
  readonly organization: string;
  readonly source: "database" | "cache";
}

export class GeoIpInvalidAddressError extends Error {
  readonly code = "geoip.invalid_address";
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "GeoIpInvalidAddressError";
  }
}

export class GeoIpNotFoundError extends Error {
  readonly code = "geoip.not_found";
  readonly status = 404;

  constructor(message: string) {
    super(message);
    this.name = "GeoIpNotFoundError";
  }
}

export interface GeoIpService {
  lookup(ip: string): Promise<GeoIpLookupResult>;
}

export interface GeoIpServiceOptions {
  readonly database?: readonly GeoIpRecord[];
}

interface ParsedIp {
  readonly version: 4 | 6;
  readonly value: bigint;
}

interface ParsedNetwork {
  readonly value: bigint;
  readonly prefixBits: number;
}

const PRIVATE_NETWORK: Omit<GeoIpRecord, "network"> = {
  country: "ZZ",
  countryName: "Private Network",
  region: "",
  city: "",
  latitude: 0,
  longitude: 0,
  isp: "Private network (RFC 1918)",
  organization: "Private network",
};

const RESERVED_NETWORK: Omit<GeoIpRecord, "network"> = {
  country: "ZZ",
  countryName: "Reserved",
  region: "",
  city: "",
  latitude: 0,
  longitude: 0,
  isp: "Reserved range",
  organization: "Reserved range",
};

// Embedded offline database: well-known public DNS anycast ranges, RFC 5737
// documentation ranges, RFC 1918 private space, and other reserved blocks.
// Replace with a full offline database dump when one is licensed.
const GEOIP_DATABASE: readonly GeoIpRecord[] = Object.freeze([
  { network: "8.8.8.0/24", country: "US", countryName: "United States", region: "CA", city: "Mountain View", latitude: 37.422, longitude: -122.0841, isp: "Google LLC", organization: "Google Public DNS" },
  { network: "8.8.4.0/24", country: "US", countryName: "United States", region: "CA", city: "Mountain View", latitude: 37.422, longitude: -122.0841, isp: "Google LLC", organization: "Google Public DNS" },
  { network: "1.1.1.0/24", country: "US", countryName: "United States", region: "CA", city: "San Francisco", latitude: 37.7749, longitude: -122.4194, isp: "Cloudflare, Inc.", organization: "Cloudflare DNS" },
  { network: "1.0.0.0/24", country: "US", countryName: "United States", region: "CA", city: "San Francisco", latitude: 37.7749, longitude: -122.4194, isp: "Cloudflare, Inc.", organization: "Cloudflare DNS" },
  { network: "208.67.222.0/24", country: "US", countryName: "United States", region: "CA", city: "San Francisco", latitude: 37.7749, longitude: -122.4194, isp: "Cisco Systems, Inc.", organization: "OpenDNS" },
  { network: "208.67.220.0/24", country: "US", countryName: "United States", region: "CA", city: "San Francisco", latitude: 37.7749, longitude: -122.4194, isp: "Cisco Systems, Inc.", organization: "OpenDNS" },
  { network: "9.9.9.0/24", country: "US", countryName: "United States", region: "CA", city: "Berkeley", latitude: 37.8716, longitude: -122.2727, isp: "Quad9 Foundation", organization: "Quad9 DNS" },
  { network: "149.112.112.0/24", country: "US", countryName: "United States", region: "CA", city: "Berkeley", latitude: 37.8716, longitude: -122.2727, isp: "Quad9 Foundation", organization: "Quad9 DNS" },
  { network: "185.228.168.0/24", country: "US", countryName: "United States", region: "CA", city: "San Francisco", latitude: 37.7749, longitude: -122.4194, isp: "CleanBrowsing", organization: "CleanBrowsing" },
  { network: "94.140.14.0/24", country: "CY", countryName: "Cyprus", region: "", city: "Nicosia", latitude: 35.1856, longitude: 33.3823, isp: "AdGuard Software Limited", organization: "AdGuard DNS" },
  { network: "76.76.2.0/24", country: "US", countryName: "United States", region: "CA", city: "San Francisco", latitude: 37.7749, longitude: -122.4194, isp: "Alternate DNS", organization: "Alternate DNS" },
  { network: "76.76.19.0/24", country: "US", countryName: "United States", region: "CA", city: "San Francisco", latitude: 37.7749, longitude: -122.4194, isp: "Alternate DNS", organization: "Alternate DNS" },
  { network: "192.0.2.0/24", country: "ZZ", countryName: "Reserved (documentation)", region: "", city: "", latitude: 0, longitude: 0, isp: "RFC 5737 TEST-NET-1", organization: "Reserved (documentation)" },
  { network: "198.51.100.0/24", country: "ZZ", countryName: "Reserved (documentation)", region: "", city: "", latitude: 0, longitude: 0, isp: "RFC 5737 TEST-NET-2", organization: "Reserved (documentation)" },
  { network: "203.0.113.0/24", country: "ZZ", countryName: "Reserved (documentation)", region: "", city: "", latitude: 0, longitude: 0, isp: "RFC 5737 TEST-NET-3", organization: "Reserved (documentation)" },
  { network: "10.0.0.0/8", ...PRIVATE_NETWORK },
  { network: "172.16.0.0/12", ...PRIVATE_NETWORK },
  { network: "192.168.0.0/16", ...PRIVATE_NETWORK },
  { network: "127.0.0.0/8", country: "ZZ", countryName: "Loopback", region: "", city: "", latitude: 0, longitude: 0, isp: "Loopback", organization: "Loopback" },
  { network: "169.254.0.0/16", country: "ZZ", countryName: "Link-Local", region: "", city: "", latitude: 0, longitude: 0, isp: "Link-local (APIPA)", organization: "Link-local" },
  { network: "224.0.0.0/4", country: "ZZ", countryName: "Multicast", region: "", city: "", latitude: 0, longitude: 0, isp: "Multicast", organization: "Multicast" },
  { network: "240.0.0.0/4", ...RESERVED_NETWORK },
  { network: "::1/128", country: "ZZ", countryName: "Loopback", region: "", city: "", latitude: 0, longitude: 0, isp: "Loopback", organization: "Loopback" },
  { network: "2001:4860:4860::/48", country: "US", countryName: "United States", region: "CA", city: "Mountain View", latitude: 37.422, longitude: -122.0841, isp: "Google LLC", organization: "Google Public DNS" },
  { network: "2606:4700:4700::/48", country: "US", countryName: "United States", region: "CA", city: "San Francisco", latitude: 37.7749, longitude: -122.4194, isp: "Cloudflare, Inc.", organization: "Cloudflare DNS" },
  { network: "2001:db8::/32", country: "ZZ", countryName: "Reserved (documentation)", region: "", city: "", latitude: 0, longitude: 0, isp: "RFC 3849 documentation", organization: "Reserved (documentation)" },
  { network: "fc00::/7", ...PRIVATE_NETWORK },
  { network: "fe80::/10", country: "ZZ", countryName: "Link-Local", region: "", city: "", latitude: 0, longitude: 0, isp: "Link-local", organization: "Link-local" },
  { network: "ff00::/8", country: "ZZ", countryName: "Multicast", region: "", city: "", latitude: 0, longitude: 0, isp: "Multicast", organization: "Multicast" },
]);

export function parseIpAddress(input: string): ParsedIp | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const ipv4 = parseIpv4(trimmed);
  if (ipv4 !== null) return ipv4;
  return parseIpv6(trimmed);
}

function parseIpv4(input: string): ParsedIp | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return { version: 4, value };
}

function parseIpv6(input: string): ParsedIp | null {
  let text = input;
  let embeddedIpv4: bigint | null = null;
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    const parsed = parseIpv4(text.slice(lastColon + 1));
    if (parsed === null) return null;
    embeddedIpv4 = parsed.value;
    text = `${text.slice(0, lastColon)}:0:0`;
  }

  const parts = text.split("::");
  if (parts.length > 2) return null;

  const parseGroups = (value: string): number[] | null => {
    if (value === "") return [];
    const groups: number[] = [];
    for (const group of value.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  const head = parseGroups(parts[0]!);
  if (head === null) return null;
  const tail = parts.length === 2 ? parseGroups(parts[1]!) : [];
  if (tail === null) return null;

  let hextets: number[];
  if (parts.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    hextets = [...head, ...Array.from({ length: missing }, () => 0), ...tail];
  } else {
    if (head.length !== 8) return null;
    hextets = head;
  }

  if (embeddedIpv4 !== null) {
    if (hextets.length !== 8) return null;
    hextets = [
      ...hextets.slice(0, 6),
      Number((embeddedIpv4 >> 16n) & 0xffffn),
      Number(embeddedIpv4 & 0xffffn),
    ];
  }

  let value = 0n;
  for (const hextet of hextets) value = (value << 16n) | BigInt(hextet);
  return { version: 6, value };
}

function parseNetwork(network: string): ParsedNetwork | null {
  const [cidr, prefixText] = network.split("/");
  if (cidr === undefined || prefixText === undefined) return null;
  const prefixBits = Number(prefixText);
  if (!Number.isInteger(prefixBits) || prefixBits < 0) return null;
  const parsed = parseIpAddress(cidr);
  if (parsed === null) return null;
  const maxBits = parsed.version === 6 ? 128 : 32;
  if (prefixBits > maxBits) return null;
  return { value: parsed.value, prefixBits };
}

function networkContains(record: GeoIpRecord, parsed: ParsedIp): boolean {
  const network = parseNetwork(record.network);
  if (network === null) return false;
  if (network.prefixBits === 0) return true;
  const totalBits = parsed.version === 6 ? 128 : 32;
  const shift = BigInt(totalBits - network.prefixBits);
  return parsed.value >> shift === network.value >> shift;
}

export function createGeoIpService(options: GeoIpServiceOptions = {}): GeoIpService {
  const database = options.database ?? GEOIP_DATABASE;
  const cache = new Map<string, GeoIpLookupResult>();

  return {
    async lookup(ip: string): Promise<GeoIpLookupResult> {
      const key = ip.trim().toLowerCase();
      const cached = cache.get(key);
      if (cached !== undefined) {
        return { ...cached, source: "cache" };
      }

      const parsed = parseIpAddress(key);
      if (parsed === null) {
        throw new GeoIpInvalidAddressError(`invalid IP address: ${key}`);
      }

      const record = database.find((entry) => networkContains(entry, parsed));
      if (record === undefined) {
        throw new GeoIpNotFoundError(`no GeoIP record for ${key} in the offline database`);
      }

      const result: GeoIpLookupResult = {
        ip: key,
        version: parsed.version,
        country: record.country,
        countryName: record.countryName,
        region: record.region,
        city: record.city,
        latitude: record.latitude,
        longitude: record.longitude,
        isp: record.isp,
        organization: record.organization,
        source: "database",
      };
      cache.set(key, result);
      return result;
    },
  };
}
