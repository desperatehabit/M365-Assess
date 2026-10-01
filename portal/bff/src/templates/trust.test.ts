// T-0764 — Community template trust model (EPIC-039 SPEC.md §9, §11).
import { describe, expect, it } from "vitest";
import { openSqliteTemplateRepository } from "@m365-assess/db";
import {
  TEMPLATE_BUNDLE_UNTRUSTED,
  TEMPLATE_BUNDLE_UNVERIFIED,
  assertBundleCloneable,
  assertRepoBrowsable,
  authorFromSource,
  describeBundleTrust,
  isBundleVerified,
  type BundleTrust,
} from "./trust.js";
import {
  TemplateRepoService,
  TEMPLATE_REPO_NOT_FOUND,
  type RepoTemplate,
} from "./repo-service.js";

function recordingAudit(): {
  audit: (event: Record<string, unknown>) => Promise<void>;
  events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    audit: async (event) => {
      events.push(event);
    },
  };
}

async function serviceWithFetcher(templates: readonly RepoTemplate[]) {
  const { audit, events } = recordingAudit();
  const repos = await openSqliteTemplateRepository({ filename: ":memory:" });
  const service = new TemplateRepoService({
    repos,
    audit,
    fetchTemplates: async () => templates,
  });
  return { service, repos, events };
}

function trust(overrides: Partial<BundleTrust> = {}): BundleTrust {
  return { signed: false, reviewState: "unreviewed", trusted: true, ...overrides };
}

describe("bundle verification", () => {
  it("only treats a signed, fully reviewed bundle as verified", () => {
    expect(isBundleVerified(trust({ signed: true, reviewState: "signed" }))).toBe(true);
    expect(isBundleVerified(trust({ signed: false, reviewState: "signed" }))).toBe(false);
    expect(isBundleVerified(trust({ signed: true, reviewState: "reviewed" }))).toBe(false);
    expect(isBundleVerified(trust({ signed: true, reviewState: "unreviewed" }))).toBe(false);
  });

  it("derives the author from a URL or owner/repo and returns null when unknown", () => {
    expect(authorFromSource("https://github.com/owner/repo")).toBe("owner");
    expect(authorFromSource("https://github.com/owner/repo.git")).toBe("owner");
    expect(authorFromSource("owner/repo")).toBe("owner");
    expect(authorFromSource("https://example.invalid/community")).toBeNull();
    expect(authorFromSource("not a url")).toBeNull();
  });

  it("describes the source, author, and review state for the badge", () => {
    expect(
      describeBundleTrust({
        url: "https://github.com/owner/repo",
        signed: true,
        reviewState: "signed",
        trusted: true,
      }),
    ).toEqual({
      source: "https://github.com/owner/repo",
      author: "owner",
      reviewState: "signed",
      signed: true,
      trusted: true,
      verified: true,
    });
  });

  it("rejects browsing a repo that is not opted in with a structured error", () => {
    expect(() => assertRepoBrowsable(trust({ trusted: false }))).toThrowError(
      expect.objectContaining({
        code: TEMPLATE_BUNDLE_UNTRUSTED,
        status: 403,
        details: [{ field: "trusted", reason: "opt_in_required" }],
      }) as Error,
    );
  });

  it("refuses to clone an unverified bundle with a structured error", () => {
    expect(() =>
      assertBundleCloneable(trust({ signed: false, reviewState: "unreviewed" })),
    ).toThrowError(
      expect.objectContaining({
        code: TEMPLATE_BUNDLE_UNVERIFIED,
        status: 422,
        details: [
          { field: "reviewState", reason: "unverified", reviewState: "unreviewed", signed: false },
        ],
      }) as Error,
    );
  });

  it("refuses to clone a repo that is not opted in", () => {
    expect(() => assertBundleCloneable(trust({ trusted: false }))).toThrowError(
      expect.objectContaining({ code: TEMPLATE_BUNDLE_UNTRUSTED, status: 403 }) as Error,
    );
  });

  it("allows a verified bundle, and an explicit admin override bypasses the gate", () => {
    expect(() =>
      assertBundleCloneable(trust({ signed: true, reviewState: "signed" })),
    ).not.toThrow();
    expect(() =>
      assertBundleCloneable(trust({ trusted: false, signed: false }), { allowUnverified: true }),
    ).not.toThrow();
  });
});

describe("TemplateRepoService trust (T-0764)", () => {
  it("records the admin opt-in decision in the add AuditEvent", async () => {
    const { service, repos, events } = await serviceWithFetcher([
      { name: "Baseline CA", type: "conditional-access", body: "{}" },
    ]);
    try {
      const repo = await service.addRepo(
        { ref: "owner/repo", types: ["conditional-access"] },
        { actorUserId: "user-1", correlationId: "corr-1" },
      );

      expect(repo.trusted).toBe(true);
      expect(repo.reviewState).toBe("unreviewed");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "template.repo.add",
        actorUserId: "user-1",
        targetId: repo.id,
      });
      expect(events[0]["after"]).toMatchObject({
        trusted: true,
        signed: false,
        reviewState: "unreviewed",
      });
    } finally {
      repos.close();
    }
  });

  it("hides a repo added without the opt-in and refuses to browse its templates", async () => {
    const { service, repos } = await serviceWithFetcher([
      { name: "Baseline CA", type: "conditional-access", body: "{}" },
    ]);
    try {
      const repo = await service.addRepo({
        ref: "owner/repo",
        types: ["conditional-access"],
        trusted: false,
      });

      expect(repo.trusted).toBe(false);
      expect(await service.listRepos()).toEqual([]);
      await expect(service.getRepoTemplates(repo.id)).rejects.toMatchObject({
        code: TEMPLATE_BUNDLE_UNTRUSTED,
        status: 403,
      });
    } finally {
      repos.close();
    }
  });

  it("refuses to clone an opted-in but unverified repo, and allows an override", async () => {
    const { service, repos } = await serviceWithFetcher([]);
    try {
      const repo = await service.addRepo({ ref: "owner/repo", types: ["standards"] });

      await expect(service.assertCloneable(repo.id)).rejects.toMatchObject({
        code: TEMPLATE_BUNDLE_UNVERIFIED,
        status: 422,
      });
      await expect(
        service.assertCloneable(repo.id, { allowUnverified: true }),
      ).resolves.toMatchObject({ id: repo.id });
    } finally {
      repos.close();
    }
  });

  it("clones a signed, reviewed repo and surfaces its source/author/review", async () => {
    const { service, repos } = await serviceWithFetcher([]);
    try {
      const repo = await service.addRepo({
        ref: "owner/repo",
        types: ["standards"],
        signed: true,
        reviewState: "signed",
      });

      await expect(service.assertCloneable(repo.id)).resolves.toMatchObject({ id: repo.id });

      const views = await service.listRepoTrust();
      expect(views).toEqual([
        {
          source: "https://github.com/owner/repo",
          author: "owner",
          reviewState: "signed",
          signed: true,
          trusted: true,
          verified: true,
        },
      ]);
    } finally {
      repos.close();
    }
  });

  it("404s the clone gate for an unknown repo", async () => {
    const { service, repos } = await serviceWithFetcher([]);
    try {
      await expect(service.assertCloneable("repo-missing")).rejects.toMatchObject({
        code: TEMPLATE_REPO_NOT_FOUND,
        status: 404,
      });
    } finally {
      repos.close();
    }
  });
});
