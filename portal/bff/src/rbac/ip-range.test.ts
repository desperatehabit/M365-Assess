import { describe, expect, it } from "vitest";
import { isIpAllowed, isIpInRange } from "./ip-range.js";

describe("isIpInRange Any", () => {
  it("matches any IPv4 and IPv6 address", () => {
    expect(isIpInRange("10.0.0.5", "Any")).toBe(true);
    expect(isIpInRange("2001:db8::5", "Any")).toBe(true);
  });

  it("matches case-insensitively with surrounding whitespace", () => {
    expect(isIpInRange("10.0.0.5", "any")).toBe(true);
    expect(isIpInRange("10.0.0.5", "  ANY  ")).toBe(true);
  });
});

describe("isIpInRange IPv4 CIDR", () => {
  it("contains addresses inside the range and rejects those outside", () => {
    expect(isIpInRange("10.0.0.5", "10.0.0.0/24")).toBe(true);
    expect(isIpInRange("10.0.0.254", "10.0.0.0/24")).toBe(true);
    expect(isIpInRange("10.0.1.5", "10.0.0.0/24")).toBe(false);
    expect(isIpInRange("11.0.0.5", "10.0.0.0/24")).toBe(false);
  });

  it("respects /16 boundaries", () => {
    expect(isIpInRange("192.168.255.255", "192.168.0.0/16")).toBe(true);
    expect(isIpInRange("192.169.0.0", "192.168.0.0/16")).toBe(false);
  });

  it("treats /32 as a single host and /0 as the whole family", () => {
    expect(isIpInRange("10.0.0.5", "10.0.0.5/32")).toBe(true);
    expect(isIpInRange("10.0.0.6", "10.0.0.5/32")).toBe(false);
    expect(isIpInRange("203.0.113.9", "0.0.0.0/0")).toBe(true);
    expect(isIpInRange("2001:db8::1", "0.0.0.0/0")).toBe(false);
  });

  it("treats a bare IP as an exact match", () => {
    expect(isIpInRange("10.0.0.5", "10.0.0.5")).toBe(true);
    expect(isIpInRange("10.0.0.6", "10.0.0.5")).toBe(false);
  });
});

describe("isIpInRange IPv6 CIDR", () => {
  it("contains addresses inside the range and rejects those outside", () => {
    expect(isIpInRange("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(isIpInRange("2001:db8:ffff::9", "2001:db8::/32")).toBe(true);
    expect(isIpInRange("2001:db9::1", "2001:db8::/32")).toBe(false);
  });

  it("matches compressed and expanded forms of the same address", () => {
    expect(isIpInRange("2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::/32")).toBe(
      true,
    );
    expect(isIpInRange("::1", "::1/128")).toBe(true);
    expect(isIpInRange("::2", "::1/128")).toBe(false);
  });

  it("matches embedded IPv4 forms", () => {
    expect(isIpInRange("::ffff:10.0.0.1", "::ffff:10.0.0.1")).toBe(true);
    expect(isIpInRange("::ffff:10.0.0.2", "::ffff:10.0.0.1")).toBe(false);
  });

  it("ignores a zone id on the address", () => {
    expect(isIpInRange("fe80::1%eth0", "fe80::/10")).toBe(true);
  });

  it("never matches across families", () => {
    expect(isIpInRange("10.0.0.5", "2001:db8::/32")).toBe(false);
    expect(isIpInRange("2001:db8::1", "10.0.0.0/8")).toBe(false);
  });
});

describe("isIpInRange malformed input", () => {
  it("fails closed on unparseable addresses and ranges", () => {
    expect(isIpInRange("not-an-ip", "10.0.0.0/24")).toBe(false);
    expect(isIpInRange("10.0.0.5", "not-a-range")).toBe(false);
    expect(isIpInRange("10.0.0.5", "10.0.0.256/24")).toBe(false);
    expect(isIpInRange("10.0.0.5", "10.0.0.0/33")).toBe(false);
    expect(isIpInRange("2001:db8::1", "2001:db8::/129")).toBe(false);
    expect(isIpInRange("", "Any")).toBe(true);
    expect(isIpInRange("", "10.0.0.0/24")).toBe(false);
  });
});

describe("isIpAllowed", () => {
  it("matches any entry of a CIDR list", () => {
    const ranges = ["10.0.0.0/24", "192.168.0.0/16"];
    expect(isIpAllowed("192.168.4.4", ranges)).toBe(true);
    expect(isIpAllowed("172.16.0.1", ranges)).toBe(false);
  });

  it("mixes IPv4 and IPv6 entries", () => {
    const ranges = ["10.0.0.0/24", "2001:db8::/32"];
    expect(isIpAllowed("10.0.0.9", ranges)).toBe(true);
    expect(isIpAllowed("2001:db8::9", ranges)).toBe(true);
    expect(isIpAllowed("172.16.0.1", ranges)).toBe(false);
  });

  it("denies when the list is empty or entirely unparseable", () => {
    expect(isIpAllowed("10.0.0.5", [])).toBe(false);
    expect(isIpAllowed("10.0.0.5", ["bogus"])).toBe(false);
  });
});
