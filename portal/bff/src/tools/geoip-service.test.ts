import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST } from "../config.js";
import { tenantScope } from "../rbac/scope.js";
import { buildServer, type Route } from "../server.js";
import {
  GeoIpInvalidAddressError,
  GeoIpNotFoundError,
  createGeoIpService,
  parseIpAddress,
  type GeoIpLookupResult,
  type GeoIpRecord,
} from "./geoip-service.js";
import {
  createDomainCheckRoutes,
  createGeoipRoutes,
  DOMAIN_CHECK_PATH,
  DOMAIN_CHECK_UNAVAILABLE,
  GEOIP_INVALID_ADDRESS,
  GEOIP_NOT_FOUND,
  GEOIP_PATH,
  TOOLS_READ_PERMISSION,
} from "./geoip-routes.js";

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(routes: readonly Route[]): Promise<string> {
  const server = buildServer({ routes });
  await new Promise<void>((resolve) => server.listen(0, DEFAULT_HOST, resolve));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://${DEFAULT_HOST}:${port}`;
}

function toolsReadCaller() {
  return {
    roles: ["readonly"],
    tenantScope: tenantScope(["tenant-test"]),
    permissions: [TOOLS_READ_PERMISSION],
  };
}

describe("parseIpAddress", () => {
  it("parses IPv4 into a numeric value", () => {
    const parsed = parseIpAddress("8.8.8.8");
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe(4);
    expect(parsed?.value).toBe(0x08080808n);
  });

  it("parses IPv6, including compressed and embedded-IPv4 forms", () => {
    expect(parseIpAddress("::1")?.value).toBe(1n);
    expect(parseIpAddress("::")?.value).toBe(0n);
    expect(parseIpAddress("2001:4860:4860::8888")?.version).toBe(6);
    expect(parseIpAddress("2001:0db8:0000:0000:0000:0000:0000:0001")?.value).toBe(
      parseIpAddress("2001:db8::1")?.value,
    );
    const mapped = parseIpAddress("::ffff:8.8.8.8");
    expect(mapped?.version).toBe(6);
    expect(mapped?.value).toBe(0x00000000000000000000ffff08080808n);
  });

  it("rejects malformed addresses", () => {
    for (const input of [
      "",
      "   ",
      "not-an-ip",
      "8.8.8",
      "8.8.8.8.8",
      "8.8.8.256",
      "01.2.3.4",
      "1.2.3.4:5",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7:8::",
      "::1:2:3:4:5:6:7:8",
      "1::2::3",
      "gggg::1",
      "12345::",
    ]) {
      expect(parseIpAddress(input), input).toBeNull();
    }
  });
});

describe("GeoIpService lookup", () => {
  it("returns GeoIP fields for a known address from the offline database", async () => {
    const service = createGeoIpService();
    const result = await service.lookup("8.8.8.8");

    expect(result.ip).toBe("8.8.8.8");
    expect(result.version).toBe(4);
    expect(result.country).toBe("US");
    expect(result.countryName).toBe("United States");
    expect(result.city).toBe("Mountain View");
    expect(result.isp).toBe("Google LLC");
    expect(result.organization).toBe("Google Public DNS");
    expect(result.source).toBe("database");
  });

  it("serves repeat lookups from the in-memory cache", async () => {
    const service = createGeoIpService();
    const first = await service.lookup("1.1.1.1");
    const second = await service.lookup("1.1.1.1");

    expect(first.source).toBe("database");
    expect(second.source).toBe("cache");
    expect(second.organization).toBe("Cloudflare DNS");
  });

  it("resolves private, loopback, and documentation ranges without geolocation", async () => {
    const service = createGeoIpService();
    const privateResult = await service.lookup("192.168.1.1");
    expect(privateResult.country).toBe("ZZ");
    expect(privateResult.countryName).toBe("Private Network");

    const loopback = await service.lookup("127.0.0.1");
    expect(loopback.countryName).toBe("Loopback");

    const documentation = await service.lookup("203.0.113.10");
    expect(documentation.isp).toContain("RFC 5737");
  });

  it("resolves IPv6 addresses", async () => {
    const service = createGeoIpService();
    const result = await service.lookup("2001:4860:4860::8888");
    expect(result.version).toBe(6);
    expect(result.organization).toBe("Google Public DNS");
  });

  it("throws a structured invalid-address error for malformed input", async () => {
    const service = createGeoIpService();
    await expect(service.lookup("not-an-ip")).rejects.toMatchObject({
      name: "GeoIpInvalidAddressError",
      code: "geoip.invalid_address",
      status: 400,
    });
    await expect(service.lookup("999.1.1.1")).rejects.toBeInstanceOf(GeoIpInvalidAddressError);
  });

  it("throws a structured not-found error for valid addresses absent from the database", async () => {
    const service = createGeoIpService();
    await expect(service.lookup("4.4.4.4")).rejects.toMatchObject({
      name: "GeoIpNotFoundError",
      code: "geoip.not_found",
      status: 404,
    });
  });

  it("honors an injected database", async () => {
    const entry: GeoIpRecord = {
      network: "203.0.113.0/24",
      country: "ZZ",
      countryName: "Reserved (documentation)",
      region: "",
      city: "",
      latitude: 0,
      longitude: 0,
      isp: "RFC 5737 TEST-NET-3",
      organization: "Reserved (documentation)",
    };
    const service = createGeoIpService({ database: [entry] });
    const result = await service.lookup("203.0.113.9");
    expect(result.organization).toBe("Reserved (documentation)");
    await expect(service.lookup("8.8.8.8")).rejects.toBeInstanceOf(GeoIpNotFoundError);
  });
});

