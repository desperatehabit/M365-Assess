// Template package bundles (EPIC-039 SPEC.md §3.5, §4.3, §5, §6, §8; T-0766).
//
// A package is a versioned JSON bundle (SPEC §11 item 3 — a zip container is
// deferred to a later change):
//
//   {
//     "formatVersion": 1,
//     "name": "contoso-baselines",
//     "version": "1.2.0",
//     "contents": [{ "type": "standards", "name": "Baseline v1", "body": "<json>" }],
//     "dependencies": [{ "name": "contoso-core", "version": "1.0.0" }]
//   }
//
// `type` is a value of the §9 template-type registry (T-0761); `body` is the
// serialized template. Import validates the bundle, registers every content item
// in the local library, records the package row, and audits the import (§8).
// Export serializes a selection of the local library back to the same schema so
// a bundle round-trips through import. A package whose name is already recorded
// at a higher version is a conflict; the same version re-imports idempotently.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import {
  TEMPLATE_TYPES,
  type TemplateLibraryItem,
  type TemplateLibraryItemInput,
  type TemplateLibraryItemListOptions,
  type TemplatePackage,
  type TemplatePackageInput,
} from "@m365-assess/db";

export const TEMPLATE_PACKAGE_FORMAT_VERSION = 1;

export interface TemplatePackageContent {
  readonly type: string;
  readonly name: string;
  readonly body: string;
}

export interface TemplatePackageDependency {
  readonly name: string;
  readonly version: string;
}

export interface TemplatePackageBundle {
  readonly formatVersion: number;
  readonly name: string;
  readonly version: string;
  readonly contents: readonly TemplatePackageContent[];
  readonly dependencies: readonly TemplatePackageDependency[];
}

export const TEMPLATE_PACKAGE_UNSUPPORTED_FORMAT = "template.package.unsupported_format";
export const TEMPLATE_PACKAGE_INVALID_BUNDLE = "template.package.invalid_bundle";
export const TEMPLATE_PACKAGE_VERSION_CONFLICT = "template.package.version_conflict";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** The store seam: the T-0761 template repository satisfies this structurally. */
export interface TemplatePackageStore {
  listTemplateLibraryItems(options?: TemplateLibraryItemListOptions): Promise<TemplateLibraryItem[]>;
  getTemplateLibraryItem(
    itemId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<TemplateLibraryItem | undefined>;
  upsertTemplateLibraryItem(input: TemplateLibraryItemInput): Promise<TemplateLibraryItem>;
  listTemplatePackages(options?: { includeDeleted?: boolean }): Promise<TemplatePackage[]>;
  upsertTemplatePackage(input: TemplatePackageInput): Promise<TemplatePackage>;
}

export interface TemplatePackageImportResult {
  readonly package: TemplatePackage;
  readonly items: readonly TemplateLibraryItem[];
  readonly dependencies: readonly TemplatePackageDependency[];
}

export interface TemplatePackageExportOptions {
  readonly itemIds?: readonly string[];
  readonly name?: string;
  readonly version?: string;
}

export interface TemplatePackageSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly itemCount: number;
  readonly importedAt: string;
}

export interface TemplatePackageService {
  importBundle(bundle: unknown, actor: string): Promise<TemplatePackageImportResult>;
  exportBundle(options?: TemplatePackageExportOptions): Promise<TemplatePackageBundle>;
  listPackages(): Promise<TemplatePackageSummary[]>;
}

export interface TemplatePackageServiceOptions {
  readonly store: TemplatePackageStore;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
}

/** Orders `major.minor.patch` versions; returns <0, 0, or >0 like strcmp. */
export function compareTemplateVersions(left: string, right: string): number {
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < 3; index += 1) {
    const diff = Number(a[index] ?? 0) - Number(b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function invalid(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(`${field} must be a non-empty string`, field);
  }
  return value.trim();
}

function requireVersion(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!VERSION_PATTERN.test(text)) {
    throw invalid(`${field} must be a major.minor.patch version`, field, "invalid_version");
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseContents(value: unknown): TemplatePackageContent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalid("contents must be an array", "contents", "invalid_type");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw invalid(`contents[${index}] must be an object`, `contents[${index}]`, "invalid_type");
    }
    const type = requireString(entry["type"], `contents[${index}].type`);
    if (!TEMPLATE_TYPES.includes(type as (typeof TEMPLATE_TYPES)[number])) {
      throw invalid(
        `contents[${index}].type '${type}' is not a registered template type`,
        `contents[${index}].type`,
        "invalid_type",
      );
    }
    return {
      type,
      name: requireString(entry["name"], `contents[${index}].name`),
      body: requireString(entry["body"], `contents[${index}].body`),
    };
  });
}

