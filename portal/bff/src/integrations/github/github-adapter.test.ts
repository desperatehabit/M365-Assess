// T-0802 — GitHub integration adapter. Proves the adapter registers with the
// T-0801 registry, resolves its credential by reference, writes the template
// file through an injected transport, records the commit ref in the audit log,
// fails closed while disabled, and returns structured errors on auth/conflict.
// No real token or tenant data appears here.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteIntegrationRepository,
  loadMigrations,
  runMigrations,
  type IntegrationConfigInput,
} from "@m365-assess/db";
import { AppError } from "../../errors.js";
import { createInMemoryCredentialStore } from "../../credentials/store.js";
import {
  INTEGRATIONS_MANAGE_PERMISSION,
  IntegrationRegistry,
  type IntegrationCaller,
} from "../integration-registry.js";
import type { RequestContext } from "../../server.js";
import {
  GITHUB_API_BASE,
  GITHUB_AUTH_FAILED,
  GITHUB_COMMIT_ACTION,
  GITHUB_CONFLICT,
  GITHUB_DISABLED,
  GITHUB_KIND,
  GITHUB_REPOSITORY_NOT_ALLOWED,
  createGithubAdapter,
  isGithubAdapter,
  registerGithubAdapter,
  type GithubAdapter,
  type GithubHttpResponse,
  type GithubTransport,
  type GithubTransportRequest,
} from "./github-adapter.js";
import {
  GITHUB_INTEGRATION_PATH,
  GITHUB_READ_PERMISSION,
  createGithubIntegrationRoutes,
  type GithubRouteCaller,
} from "./github-routes.js";

const REPO = "octo/demo";
const SECRET_REF = "vault://fixtures/github-token";
const TOKEN = "ghp_supersecretvalue";
const TEMPLATE_BODY = '{"name":"baseline","rules":[]}';

const MANAGE: GithubRouteCaller = {
  roles: ["admin"],
  tenantScope: { all: true, tenantIds: [] },
  permissions: [INTEGRATIONS_MANAGE_PERMISSION],
  userId: "user-1",
};

const READER: GithubRouteCaller = {
  roles: ["operator"],
  tenantScope: { all: true, tenantIds: [] },
  permissions: [],
  userId: "user-2",
};

const dbs: Database.Database[] = [];

afterEach(() => {
  for (const db of dbs) db.close();
  dbs.length = 0;
});

function harness() {
  const db = new Database(":memory:");
  dbs.push(db);
  const version = runMigrations(db, loadMigrations());
  const repository = new SqliteIntegrationRepository(db, version);
  const registry = new IntegrationRegistry(repository);
  return { db, repository, registry };
}

type Responder = (request: GithubTransportRequest) => GithubHttpResponse;

class FakeTransport implements GithubTransport {
  readonly calls: Array<{ request: GithubTransportRequest; token: string | null }> = [];
  constructor(private readonly responder: Responder) {}
  async send(request: GithubTransportRequest, token: string | null): Promise<GithubHttpResponse> {
    this.calls.push({ request, token });
    return this.responder(request);
  }
}

function collector(): { events: Record<string, unknown>[]; record: (event: Record<string, unknown>) => Promise<void> } {
  const events: Record<string, unknown>[] = [];
  return { events, record: async (event) => void events.push(event) };
}

function githubInput(extra: Partial<IntegrationConfigInput> = {}): IntegrationConfigInput {
  return {
    id: randomUUID(),
    kind: GITHUB_KIND,
    enabled: true,
    secretRef: SECRET_REF,
    mapping: { repository: REPO },
    ...extra,
  };
}

function ctx(body?: unknown): RequestContext {
  return {
    correlationId: "corr-1",
    method: "PUT",
    path: GITHUB_INTEGRATION_PATH,
    query: new URLSearchParams(),
    headers: {},
    params: {},
    body,
  };
}

async function catchAsyncError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected fn to reject");
}

function makeAdapter(
  transport: GithubTransport,
  extra: {
    readSecret?: (ref: string) => Promise<string | null>;
    recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  } = {},
): GithubAdapter {
  return createGithubAdapter({ transport, ...extra });
}