describe("GET /v1/geoip/{ip}", () => {
  it("exposes the route path and method", () => {
    const [route] = createGeoipRoutes({ resolveCaller: () => toolsReadCaller() });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(GEOIP_PATH);
  });

  it("returns GeoIP fields for a valid IP", async () => {
    const baseUrl = await startServer(createGeoipRoutes({ resolveCaller: () => toolsReadCaller() }));

    const response = await fetch(`${baseUrl}/v1/geoip/8.8.8.8`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as GeoIpLookupResult;
    expect(body.ip).toBe("8.8.8.8");
    expect(body.country).toBe("US");
    expect(body.organization).toBe("Google Public DNS");
    expect(body.source).toBe("database");
  });

  it("answers a structured 400 for an invalid IP", async () => {
    const baseUrl = await startServer(createGeoipRoutes({ resolveCaller: () => toolsReadCaller() }));

    const response = await fetch(`${baseUrl}/v1/geoip/not-an-ip`);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { code: string; message: string; correlationId: string };
    expect(body.code).toBe(GEOIP_INVALID_ADDRESS);
    expect(body.message).toContain("invalid IP address");
    expect(body.correlationId).toBeDefined();
  });

  it("answers a structured 404 for a valid IP missing from the database", async () => {
    const baseUrl = await startServer(createGeoipRoutes({ resolveCaller: () => toolsReadCaller() }));

    const response = await fetch(`${baseUrl}/v1/geoip/4.4.4.4`);
    expect(response.status).toBe(404);

    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe(GEOIP_NOT_FOUND);
  });

  it("rejects anonymous requests with 401", async () => {
    const baseUrl = await startServer(createGeoipRoutes({ resolveCaller: () => undefined }));

    const response = await fetch(`${baseUrl}/v1/geoip/8.8.8.8`);
    expect(response.status).toBe(401);
  });

  it("rejects callers lacking tools.read with 403", async () => {
    const baseUrl = await startServer(
      createGeoipRoutes({
        resolveCaller: () => ({
          roles: ["readonly"],
          tenantScope: tenantScope(["tenant-test"]),
          permissions: ["Identity.User.Read"],
        }),
      }),
    );

    const response = await fetch(`${baseUrl}/v1/geoip/8.8.8.8`);
    expect(response.status).toBe(403);
  });

  it("lets an injected authorizer make the access decision", async () => {
    const [route] = createGeoipRoutes({
      resolveCaller: () => toolsReadCaller(),
      authorize: () => {
        throw new Error("denied by test authorizer");
      },
    });

    await expect(
      route.handler({
        correlationId: "corr-1",
        method: "GET",
        path: "/v1/geoip/8.8.8.8",
        params: { ip: "8.8.8.8" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toThrow("denied by test authorizer");
  });
});

describe("GET /v1/domain-check", () => {
  it("exposes the route path and method", () => {
    const [route] = createDomainCheckRoutes({ resolveCaller: () => toolsReadCaller() });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(DOMAIN_CHECK_PATH);
  });

  it("reports a structured not-yet-available error while EPIC-034 is unwired", async () => {
    const baseUrl = await startServer(createDomainCheckRoutes({ resolveCaller: () => toolsReadCaller() }));

    const response = await fetch(`${baseUrl}/v1/domain-check?domain=example.com`);
    expect(response.status).toBe(501);

    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe(DOMAIN_CHECK_UNAVAILABLE);
    expect(body.message).toContain("not yet available");
  });

  it("requires the domain query parameter", async () => {
    const baseUrl = await startServer(createDomainCheckRoutes({ resolveCaller: () => toolsReadCaller() }));

    const response = await fetch(`${baseUrl}/v1/domain-check`);
    expect(response.status).toBe(400);
  });

  it("delegates to the shared EPIC-034 provider once one is wired", async () => {
    const seen: string[] = [];
    const baseUrl = await startServer(
      createDomainCheckRoutes({
        resolveCaller: () => toolsReadCaller(),
        provider: {
          checkDomain: async (domain: string) => {
            seen.push(domain);
            return { domain, checkedAt: "2026-09-29T00:00:00.000Z", records: { mx: 1, spf: 1 } };
          },
        },
      }),
    );

    const response = await fetch(`${baseUrl}/v1/domain-check?domain=example.com`);
    expect(response.status).toBe(200);
    expect(seen).toEqual(["example.com"]);

    const body = (await response.json()) as { domain: string; records: Record<string, number> };
    expect(body.domain).toBe("example.com");
    expect(body.records.mx).toBe(1);
  });

  it("rejects anonymous requests with 401", async () => {
    const baseUrl = await startServer(createDomainCheckRoutes({ resolveCaller: () => undefined }));

    const response = await fetch(`${baseUrl}/v1/domain-check?domain=example.com`);
    expect(response.status).toBe(401);
  });
});