function parseDependencies(value: unknown): TemplatePackageDependency[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalid("dependencies must be an array", "dependencies", "invalid_type");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw invalid(`dependencies[${index}] must be an object`, `dependencies[${index}]`, "invalid_type");
    }
    return {
      name: requireString(entry["name"], `dependencies[${index}].name`),
      version: requireVersion(entry["version"], `dependencies[${index}].version`),
    };
  });
}

/** Validates an untrusted bundle, returning the typed bundle or a structured 400. */
export function parseTemplatePackageBundle(input: unknown): TemplatePackageBundle {
  if (!isRecord(input)) {
    throw invalid("template package bundle must be a JSON object", "body", "invalid_type");
  }
  if (input["formatVersion"] !== TEMPLATE_PACKAGE_FORMAT_VERSION) {
    throw new AppError(
      TEMPLATE_PACKAGE_UNSUPPORTED_FORMAT,
      `unsupported template package formatVersion ${JSON.stringify(input["formatVersion"])}; this server supports ${TEMPLATE_PACKAGE_FORMAT_VERSION}`,
      400,
      [
        {
          field: "formatVersion",
          reason: "unsupported",
          supported: [TEMPLATE_PACKAGE_FORMAT_VERSION],
        },
      ],
    );
  }
  return {
    formatVersion: TEMPLATE_PACKAGE_FORMAT_VERSION,
    name: requireString(input["name"], "name"),
    version: requireVersion(input["version"], "version"),
    contents: parseContents(input["contents"]),
    dependencies: parseDependencies(input["dependencies"]),
  };
}

export function createTemplatePackageService(options: TemplatePackageServiceOptions): TemplatePackageService {
  const { store, recordAudit } = options;

  async function importBundle(
    bundle: unknown,
    actor: string,
  ): Promise<TemplatePackageImportResult> {
    const parsed = parseTemplatePackageBundle(bundle);
    const existing = (await store.listTemplatePackages()).find((pkg) => pkg.name === parsed.name);
    if (existing && compareTemplateVersions(existing.version, parsed.version) > 0) {
      throw new AppError(
        TEMPLATE_PACKAGE_VERSION_CONFLICT,
        `package '${parsed.name}' version ${parsed.version} conflicts with installed version ${existing.version}`,
        409,
        [
          {
            field: "version",
            reason: "conflict",
            package: parsed.name,
            existing: existing.version,
            requested: parsed.version,
          },
        ],
      );
    }

    const items: TemplateLibraryItem[] = [];
    for (const content of parsed.contents) {
      items.push(
        await store.upsertTemplateLibraryItem({
          id: randomUUID(),
          type: content.type,
          name: content.name,
          body: content.body,
          source: "local",
        }),
      );
    }

    const pkg = await store.upsertTemplatePackage({
      id: existing?.id ?? randomUUID(),
      name: parsed.name,
      version: parsed.version,
      contents: items.map((item) => item.id),
      source: "local",
    });

    await recordAudit?.({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      tenantId: null,
      action: "template.package.import",
      targetType: "template-package",
      targetId: pkg.id,
      targetName: pkg.name,
      actor,
      before: existing ? { name: existing.name, version: existing.version } : null,
      after: { name: pkg.name, version: pkg.version, itemCount: items.length },
      result: "success",
    });

    return { package: pkg, items, dependencies: parsed.dependencies };
  }

  async function exportBundle(
    exportOptions: TemplatePackageExportOptions = {},
  ): Promise<TemplatePackageBundle> {
    const name = requireString(exportOptions.name ?? "local-library", "name");
    const version = requireVersion(exportOptions.version ?? "1.0.0", "version");
    const requested = exportOptions.itemIds ?? [];
    const items =
      requested.length > 0
        ? (await Promise.all(requested.map((id) => store.getTemplateLibraryItem(id)))).filter(
            (item): item is TemplateLibraryItem => item !== undefined,
          )
        : await store.listTemplateLibraryItems({ source: "local" });
    if (items.length === 0) {
      throw invalid("the library selection has no items to export", "itemIds", "empty");
    }
    return {
      formatVersion: TEMPLATE_PACKAGE_FORMAT_VERSION,
      name,
      version,
      contents: items.map((item) => ({ type: item.type, name: item.name, body: item.body })),
      dependencies: [],
    };
  }

  async function listPackages(): Promise<TemplatePackageSummary[]> {
    const packages = await store.listTemplatePackages();
    return packages.map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      version: pkg.version,
      source: pkg.source,
      itemCount: pkg.contents.length,
      importedAt: pkg.createdAt,
    }));
  }

  return { importBundle, exportBundle, listPackages };
}
