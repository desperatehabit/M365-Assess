// T-0912: the nav must not lead to pages whose API calls the BFF does not serve.
import { describe, expect, it } from "vitest";
import { NAV_GROUPS, PARKED_NAV_ITEMS } from "./AppNav";

const navHrefs = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));

describe("AppNav parked pages (T-0912)", () => {
  it("parks exactly the three EPIC-041 pages", () => {
    expect(PARKED_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/copilot/settings",
      "/copilot/shadow-ai",
      "/integrations",
    ]);
  });

  it("keeps parked pages out of the nav", () => {
    for (const { href } of PARKED_NAV_ITEMS) {
      expect(navHrefs).not.toContain(href);
    }
    expect(navHrefs.some((href) => href.startsWith("/copilot"))).toBe(false);
  });

  it("keeps the rest of Platform admin in place", () => {
    const platform = NAV_GROUPS.find((group) => group.label === "Platform admin");
    expect(platform?.items.at(-1)?.href).toBe("/tools/app-approval");
  });
});
