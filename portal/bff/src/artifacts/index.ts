// Artifact indexer and streaming helpers (EPIC-003 SPEC.md §4.5, §9, T-0048).
// Scans the run artifact directory, indexes files (name, type, size, mtime),
// preserves the `-Redact` distinction (03-database.md §7), and supports streaming downloads
// so large files (2-5+ MB) are never buffered wholly into memory.

import { createReadStream, promises as fsPromises } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { AppError } from "../errors.js";

export const ARTIFACT_CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  zip: "application/zip",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
};

export function artifactContentType(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
  return ARTIFACT_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function isArtifactRedacted(fileName: string, defaultRedact = false): boolean {
  // Matches file names containing -redact, -redacted, _redact, .redacted., etc.
  if (/[-._]redact(?:ed)?(?=[-._]|\.|$)/i.test(fileName) || fileName.toLowerCase().includes("redact")) {
    return true;
  }
  return defaultRedact;
}

export interface ArtifactItem {
  readonly name: string;
  readonly path: string;
  readonly contentType: string;
  readonly size: number;
  readonly redacted: boolean;
  readonly isRedacted: boolean;
  readonly extension: string;
  readonly mtime: string;
}

export interface FileStatLike {
  readonly size: number;
  readonly mtime: Date | string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface ArtifactFileSystem {
  readdir(dirPath: string): Promise<string[]>;
  stat(filePath: string): Promise<FileStatLike>;
  createReadStream(filePath: string): Readable;
}

export const defaultFileSystem: ArtifactFileSystem = {
  async readdir(dirPath: string): Promise<string[]> {
    return await fsPromises.readdir(dirPath);
  },
  async stat(filePath: string): Promise<FileStatLike> {
    const s = await fsPromises.stat(filePath);
    return {
      size: s.size,
      mtime: s.mtime,
      isFile: () => s.isFile(),
      isDirectory: () => s.isDirectory(),
    };
  },
  createReadStream(filePath: string): Readable {
    return createReadStream(filePath);
  },
};

function normalizeRef(root: string, ref: string): string {
  const cleanRoot = root.replace(/\/+$/, "");
  const cleanRef = ref.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleanRoot) return cleanRef.startsWith("/") ? cleanRef : `/${cleanRef}`;
  return `${cleanRoot}/${cleanRef}`;
}

export function validateArtifactName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new AppError("run.invalid_artifact_name", "artifact name must be supplied", 400, [
      { field: "name", reason: "missing" },
    ]);
  }
  const trimmed = name.trim();
  if (
    trimmed.length > 256 ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.split(".").includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)
  ) {
    throw new AppError("run.invalid_artifact_name", `artifact name '${trimmed}' is not a valid plain file name`, 400, [
      { field: "name", reason: "invalid_format" },
    ]);
  }
  return trimmed;
}

/**
 * The assessment writes its outputs into a timestamped `Assessment_*` subfolder of the run's
 * artifact path (T-0946). Artifacts are listed and downloaded by their path relative to that
 * artifact path, at most this many folders deep.
 */
export const MAX_ARTIFACT_DEPTH = 3;
/** Upper bound on indexed files, so a runaway output folder cannot stall the listing. */
export const MAX_ARTIFACT_FILES = 5000;

/**
 * Validates an artifact reference relative to the run's artifact path: one to
 * MAX_ARTIFACT_DEPTH `/`-separated segments, each a plain file or folder name. Rejects
 * backslashes, absolute paths, empty segments and `..`, so the resolved path cannot leave
 * the artifact path.
 */
export function validateArtifactPath(ref: unknown): string {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new AppError("run.invalid_artifact_name", "artifact name must be supplied", 400, [
      { field: "name", reason: "missing" },
    ]);
  }
  const trimmed = ref.trim();
  const segments = trimmed.split("/");
  const invalid =
    trimmed.length > 512 ||
    trimmed.includes("\\") ||
    segments.length > MAX_ARTIFACT_DEPTH ||
    // A segment starts with a letter, digit or underscore (the assessment writes _Assessment-*
    // files); a leading dot is refused, so hidden files and ".." never match.
    segments.some((segment) => !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(segment) || segment.split(".").includes(".."));
  if (invalid) {
    throw new AppError("run.invalid_artifact_name", `artifact name '${trimmed}' is not a valid artifact path`, 400, [
      { field: "name", reason: "invalid_format" },
    ]);
  }
  return segments.join("/");
}

export function resolveArtifactFilePath(
  artifactRoot: string,
  artifactPath: string,
  name: string,
): string {
  const file = validateArtifactPath(name);
  const base = normalizeRef(artifactRoot, artifactPath);
  return `${base}/${file}`;
}

/** The report and the compliance matrix sort first; everything else by path. */
function artifactSortRank(name: string): number {
  const lower = name.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return 0;
  if (lower.endsWith(".xlsx")) return 1;
  return 2;
}

export interface IndexRunArtifactsOptions {
  readonly artifactRoot: string;
  readonly artifactPath: string;
  readonly defaultRedact?: boolean;
  readonly fs?: ArtifactFileSystem;
}

export async function indexRunArtifacts(options: IndexRunArtifactsOptions): Promise<ArtifactItem[]> {
  const fsImpl = options.fs ?? defaultFileSystem;
  const baseDir = normalizeRef(options.artifactRoot, options.artifactPath);

  const items: ArtifactItem[] = [];

  // Walks the artifact path and its subfolders (the assessment's Assessment_* folder).
  // `name` is the path relative to the artifact path, which the download route accepts.
  const walk = async (dir: string, relDir: string, depth: number): Promise<void> => {
    let entries: string[];
    try {
      entries = await fsImpl.readdir(dir);
    } catch (err: unknown) {
      if (depth === 1 && (err as { code?: unknown }).code === "ENOENT") return;
      if (depth === 1) throw err;
      return;
    }

    for (const entry of entries) {
      if (items.length >= MAX_ARTIFACT_FILES) return;
      const fullPath = `${dir}/${entry}`;
      const relPath = relDir ? `${relDir}/${entry}` : entry;
      let stat: FileStatLike;
      try {
        stat = await fsImpl.stat(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (depth < MAX_ARTIFACT_DEPTH) await walk(fullPath, relPath, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }

      const dot = entry.lastIndexOf(".");
      const ext = dot < 0 ? "" : entry.slice(dot + 1).toLowerCase();
      const redacted = isArtifactRedacted(entry, options.defaultRedact);
      const mtimeIso = typeof stat.mtime === "string"
        ? stat.mtime
        : stat.mtime instanceof Date
          ? stat.mtime.toISOString()
          : new Date(stat.mtime).toISOString();

      items.push({
        name: relPath,
        path: fullPath,
        contentType: artifactContentType(entry),
        size: stat.size,
        redacted,
        isRedacted: redacted,
        extension: ext,
        mtime: mtimeIso,
      });
    }
  };

  await walk(baseDir, "", 1);

  items.sort((a, b) => artifactSortRank(a.name) - artifactSortRank(b.name) || a.name.localeCompare(b.name));
  return items;
}
