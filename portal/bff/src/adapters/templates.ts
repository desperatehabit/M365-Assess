// EPIC-039 template-library adapters (T-0869).
//
// The template route factories were written against service seams but were
// never mounted. This module binds them to the SQLite template repository and
// bridges the save-to-GitHub commit seam onto the EPIC-041 GitHub adapter.
// Browsing and package import/export need no tenant credential; only the
// optional GitHub commit leaves the portal, and it fails closed until the
// integration row is enabled.
import type {
  IntegrationRepository,
  TemplateLibraryItem,
  TemplateRepository,
} from "@m365-assess/db";
import { AppError } from "../errors.js";
import {
  GITHUB_INTEGRATION_KIND,
  SaveToGitHubErrorCodes,
  type GitHubCommitAdapter,
} from "../templates/save-to-github.js";
import type { GithubAdapter } from "../integrations/github/github-adapter.js";

import {
  TemplateLibraryRepositoryService,
  type TemplateLibraryService,
} from "../templates/library-service.js";
import {
  TemplateRepoService,
  type RepoTemplateFetcher,
} from "../templates/repo-service.js";
import {
  TemplateLibraryCloneService,
  type ClonePlanBuilders,
} from "../templates/clone-service.js";
import { createTemplatePackageService, type TemplatePackageService } from "../templates/package-service.js";
import {
  SaveToGitHubService,
  type SaveToGitHubTemplateReader,
} from "../templates/save-to-github.js";

export interface TemplateServiceOptions {
  readonly repository: TemplateRepository;
  readonly integrations: IntegrationRepository;
  readonly github?: GithubAdapter;
  readonly audit?: (event: Record<string, unknown>) => Promise<void>;
  readonly fetchTemplates?: RepoTemplateFetcher;
  readonly cloneBuilders?: ClonePlanBuilders;
}

export interface TemplateServices {
  readonly library: TemplateLibraryService;
  readonly repos: TemplateRepoService;
  readonly clone: TemplateLibraryCloneService;
  readonly packages: TemplatePackageService;
  readonly saveToGitHub: SaveToGitHubService;
}

/** Bridges the EPIC-039 commit seam onto the EPIC-041 GitHub adapter. */
export function createGitHubCommitAdapter(
  integrations: IntegrationRepository,
  adapter: GithubAdapter,
): GitHubCommitAdapter {
  return {
    async commit(request) {
      const config = await integrations.getIntegrationConfig(GITHUB_INTEGRATION_KIND);
      if (config === undefined || !config.enabled) {
        // The service already fails closed before this seam is reached; keep the
        // same structured error if the row disappears between the two reads.
        throw notConfigured();
      }
      const result = await adapter.commit(config, {
        repository: request.repository,
        path: request.path,
        content: request.content,
        message: request.message,
      });
      return {
        ref: result.commitRef,
        sha: result.contentSha,
        url: `https://github.com/${result.repository}/blob/${result.branch}/${result.path}`,
      };
    },
  };
}

function notConfigured(): AppError {
  return new AppError(
    SaveToGitHubErrorCodes.notConfigured,
    "GitHub integration is not configured",
    409,
    [{ field: "integration", reason: "not_configured" }],
  );
}

/** Binds every EPIC-039 service to one shared SQLite template repository. */
export function createTemplateServices(options: TemplateServiceOptions): TemplateServices {
  const { repository, integrations, github, audit } = options;
  const templateReader: SaveToGitHubTemplateReader = {
    getTemplateLibraryItem: (itemId: string): Promise<TemplateLibraryItem | undefined> =>
      repository.getTemplateLibraryItem(itemId),
  };
  return {
    library: new TemplateLibraryRepositoryService(repository),
    repos: new TemplateRepoService({
      repos: repository,
      ...(audit ? { audit } : {}),
      ...(options.fetchTemplates ? { fetchTemplates: options.fetchTemplates } : {}),
    }),
    clone: new TemplateLibraryCloneService(repository, options.cloneBuilders),
    packages: createTemplatePackageService({
      store: repository,
      ...(audit ? { recordAudit: audit } : {}),
    }),
    saveToGitHub: new SaveToGitHubService({
      templates: templateReader,
      integrations,
      ...(github ? { adapter: createGitHubCommitAdapter(integrations, github) } : {}),
      ...(audit ? { audit } : {}),
    }),
  };
}
