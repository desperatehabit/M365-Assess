import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  artifactContentType,
  indexRunArtifacts,
  isArtifactRedacted,
  resolveArtifactFilePath,
  validateArtifactName,
  validateArtifactPath,
  type ArtifactFileSystem,
  type FileStatLike,
} from "./index.js";

class FakeFileSystem implements ArtifactFileSystem {
  readonly files = new Map<string, { size: number; mtime: Date; isDir?: boolean; content?: string }>();

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
      const err = new Error(`ENOENT: no such file or directory, scandir '${dirPath}'`);
      (err as any).code = "ENOENT";
      throw err;
    }
    return matching;
  }

  async stat(filePath: string): Promise<FileStatLike> {
    const entry = this.files.get(filePath);
    if (!entry) {
      const err = new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
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
    return Readable.from([Buffer.from(entry.content ?? "test-content")]);
  }
}

describe("artifacts indexing and resolution", () => {
  describe("artifactContentType", () => {
    it("maps extensions to expected MIME types", () => {
      expect(artifactContentType("report.html")).toBe("text/html; charset=utf-8");
      expect(artifactContentType("report.HTM")).toBe("text/html; charset=utf-8");
      expect(artifactContentType("report.xlsx")).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      expect(artifactContentType("findings.csv")).toBe("text/csv; charset=utf-8");
      expect(artifactContentType("data.json")).toBe("application/json; charset=utf-8");
      expect(artifactContentType("evidence.zip")).toBe("application/zip");
      expect(artifactContentType("doc.pdf")).toBe("application/pdf");
      expect(artifactContentType("log.txt")).toBe("text/plain; charset=utf-8");
      expect(artifactContentType("unknown.bin")).toBe("application/octet-stream");
      expect(artifactContentType("noextension")).toBe("application/octet-stream");
    });
  });

  describe("isArtifactRedacted", () => {
    it("detects redacted patterns in file names", () => {
      expect(isArtifactRedacted("report-Redact.html")).toBe(true);
      expect(isArtifactRedacted("report-Redacted.html")).toBe(true);
      expect(isArtifactRedacted("evidence_redacted.zip")).toBe(true);
      expect(isArtifactRedacted("findings.redacted.xlsx")).toBe(true);
      expect(isArtifactRedacted("report.html")).toBe(false);
      expect(isArtifactRedacted("report.html", false)).toBe(false);
      expect(isArtifactRedacted("report.html", true)).toBe(true);
    });
  });

  describe("validateArtifactName and resolveArtifactFilePath", () => {
    it("accepts valid plain file names", () => {
      expect(validateArtifactName("report.html")).toBe("report.html");
      expect(validateArtifactName("evidence_2026.zip")).toBe("evidence_2026.zip");
      expect(validateArtifactName("findings-final.xlsx")).toBe("findings-final.xlsx");
    });

    it("rejects path traversal and invalid characters", () => {
      expect(() => validateArtifactName("")).toThrow();
      expect(() => validateArtifactName("../secret.txt")).toThrow();
      expect(() => validateArtifactName("..\\secret.txt")).toThrow();
      expect(() => validateArtifactName("dir/file.html")).toThrow();
      expect(() => validateArtifactName("dir\\file.html")).toThrow();
      expect(() => validateArtifactName(".hidden")).toThrow();
      expect(() => validateArtifactName("bad name.html")).toThrow();
    });

    it("resolves safe file paths against artifact root and run directory", () => {
      const resolved = resolveArtifactFilePath(
        "/var/data/artifacts",
        "runs/tenant-1/run-100",
        "report.html",
      );
      expect(resolved).toBe("/var/data/artifacts/runs/tenant-1/run-100/report.html");
    });
  });

  describe("validateArtifactPath (T-0946)", () => {
    it("accepts a plain name and a path into the assessment subfolder", () => {
      expect(validateArtifactPath("report.html")).toBe("report.html");
      expect(validateArtifactPath("Assessment_20261123_102423_tenant/report.html")).toBe(
        "Assessment_20261123_102423_tenant/report.html",
      );
      expect(validateArtifactPath("Assessment_x/Evidence/data.json")).toBe("Assessment_x/Evidence/data.json");
    });

    it("rejects traversal, absolute paths, backslashes, empty segments, and deep paths", () => {
      for (const bad of [
        "../secret.txt",
        "Assessment_x/../../secret.txt",
        "Assessment_x/..",
        "/etc/passwd",
        "Assessment_x\\report.html",
        "Assessment_x//report.html",
        "Assessment_x/",
        ".hidden/report.html",
        "a/b/c/d.txt",
        "",
      ]) {
        expect(() => validateArtifactPath(bad), bad).toThrow();
      }
    });

    it("resolves a nested path under the run's artifact path", () => {
      expect(resolveArtifactFilePath("/var/data/artifacts", "runs/t1/r1", "Assessment_x/report.html")).toBe(
        "/var/data/artifacts/runs/t1/r1/Assessment_x/report.html",
      );
      expect(() => resolveArtifactFilePath("/var/data/artifacts", "runs/t1/r1", "../r2/report.html")).toThrow();
    });
  });

  describe("indexRunArtifacts", () => {
    it("indexes the assessment subfolder with relative names, report and matrix first (T-0946)", async () => {
      const fs = new FakeFileSystem();
      const mtime = new Date("2026-11-24T10:00:00.000Z");
      const run = "/artifacts/runs/t1/r1";
      const folder = `${run}/Assessment_20261123_102423_tenant`;
      fs.files.set(`${run}/result.json`, { size: 10, mtime });
      fs.files.set(folder, { size: 0, mtime, isDir: true });
      fs.files.set(`${folder}/_Assessment-Log_tenant.txt`, { size: 20, mtime });
      fs.files.set(`${folder}/_Compliance-Matrix_tenant.xlsx`, { size: 30, mtime });
      fs.files.set(`${folder}/_Assessment-Report_tenant.html`, { size: 40, mtime });
      fs.files.set(`${folder}/Evidence`, { size: 0, mtime, isDir: true });
      fs.files.set(`${folder}/Evidence/e.json`, { size: 50, mtime });
      // Four levels deep: beyond MAX_ARTIFACT_DEPTH, so not indexed.
      fs.files.set(`${folder}/Evidence/deep`, { size: 0, mtime, isDir: true });
      fs.files.set(`${folder}/Evidence/deep/too-deep.txt`, { size: 60, mtime });

      const items = await indexRunArtifacts({ artifactRoot: "/artifacts", artifactPath: "runs/t1/r1", fs });

      expect(items.map((i) => i.name)).toEqual([
        "Assessment_20261123_102423_tenant/_Assessment-Report_tenant.html",
        "Assessment_20261123_102423_tenant/_Compliance-Matrix_tenant.xlsx",
        "Assessment_20261123_102423_tenant/_Assessment-Log_tenant.txt",
        "Assessment_20261123_102423_tenant/Evidence/e.json",
        "result.json",
      ]);
      expect(items[0]!.contentType).toBe("text/html; charset=utf-8");
      for (const item of items) {
        expect(() => validateArtifactPath(item.name)).not.toThrow();
      }
    });

    it("returns empty array when artifact directory does not exist", async () => {
      const fs = new FakeFileSystem();
      const items = await indexRunArtifacts({
        artifactRoot: "/artifacts",
        artifactPath: "runs/t1/r1",
        fs,
      });
      expect(items).toEqual([]);
    });

    it("scans and indexes files with name, content type, size, and redacted metadata", async () => {
      const fs = new FakeFileSystem();
      const mtime = new Date("2026-09-26T10:00:00.000Z");

      fs.files.set("/artifacts/runs/t1/r1/report.html", {
        size: 2450000,
        mtime,
        content: "<html>report</html>",
      });
      fs.files.set("/artifacts/runs/t1/r1/findings-Redacted.xlsx", {
        size: 5120000,
        mtime,
      });
      fs.files.set("/artifacts/runs/t1/r1/evidence.zip", {
        size: 1024000,
        mtime,
      });
      // Directory entry should be skipped
      fs.files.set("/artifacts/runs/t1/r1/subfolder", {
        size: 0,
        mtime,
        isDir: true,
      });

      const items = await indexRunArtifacts({
        artifactRoot: "/artifacts",
        artifactPath: "runs/t1/r1",
        fs,
      });

      expect(items).toHaveLength(3);

      const html = items.find((i) => i.name === "report.html")!;
      expect(html).toBeDefined();
      expect(html.contentType).toBe("text/html; charset=utf-8");
      expect(html.size).toBe(2450000);
      expect(html.redacted).toBe(false);
      expect(html.mtime).toBe(mtime.toISOString());

      const xlsx = items.find((i) => i.name === "findings-Redacted.xlsx")!;
      expect(xlsx).toBeDefined();
      expect(xlsx.contentType).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      expect(xlsx.size).toBe(5120000);
      expect(xlsx.redacted).toBe(true);

      const zip = items.find((i) => i.name === "evidence.zip")!;
      expect(zip).toBeDefined();
      expect(zip.contentType).toBe("application/zip");
    });
  });
});
