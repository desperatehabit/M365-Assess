// Next.js config for the portal web UI.
//
// The pages call the BFF with relative /v1 paths; in development those are proxied to
// the BFF (M365_BFF_URL, default http://127.0.0.1:8080). The report theme and shell CSS
// live in src/M365-Assess/assets, outside this package, so the build root is the repo.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BFF_URL = process.env["M365_BFF_URL"] ?? "http://127.0.0.1:8080";

const config: NextConfig = {
  turbopack: { root: REPO_ROOT },
  outputFileTracingRoot: REPO_ROOT,
  // Next would otherwise write AGENTS.md and CLAUDE.md into this package.
  agentRules: false,
  // The dev proxy drops a /v1 request after 30s and answers a bare 500. Onboarding and test
  // connection block on a browser sign-in and many Graph calls, so allow longer than the BFF's
  // 5 minute worker timeout; the worker's own timeout then reports the failure.
  experimental: { proxyTimeout: 6 * 60 * 1000 },
  async rewrites() {
    return [{ source: "/v1/:path*", destination: `${BFF_URL}/v1/:path*` }];
  },
};

export default config;
