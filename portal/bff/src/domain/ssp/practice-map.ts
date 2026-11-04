// Maps each NIST SP 800-171 practice to the M365-Assess registry checks that
// evidence it, from the module registry's "cmmc" framework mappings.
//
// Registry control ids come in three shapes:
//   "AC.L2-3.1.1" / "IA.L1-B.1.VI[a]"  Level 2 practice, Level 1 FAR practice
//   (an objective suffix such as "[a]" is dropped), and
//   "RA.L3-3.11.5E"                    Level 3 enhanced requirements, ignored here.
// FAR ids resolve through the catalog's level1Id, so "PE.L1-B.1.IX" covers
// 3.10.3, 3.10.4, and 3.10.5.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SSP_PRACTICES } from "@m365-assess/contracts/ssp";

export const DEFAULT_SSP_REGISTRY_PATH = fileURLToPath(
  new URL("../../../../../src/M365-Assess/controls/registry.json", import.meta.url),
);

export interface RegistryCheckLike {
  readonly checkId?: unknown;
  readonly frameworks?: unknown;
}

const LEVEL2_ID = /^[A-Z]{2}\.L2-(3\.\d+\.\d+)$/;
const LEVEL1_ID = /^([A-Z]{2}\.L1-B\.1\.[IVX]+)$/;

function practicesForControlId(raw: string, level1Index: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const id = raw.trim().replace(/\[[^\]]*\]$/, "");
  const level2 = LEVEL2_ID.exec(id);
  if (level2) return [level2[1]!];
  const level1 = LEVEL1_ID.exec(id);
  if (level1) return level1Index.get(level1[1]!) ?? [];
  return [];
}

/** Builds practiceId → sorted registry check ids. */
export function buildPracticeCheckMap(checks: readonly RegistryCheckLike[]): ReadonlyMap<string, readonly string[]> {
  const level1Index = new Map<string, string[]>();
  for (const entry of SSP_PRACTICES) {
    if (!entry.level1Id) continue;
    const list = level1Index.get(entry.level1Id) ?? [];
    list.push(entry.id);
    level1Index.set(entry.level1Id, list);
  }
  const map = new Map<string, Set<string>>();
  for (const check of checks) {
    if (typeof check.checkId !== "string") continue;
    const frameworks = check.frameworks as Record<string, { controlId?: unknown }> | undefined;
    const controlIds = frameworks?.["cmmc"]?.controlId;
    if (typeof controlIds !== "string") continue;
    for (const raw of controlIds.split(";")) {
      for (const practiceId of practicesForControlId(raw, level1Index)) {
        const set = map.get(practiceId) ?? new Set<string>();
        set.add(check.checkId);
        map.set(practiceId, set);
      }
    }
  }
  return new Map([...map].map(([practiceId, ids]) => [practiceId, [...ids].sort()]));
}

let cached: ReadonlyMap<string, readonly string[]> | undefined;

/** The practice map for the shipped registry, read once. */
export function loadPracticeCheckMap(registryPath: string = DEFAULT_SSP_REGISTRY_PATH): ReadonlyMap<string, readonly string[]> {
  if (registryPath === DEFAULT_SSP_REGISTRY_PATH && cached) return cached;
  const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as { checks?: RegistryCheckLike[] };
  const map = buildPracticeCheckMap(parsed.checks ?? []);
  if (registryPath === DEFAULT_SSP_REGISTRY_PATH) cached = map;
  return map;
}
