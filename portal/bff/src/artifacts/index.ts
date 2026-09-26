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

export function resolveArtifactFilePath(
  artifactRoot: string,
  artifactPath: string,
  name: string,
): string {
  const file = validateArtifactName(name);
  const base = normalizeRef(artifactRoot, artifactPath);
  return `${base}/${file}`;
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

  let entries: string[];
  try {
    entries = await fsImpl.readdir(baseDir);
  } catch (err: unknown) {
    if ((err as { code?: unknown }).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const items: ArtifactItem[] = [];

  for (const entry of entries) {
    const fullPath = `${baseDir}/${entry}`;
    let stat: FileStatLike;
    try {
      stat = await fsImpl.stat(fullPath);
    } catch {
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
      name: entry,
      path: fullPath,
      contentType: artifactContentType(entry),
      size: stat.size,
      redacted,
      isRedacted: redacted,
      extension: ext,
      mtime: mtimeIso,
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}
