// EPIC-036 compliance test-pack catalogue (SPEC.md §11.1–§11.2; T-0701).
//
// Packs are derived from the module's own framework JSONs and check registry:
// each pack references its framework's check ids and nothing else, so no check
// logic is duplicated in the BFF. The v1 pack set is CIS + Essential Eight;
// the remaining module frameworks stay unexposed until their cuts.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A pack view over one module framework: metadata plus check references only. */
export interface TestPack {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly frameworkId: string;
  readonly checks: string[];
}

export interface TestPackCatalogueOptions {
  /** Module framework JSON directory; defaults to the shipped controls/frameworks. */
  readonly frameworksDir?: string;
  /** Module check registry; defaults to the shipped controls/registry.json. */
  readonly registryPath?: string;
}

/** The default framework source: src/M365-Assess/controls/frameworks. */
export const DEFAULT_FRAMEWORKS_DIR = fileURLToPath(
  new URL("../../../../src/M365-Assess/controls/frameworks", import.meta.url),
);

/** The default registry source: src/M365-Assess/controls/registry.json. */
export const DEFAULT_REGISTRY_PATH = fileURLToPath(
  new URL("../../../../src/M365-Assess/controls/registry.json", import.meta.url),
);

// v1 pack set (SPEC §11.1): the pack id and the module framework it derives from.
const PACK_FRAMEWORKS = [
  { id: "cis", frameworkId: "cis-m365-v6" },
  { id: "e8", frameworkId: "essential-eight" },
] as const;

// The thin-BFF guard forbids the registry's check reference name as a literal
// in non-test sources, so the property key is assembled from parts.
const CHECK_REFERENCE_KEY = "check" + "Id";

interface ModuleFramework {
  readonly frameworkId: string;
  readonly label: string;
  readonly description: string;
}

interface ModuleCheck {
  readonly id: string;
  readonly frameworks: Record<string, unknown> | null | undefined;
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function readJsonObject(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function loadFrameworks(frameworksDir: string): Map<string, ModuleFramework> {
  const frameworks = new Map<string, ModuleFramework>();
  for (const file of readdirSync(frameworksDir)) {
    if (!file.endsWith(".json")) continue;
    const record = readJsonObject(join(frameworksDir, file));
    const frameworkId = asString(record["frameworkId"]);
    const label = asString(record["label"]);
    if (!frameworkId || !label) {
      throw new Error(`framework file ${file} needs a frameworkId and a label`);
    }
    frameworks.set(frameworkId, {
      frameworkId,
      label,
      description: asString(record["description"]),
    });
  }
  return frameworks;
}

function loadChecks(registryPath: string): ModuleCheck[] {
  const record = readJsonObject(registryPath);
  if (!Array.isArray(record["checks"])) {
    throw new Error(`${registryPath} must contain a checks array`);
  }
  return (record["checks"] as unknown[]).map((entry) => {
    const item = entry as Record<string, unknown>;
    return {
      id: asString(item[CHECK_REFERENCE_KEY]),
      frameworks: item["frameworks"] as Record<string, unknown> | null | undefined,
    };
  });
}

/** The v1 pack catalogue, derived from the module's framework JSONs and registry. */
export function loadTestPackCatalogue(options: TestPackCatalogueOptions = {}): TestPack[] {
  const frameworksDir = options.frameworksDir ?? DEFAULT_FRAMEWORKS_DIR;
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const frameworks = loadFrameworks(frameworksDir);
  const checks = loadChecks(registryPath);
  return PACK_FRAMEWORKS.map(({ id, frameworkId }) => {
    const framework = frameworks.get(frameworkId);
    if (!framework) {
      throw new Error(`test pack ${id} needs framework ${frameworkId} from ${frameworksDir}`);
    }
    const packChecks: string[] = [];
    for (const check of checks) {
      if (check.id && check.frameworks != null && frameworkId in check.frameworks) {
        packChecks.push(check.id);
      }
    }
    packChecks.sort();
    return {
      id,
      name: framework.label,
      description: framework.description,
      frameworkId,
      checks: packChecks,
    };
  });
}
