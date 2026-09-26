import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { RequestContext } from "../server.js";
import type { Caller } from "../rbac/authorize.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import {
  createRunsArtifactsListRoute,
  createRunsArtifactsDownloadRoute,
  createRunsArtifactsRoutes,
  RUNS_ARTIFACTS_LIST_OPENAPI,
  RUNS_ARTIFACTS_DOWNLOAD_OPENAPI,
  RUNS_ARTIFACTS_OPENAPI,
  type RunsArtifactsStore,
  type ArtifactAuditEventInput,
  type RunsArtifactsRequestContext,
} from "./runs-artifacts.js";
import type { RunRecord } from "../domain/run-retry.js";
import type { ArtifactFileSystem, FileStatLike } from "../artifacts/index.js";

const NOW = "2026-09-26T12:00:00.000Z";

function makeCaller(overrides: Partial<Caller> = {}): Caller {
  return {
    roles: ["admin"],
    tenantScope: ALL_TENANTS,
    ...overrides,
  };
}

function makeContext(params: Record<string, string> = {}): RequestContext {
  return {
    correlationId: "corr-artifacts-1",
    params,
    query: new URLSearchParams(),
    headers: {},
  };
}

class FakeArtifactsStore implements RunsArtifactsStore {
  readonly runs = new Map<string, RunRecord>();
  readonly auditEvents: ArtifactAuditEventInput[] = [];

  async getRunById(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId);
  }

  async appendAuditEvent(event: ArtifactAuditEventInput): Promise<unknown> {
    this.auditEvents.push(event);
    return event;
  }
}

class FakeArtifactFileSystem implements ArtifactFileSystem {
  readonly files = new Map<string, { size: number; mtime: Date; isDir?: boolean; content?: Buffer }>();

  async readdir(dirPath: string): Promise<string[]> {
    const cleanDir = dirPath.replace(/\/+$/, "");
    const matching: string[] = [];
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(cleanDir + "/")) {
        const rest = filePath.slice(cleanDir.length + 1);
        const segment = rest.split("/")[0]!;
        if (!matching.includes(segment)) {
          matching.push(segment);
        }
      }
    }
    if (matching.length === 0 && !this.files.has(cleanDir)) {
      const err = new Error(`ENOENT: no such file or directory '${dirPath}'`);
      (err as any).code = "ENOENT";
      throw err;
    }
    return matching;
  }

  async stat(filePath: string): Promise<FileStatLike> {
    const entry = this.files.get(filePath);
    if (!entry) {
      const err = new Error(`ENOENT: no such file '${filePath}'`);
      (err as any).code = "ENOENT";
      throw err;
    }
    return {
      size: entry.size,
      mtime: entry.mtime,
      isFile: () => !entry.isDir,
      isDirectory: () => Boolean(entry.isDir),
    };
  }

  createReadStream(filePath: string): Readable {
    const entry = this.files.get(filePath);
    if (!entry) {
      const stream = new Readable();
      stream._read = () => {
        stream.destroy(new Error(`ENOENT: no such file '${filePath}'`));
      };
      return stream;
    }
    return Readable.from([entry.content ?? Buffer.from("default-bytes")]);
  }
}

