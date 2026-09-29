// T-0701 — TestPack catalogue derived from the module framework JSONs and
// check registry. Asserts the v1 packs (CIS + E8) carry exactly their
// framework mappings, reference ids only, and take their metadata from the
// framework JSONs.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_FRAMEWORKS_DIR,
  DEFAULT_REGISTRY_PATH,
  loadTestPackCatalogue,
  type TestPack,
} from "./catalog.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "test-packs-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface RegistryCheckFixture {
  readonly checkId: string;
  readonly frameworks?: Record<string, unknown>;
}

function writeFramework(
  dir: string,
  framework: { frameworkId: string; label: string; description: string },
): void {
  writeFileSync(join(dir, `${framework.frameworkId}.json`), JSON.stringify(framework), "utf8");
}

function writeRegistry(dir: string, checks: readonly RegistryCheckFixture[]): string {
  const path = join(dir, "registry.json");
  writeFileSync(path, JSON.stringify({ checks }), "utf8");
  return path;
}

/** The check ids a registry maps to a framework, computed straight from the file. */
function mappedCheckIds(registryPath: string, frameworkId: string): string[] {
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
    checks: RegistryCheckFixture[];
  };
  return registry.checks
    .filter((check) => check.frameworks !== undefined && frameworkId in check.frameworks)
    .map((check) => check.checkId)
    .sort();
}

function readFramework(frameworkId: string): { label: string; description: string } {
  const framework = JSON.parse(
    readFileSync(join(DEFAULT_FRAMEWORKS_DIR, `${frameworkId}.json`), "utf8"),
  ) as { label: string; description: string };
  return { label: framework.label, description: framework.description };
}

describe("loadTestPackCatalogue against the shipped module data", () => {
  it("exposes the CIS and E8 packs", () => {
    const packs = loadTestPackCatalogue();
    expect(packs.map((pack) => pack.id)).toEqual(["cis", "e8"]);
  });

  it("gives each pack exactly the checks its framework maps in the registry", () => {
    const packs = loadTestPackCatalogue();
    expect(packs).toHaveLength(2);
    for (const pack of packs) {
      expect(pack.checks).toEqual(mappedCheckIds(DEFAULT_REGISTRY_PATH, pack.frameworkId));
    }
  });

  it("derives pack metadata from the framework JSONs", () => {
    const packs = loadTestPackCatalogue();
    const cis = packs.find((pack) => pack.id === "cis");
    const e8 = packs.find((pack) => pack.id === "e8");
    expect(cis?.frameworkId).toBe("cis-m365-v6");
    expect(e8?.frameworkId).toBe("essential-eight");
    expect(cis?.name).toBe(readFramework("cis-m365-v6").label);
    expect(cis?.description).toBe(readFramework("cis-m365-v6").description);
    expect(e8?.name).toBe(readFramework("essential-eight").label);
    expect(e8?.description).toBe(readFramework("essential-eight").description);
  });

  it("references framework and check ids only, with no check definitions duplicated", () => {
    const packs = loadTestPackCatalogue();
    for (const pack of packs) {
      expect(Object.keys(pack).sort()).toEqual(["checks", "description", "frameworkId", "id", "name"]);
      for (const check of pack.checks) {
        expect(typeof check).toBe("string");
      }
      expect(new Set(pack.checks).size).toBe(pack.checks.length);
    }
  });
});

describe("loadTestPackCatalogue with fixture module data", () => {
  it("derives packs from the given framework JSONs and registry", () => {
    const frameworksDir = tempDir();
    const registryDir = tempDir();
    writeFramework(frameworksDir, {
      frameworkId: "cis-m365-v6",
      label: "Fixture CIS",
      description: "Fixture CIS description",
    });
    writeFramework(frameworksDir, {
      frameworkId: "essential-eight",
      label: "Fixture E8",
      description: "Fixture E8 description",
    });
    const registryPath = writeRegistry(registryDir, [
      { checkId: "CHK-001", frameworks: { "cis-m365-v6": { controlId: "1.1" } } },
      { checkId: "CHK-002", frameworks: { "essential-eight": { controlId: "ML1-P1" } } },
      { checkId: "CHK-003", frameworks: { "cis-m365-v6": {}, "essential-eight": {} } },
      { checkId: "CHK-004", frameworks: { cmmc: {} } },
      { checkId: "CHK-005" },
    ]);
    const expected: TestPack[] = [
      {
        id: "cis",
        name: "Fixture CIS",
        description: "Fixture CIS description",
        frameworkId: "cis-m365-v6",
        checks: ["CHK-001", "CHK-003"],
      },
      {
        id: "e8",
        name: "Fixture E8",
        description: "Fixture E8 description",
        frameworkId: "essential-eight",
        checks: ["CHK-002", "CHK-003"],
      },
    ];
    expect(loadTestPackCatalogue({ frameworksDir, registryPath })).toEqual(expected);
  });

  it("throws when a pack's framework JSON is missing", () => {
    const frameworksDir = tempDir();
    const registryDir = tempDir();
    const registryPath = writeRegistry(registryDir, []);
    expect(() => loadTestPackCatalogue({ frameworksDir, registryPath })).toThrow(
      /cis-m365-v6/,
    );
  });
});