describe("github adapter registration", () => {
  it("registers with the T-0801 registry under the github kind", () => {
    const { registry } = harness();
    const adapter = makeAdapter(new FakeTransport(() => ({ status: 200, body: {} })));
    registerGithubAdapter(registry, adapter);
    expect(registry.listKinds()).toEqual([GITHUB_KIND]);
    expect(registry.resolve(GITHUB_KIND)).toBe(adapter);
    expect(isGithubAdapter(registry.resolve(GITHUB_KIND))).toBe(true);
  });

  it("resolves the same kind through the registry's test entry point", async () => {
    const { registry } = harness();
    const transport = new FakeTransport(() => ({ status: 200, body: { permissions: { push: true } } }));
    const credentials = createInMemoryCredentialStore({ [SECRET_REF]: TOKEN });
    registry.register(makeAdapter(transport, { readSecret: credentials.readSecret }));
    await registry.putConfig(GITHUB_KIND, githubInput(), MANAGE as IntegrationCaller);
    const result = await registry.testIntegration(GITHUB_KIND);
    expect(result.ok).toBe(true);
    expect(transport.calls[0]?.request.url).toBe(`${GITHUB_API_BASE}/repos/${REPO}`);
  });
});

describe("github adapter credential handling", () => {
  it("resolves the token by reference and never persists it in config", async () => {
    const { registry, db } = harness();
    const credentials = createInMemoryCredentialStore({ [SECRET_REF]: TOKEN });
    const transport = new FakeTransport(() => ({ status: 200, body: { permissions: { push: true } } }));
    registry.register(makeAdapter(transport, { readSecret: credentials.readSecret }));
    const config = await registry.putConfig(GITHUB_KIND, githubInput(), MANAGE as IntegrationCaller);
    await registry.testIntegration(GITHUB_KIND);

    expect(config.secretRef).toBe(SECRET_REF);
    expect(transport.calls[0]?.token).toBe(TOKEN);
    const row = db
      .prepare("SELECT * FROM integration_configs WHERE kind = ?")
      .get(GITHUB_KIND) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it("reports a disabled integration without any network call", async () => {
    const { registry } = harness();
    const transport = new FakeTransport(() => ({ status: 200, body: {} }));
    registry.register(makeAdapter(transport));
    await registry.putConfig(
      GITHUB_KIND,
      githubInput({ enabled: false }),
      MANAGE as IntegrationCaller,
    );
    const result = await registry.testIntegration(GITHUB_KIND);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/disabled/i);
    expect(transport.calls).toEqual([]);
  });

  it("reports an auth failure from the repository check as a failed test", async () => {
    const { registry } = harness();
    const credentials = createInMemoryCredentialStore({ [SECRET_REF]: TOKEN });
    const transport = new FakeTransport(() => ({ status: 401, body: { message: "Bad credentials" } }));
    registry.register(makeAdapter(transport, { readSecret: credentials.readSecret }));
    await registry.putConfig(GITHUB_KIND, githubInput(), MANAGE as IntegrationCaller);
    const result = await registry.testIntegration(GITHUB_KIND);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(TOKEN);
  });
});

describe("github adapter commit", () => {
  async function configured(
    responder: Responder,
    extra: { recordAudit?: (event: Record<string, unknown>) => Promise<void> } = {},
  ) {
    const { registry } = harness();
    const credentials = createInMemoryCredentialStore({ [SECRET_REF]: TOKEN });
    const transport = new FakeTransport(responder);
    const adapter = makeAdapter(transport, { readSecret: credentials.readSecret, ...extra });
    registry.register(adapter);
    const config = await registry.putConfig(GITHUB_KIND, githubInput(), MANAGE as IntegrationCaller);
    return { adapter, config, transport };
  }

  it("writes the template file and records the commit ref in the audit log", async () => {
    const audit = collector();
    const { adapter, config, transport } = await configured(
      () => ({ status: 201, body: { commit: { sha: "abc123" }, content: { sha: "def456" } } }),
      { recordAudit: audit.record },
    );

    const result = await adapter.commit(config, {
      path: "templates/conditional-access.json",
      content: TEMPLATE_BODY,
      message: "Add CA template",
    });

    expect(result).toEqual({
      commitRef: "abc123",
      contentSha: "def456",
      repository: REPO,
      path: "templates/conditional-access.json",
      branch: "main",
    });

    const call = transport.calls[0];
    expect(call?.request.method).toBe("PUT");
    expect(call?.request.url).toBe(
      `${GITHUB_API_BASE}/repos/${REPO}/contents/templates/conditional-access.json`,
    );
    expect(call?.token).toBe(TOKEN);
    const payload = JSON.parse(call?.request.body ?? "{}") as Record<string, unknown>;
    expect(payload["message"]).toBe("Add CA template");
    expect(payload["branch"]).toBe("main");
    expect(Buffer.from(String(payload["content"]), "base64").toString("utf8")).toBe(TEMPLATE_BODY);

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.["action"]).toBe(GITHUB_COMMIT_ACTION);
    const after = audit.events[0]?.["after"] as Record<string, unknown>;
    expect(after["commitRef"]).toBe("abc123");
    expect(JSON.stringify(audit.events)).not.toContain(TOKEN);
  });

  it("fails closed while disabled and performs no write", async () => {
    const { registry } = harness();
    const transport = new FakeTransport(() => ({ status: 201, body: { commit: { sha: "abc" } } }));
    const adapter = makeAdapter(transport);
    registry.register(adapter);
    const config = await registry.putConfig(
      GITHUB_KIND,
      githubInput({ enabled: false }),
      MANAGE as IntegrationCaller,
    );

    const error = await catchAsyncError(() =>
      adapter.commit(config, { path: "a.json", content: "{}", message: "m" }),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(GITHUB_DISABLED);
    expect(transport.calls).toEqual([]);
  });

  it("returns a structured auth error and audits the failure without the token", async () => {
    const audit = collector();
    const { adapter, config } = await configured(
      () => ({ status: 403, body: { message: "Resource not accessible" } }),
      { recordAudit: audit.record },
    );

    const error = await catchAsyncError(() =>
      adapter.commit(config, { path: "a.json", content: "{}", message: "m" }),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(GITHUB_AUTH_FAILED);
    expect((error as AppError).status).toBe(401);
    expect((error as AppError).message).not.toContain(TOKEN);
    expect(audit.events[0]?.["result"]).toBe("failure");
    expect(JSON.stringify(audit.events)).not.toContain(TOKEN);
  });

  it("returns a structured conflict error when the file changed upstream", async () => {
    const { adapter, config } = await configured(() => ({ status: 409, body: { message: "conflict" } }));

    const error = await catchAsyncError(() =>
      adapter.commit(config, { path: "a.json", content: "{}", message: "m", sha: "stale" }),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(GITHUB_CONFLICT);
    expect((error as AppError).status).toBe(409);
  });

  it("refuses a repository that is not in the configured allowlist", async () => {
    const { adapter, config, transport } = await configured(() => ({
      status: 201,
      body: { commit: { sha: "abc" } },
    }));

    const error = await catchAsyncError(() =>
      adapter.commit(config, {
        repository: "attacker/repo",
        path: "a.json",
        content: "{}",
        message: "m",
      }),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(GITHUB_REPOSITORY_NOT_ALLOWED);
    expect((error as AppError).status).toBe(403);
    expect(transport.calls).toEqual([]);
  });
});

describe("github integration routes", () => {
  function routeFor(routes: ReturnType<typeof createGithubIntegrationRoutes>, method: string, suffix = "") {
    return routes.find((route) => route.method === method && route.path.endsWith(suffix));
  }

  it("upserts config through the registry and requires integrations.manage", async () => {
    const { registry } = harness();
    registry.register(makeAdapter(new FakeTransport(() => ({ status: 200, body: {} }))));
    const routes = createGithubIntegrationRoutes({ registry, resolveCaller: () => MANAGE });
    const put = routeFor(routes, "PUT");
    expect(put).toBeDefined();

    const response = await put!.handler(
      ctx({ enabled: true, secretRef: SECRET_REF, mapping: { repository: REPO } }),
    );
    expect(response.status).toBe(200);
    const stored = await registry.getConfig(GITHUB_KIND);
    expect(stored?.enabled).toBe(true);
    expect(stored?.secretRef).toBe(SECRET_REF);
  });

  it("denies a reader without the integration permission", async () => {
    const { registry } = harness();
    const routes = createGithubIntegrationRoutes({ registry, resolveCaller: () => READER });
    const get = routeFor(routes, "GET");
    const error = await catchAsyncError(() => get!.handler(ctx()));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("auth.forbidden");
  });

  it("exposes the read permission constant", () => {
    expect(GITHUB_READ_PERMISSION).toBe("integrations.read");
  });

  it("commits through the registered adapter and returns the commit ref", async () => {
    const { registry } = harness();
    const credentials = createInMemoryCredentialStore({ [SECRET_REF]: TOKEN });
    const transport = new FakeTransport(() => ({
      status: 201,
      body: { commit: { sha: "route123" }, content: { sha: "c1" } },
    }));
    registry.register(makeAdapter(transport, { readSecret: credentials.readSecret }));
    await registry.putConfig(GITHUB_KIND, githubInput(), MANAGE as IntegrationCaller);

    const routes = createGithubIntegrationRoutes({ registry, resolveCaller: () => MANAGE });
    const commit = routeFor(routes, "POST", "/commit");
    const response = await commit!.handler(
      ctx({ path: "templates/x.json", content: TEMPLATE_BODY, message: "save" }),
    );
    expect(response.status).toBe(200);
    expect((response.body as { commit: { commitRef: string } }).commit.commitRef).toBe("route123");
  });
});