describe("runs-artifacts routes", () => {
  const ARTIFACT_ROOT = "/artifacts";

  function createTestRun(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      id: "run-001",
      tenantId: "tenant-a",
      parentRunId: null,
      trigger: "manual",
      sections: ["Tenant"],
      options: { redact: false },
      startedAt: NOW,
      finishedAt: NOW,
      status: "succeeded",
      artifactPath: "runs/tenant-a/run-001",
      summaryCounts: null,
      provenance: {},
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  describe("GET /v1/runs/:runId/artifacts", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const store = new FakeArtifactsStore();
      const fs = new FakeArtifactFileSystem();
      const route = createRunsArtifactsListRoute({
        store,
        artifactRoot: ARTIFACT_ROOT,
        fs,
        resolveCaller: () => undefined,
      });

      await expect(route.handler(makeContext({ runId: "run-001" }))).rejects.toMatchObject({
        code: "request.unauthenticated",
        status: 401,
      });
    });

    it("rejects caller without runs.read permission with 403", async () => {
      const store = new FakeArtifactsStore();
      const fs = new FakeArtifactFileSystem();
      const route = createRunsArtifactsListRoute({
        store,
        artifactRoot: ARTIFACT_ROOT,
        fs,
        resolveCaller: () => makeCaller({ roles: [] }),
      });

      await expect(route.handler(makeContext({ runId: "run-001" }))).rejects.toMatchObject({
        code: "auth.forbidden",
        status: 403,
      });
    });

    it("rejects caller if tenant is outside scope with 403", async () => {
      const store = new FakeArtifactsStore();
      const fs = new FakeArtifactFileSystem();
      store.runs.set("run-001", createTestRun({ tenantId: "tenant-forbidden" }));

      const route = createRunsArtifactsListRoute({
        store,
        artifactRoot: ARTIFACT_ROOT,
        fs,
        resolveCaller: () =>
          makeCaller({ tenantScope: tenantScope(["tenant-allowed"]) }),
      });

      await expect(route.handler(makeContext({ runId: "run-001" }))).rejects.toMatchObject({
        code: "auth.forbidden",
        status: 403,
      });
    });

    it("returns 404 if run not found", async () => {
      const store = new FakeArtifactsStore();
      const fs = new FakeArtifactFileSystem();
      const route = createRunsArtifactsListRoute({
        store,
        artifactRoot: ARTIFACT_ROOT,
        fs,
        resolveCaller: () => makeCaller(),
      });

      await expect(route.handler(makeContext({ runId: "nonexistent" }))).rejects.toMatchObject({
        code: "run.not_found",
        status: 404,
      });
    });

    it("returns empty items array if run has no artifactPath", async () => {
      const store = new FakeArtifactsStore();
      const fs = new FakeArtifactFileSystem();
      store.runs.set("run-001", createTestRun({ artifactPath: null }));

      const route = createRunsArtifactsListRoute({
        store,
        artifactRoot: ARTIFACT_ROOT,
        fs,
        resolveCaller: () => makeCaller(),
      });

      const res = await route.handler(makeContext({ runId: "run-001" }));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        runId: "run-001",
        tenantId: "tenant-a",
        items: [],
      });
    });

    it("indexes and returns artifacts with name, content type, size, and audits the listing", async () => {
      const store = new FakeArtifactsStore();
      const fs = new FakeArtifactFileSystem();
      store.runs.set("run-001", createTestRun());

      const dir = `${ARTIFACT_ROOT}/runs/tenant-a/run-001`;
      fs.files.set(`${dir}/report.html`, {
        size: 2500000,
        mtime: new Date(NOW),
      });
      fs.files.set(`${dir}/evidence-Redacted.zip`, {
        size: 5500000,
        mtime: new Date(NOW),
      });

      const route = createRunsArtifactsListRoute({
        store,
        artifactRoot: ARTIFACT_ROOT,
        fs,
        resolveCaller: () => makeCaller(),
        now: () => NOW,
      });

      const res = await route.handler(makeContext({ runId: "run-001" }));
      expect(res.status).toBe(200);

      const body = res.body as any;
      expect(body.runId).toBe("run-001");
      expect(body.tenantId).toBe("tenant-a");
      expect(body.items).toHaveLength(2);

      const html = body.items.find((i: any) => i.name === "report.html");
      expect(html).toMatchObject({
        name: "report.html",
        contentType: "text/html; charset=utf-8",
        size: 2500000,
        redacted: false,
      });

      const zip = body.items.find((i: any) => i.name === "evidence-Redacted.zip");
      expect(zip).toMatchObject({
        name: "evidence-Redacted.zip",
        contentType: "application/zip",
        size: 5500000,
        redacted: true,
      });

      // Verify audit log
      expect(store.auditEvents).toHaveLength(1);
      expect(store.auditEvents[0]).toMatchObject({
        action: "runs.artifacts.list",
        tenantId: "tenant-a",
        targetType: "run",
        targetId: "run-001",
        result: "success",
      });
    });
  });

  describe("GET /v1/runs/:runId/artifacts/:name", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const store = new FakeArtifactsStore();
      const fs = new FakeArtifactFileSystem();
      const route = createRunsArtifactsDownloadRoute({
        store,
        artifactRoot: ARTIFACT_ROOT,
        fs,
        resolveCaller: () => undefined,
      });

      await expect(
        route.handler(makeContext({ runId: "run-001", name: "report.html" })),
      ).rejects.toMatchObject({
        code: "request.unauthenticated",
        status: 401,
      });
    });

    it("rejects caller without runs.read permission with 403", async () => {
      const store = new FakeArtifactsStore();
      const fs = new FakeArtifactFileSystem();
      const route = createRunsArtifactsDownloadRoute({
        store,
        artifactRoot: ARTIFACT_ROOT,
        fs,
        resolveCaller: () => makeCaller({ roles: [] }),
      });

      await expect(
        route.handler(makeContext({ runId: "run-001", name: "report.html" })),
      ).rejects.toMatchObject({
        code: "auth.forbidden",
        status: 403,
      });
    });

    it("rejects invalid artifact names with path traversal with 400", async () => {
      const store = new FakeArtifactsStore();
      const fs = new FakeArtifactFileSystem();
      store.runs.set("run-001", createTestRun());

      const route = createRunsArtifactsDownloadRoute({
        store,
        artifactRoot: ARTIFACT_ROOT,
        fs,
        resolveCaller: () => makeCaller(),
      });

      await expect(
        route.handler(makeContext({ runId: "run-001", name: "../secret.txt" })),
      ).rejects.toMatchObject({
        code: "run.invalid_artifact_name",
        status: 400,
      });
    });

    it("returns 404 if artifact file is not found", async () => {
      const store = new FakeArtifactsStore();
      const fs = new FakeArtifactFileSystem();
      store.runs.set("run-001", createTestRun());

      const route = createRunsArtifactsDownloadRoute({
        store,
        artifactRoot: ARTIFACT_ROOT,
        fs,
        resolveCaller: () => makeCaller(),
      });

      await expect(
        route.handler(makeContext({ runId: "run-001", name: "missing.html" })),
      ).rejects.toMatchObject({
        code: "run.artifact_not_found",
        status: 404,
      });
    });

    it("streams artifact file without buffering, sets headers, and audits download", async () => {
      const store = new FakeArtifactsStore();
      const fs = new FakeArtifactFileSystem();
      store.runs.set("run-001", createTestRun());

      const fileContent = Buffer.from("<html>5MB-report-content</html>");
      fs.files.set(`${ARTIFACT_ROOT}/runs/tenant-a/run-001/report.html`, {
        size: 5242880,
        mtime: new Date(NOW),
        content: fileContent,
      });

      const route = createRunsArtifactsDownloadRoute({
        store,
        artifactRoot: ARTIFACT_ROOT,
        fs,
        resolveCaller: () => makeCaller(),
        now: () => NOW,
      });

      const headersSet: Record<string, string> = {};
      const chunksPiped: Buffer[] = [];

      const ctx: RunsArtifactsRequestContext = {
        ...makeContext({ runId: "run-001", name: "report.html" }),
        res: {
          setHeader(name, value) {
            headersSet[name] = value;
          },
          write(chunk) {
            chunksPiped.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return true;
          },
          end() {},
        },
        sink(chunk) {
          chunksPiped.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        },
      };

      const res = await route.handler(ctx);
      expect(res.status).toBe(200);
      expect(res.contentType).toBe("text/html; charset=utf-8");

      expect(headersSet["Content-Type"]).toBe("text/html; charset=utf-8");
      expect(headersSet["Content-Length"]).toBe("5242880");
      expect(headersSet["Content-Disposition"]).toContain("report.html");

      // Verify audit log
      expect(store.auditEvents).toHaveLength(1);
      expect(store.auditEvents[0]).toMatchObject({
        action: "runs.artifacts.download",
        tenantId: "tenant-a",
        targetType: "artifact",
        targetId: "run-001/report.html",
        result: "success",
      });
    });
  });

  describe("createRunsArtifactsRoutes and OpenAPI exports", () => {
    it("returns both routes from createRunsArtifactsRoutes", () => {
      const store = new FakeArtifactsStore();
      const fs = new FakeArtifactFileSystem();
      const routes = createRunsArtifactsRoutes({
        store,
        artifactRoot: ARTIFACT_ROOT,
        fs,
        resolveCaller: () => makeCaller(),
      });

      expect(routes).toHaveLength(2);
      expect(routes.map((r) => r.path)).toEqual([
        "/v1/runs/:runId/artifacts",
        "/v1/runs/:runId/artifacts/:name",
      ]);
    });

    it("exports OpenAPI schemas for artifacts list and download", () => {
      expect(RUNS_ARTIFACTS_LIST_OPENAPI["/v1/runs/{runId}/artifacts"]).toBeDefined();
      expect(
        RUNS_ARTIFACTS_LIST_OPENAPI["/v1/runs/{runId}/artifacts"].get.operationId,
      ).toBe("listRunArtifacts");

      expect(
        RUNS_ARTIFACTS_DOWNLOAD_OPENAPI["/v1/runs/{runId}/artifacts/{name}"],
      ).toBeDefined();
      expect(
        RUNS_ARTIFACTS_DOWNLOAD_OPENAPI["/v1/runs/{runId}/artifacts/{name}"].get.operationId,
      ).toBe("downloadRunArtifact");

      expect(RUNS_ARTIFACTS_OPENAPI["/v1/runs/{runId}/artifacts"]).toBeDefined();
      expect(RUNS_ARTIFACTS_OPENAPI["/v1/runs/{runId}/artifacts/{name}"]).toBeDefined();
    });
  });
});
