// T-0667 — scheduled DNS change detection: MX/SPF/DKIM/DMARC changes against
// the prior DomainCheck produce change events; an unchanged domain (and a first
// run with no prior check) produces none.

import { describe, expect, it } from "vitest";
import {
  DNS_CHANGE_FAMILIES,
  detectDnsChanges,
  type DnsChangeEvent,
} from "./dns-change-detect.js";

const PRIOR = {
  mx: ["contoso-com.mail.protection.outlook.com"],
  spf: "v=spf1 include:spf.protection.outlook.com -all",
  dkim: { selector1: "selector1-contoso-com._domainkey.contoso.onmicrosoft.com" },
  dmarc: "v=DMARC1; p=reject; rua=mailto:dmarc@contoso.com",
};

function families(events: readonly DnsChangeEvent[]): string[] {
  return events.map((event) => event.family);
}

describe("detectDnsChanges (T-0667)", () => {
  it("emits an MX change when the mail target moves", () => {
    const result = detectDnsChanges(PRIOR, {
      ...PRIOR,
      mx: ["contoso-com.mail.protection.outlook.com", "backup.mail.example.com"],
    });

    expect(result.changed).toBe(true);
    expect(families(result.events)).toEqual(["MX"]);
    expect(result.events[0]!.kind).toBe("changed");
    expect(result.events[0]!.summary).toBe("MX changed");
    expect(result.events[0]!.after).toEqual([
      "contoso-com.mail.protection.outlook.com",
      "backup.mail.example.com",
    ]);
  });

  it("emits an SPF change when the policy moves", () => {
    const result = detectDnsChanges(PRIOR, {
      ...PRIOR,
      spf: "v=spf1 include:spf.protection.outlook.com ~all",
    });

    expect(result.changed).toBe(true);
    expect(families(result.events)).toEqual(["SPF"]);
    expect(result.events[0]!.kind).toBe("changed");
  });

  it("emits a DMARC change when the policy moves", () => {
    const result = detectDnsChanges(PRIOR, {
      ...PRIOR,
      dmarc: "v=DMARC1; p=none; rua=mailto:dmarc@contoso.com",
    });

    expect(result.changed).toBe(true);
    expect(families(result.events)).toEqual(["DMARC"]);
    expect(result.events[0]!.before).toContain("p=reject");
    expect(result.events[0]!.after).toContain("p=none");
  });

  it("emits a DKIM change when a selector appears or disappears", () => {
    const result = detectDnsChanges(PRIOR, {
      ...PRIOR,
      dkim: {
        selector1: "selector1-contoso-com._domainkey.contoso.onmicrosoft.com",
        selector2: "selector2-contoso-com._domainkey.contoso.onmicrosoft.com",
      },
    });

    expect(result.changed).toBe(true);
    expect(families(result.events)).toEqual(["DKIM"]);
    expect(result.events[0]!.kind).toBe("changed");
  });

  it("classifies an added and a removed family", () => {
    const added = detectDnsChanges({ spf: PRIOR.spf }, { ...PRIOR });
    expect(added.events.map((event) => `${event.family}:${event.kind}`).sort()).toEqual([
      "DKIM:added",
      "DMARC:added",
      "MX:added",
    ]);

    const removed = detectDnsChanges(PRIOR, { spf: PRIOR.spf });
    expect(removed.events.map((event) => `${event.family}:${event.kind}`).sort()).toEqual([
      "DKIM:removed",
      "DMARC:removed",
      "MX:removed",
    ]);
  });

  it("treats a reordered MX/DKIM set and key order as unchanged", () => {
    const reordered = detectDnsChanges(
      { mx: ["a.mail.example.com", "b.mail.example.com"], dkim: { a: "x", b: "y" } },
      { mx: ["b.mail.example.com", "a.mail.example.com"], dkim: { b: "y", a: "x" } },
    );

    expect(reordered.changed).toBe(false);
    expect(reordered.events).toEqual([]);
  });

  it("emits nothing when the records are unchanged", () => {
    const result = detectDnsChanges(PRIOR, { ...PRIOR });

    expect(result.changed).toBe(false);
    expect(result.events).toEqual([]);
  });

  it("emits nothing on a first run with no prior check", () => {
    const result = detectDnsChanges(null, { ...PRIOR });

    expect(result.changed).toBe(false);
    expect(result.events).toEqual([]);
  });

  it("matches family keys case-insensitively", () => {
    const result = detectDnsChanges(
      { MX: ["old.mail.example.com"], SPF: "v=spf1 -all", DMARC: "v=DMARC1; p=none" },
      { mx: ["new.mail.example.com"], spf: "v=spf1 -all", dmarc: "v=DMARC1; p=none" },
    );

    expect(families(result.events)).toEqual(["MX"]);
    expect(result.events[0]!.kind).toBe("changed");
  });

  it("publishes the four classified families", () => {
    expect(DNS_CHANGE_FAMILIES).toEqual(["MX", "SPF", "DKIM", "DMARC"]);
  });
});
