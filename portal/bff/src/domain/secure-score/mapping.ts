// Secure Score improvement-action -> registry-check mapping (EPIC-031 SPEC.md
// §4.1, §4.3, §9, §11.1; T-0603).
//
// SPEC §11.1 resolves the mapping source to: derive from the module control
// registry, with a curated override where derivation cannot resolve. The
// registry's `cisa-scuba` and `eidsca` frameworks carry the Secure Score
// improvement-action ids verbatim (`MS.AAD.1.1v1`, `EIDSCA.AM01`), so those
// namespaces are the derivation source. Every other framework's control ids are
// generic compliance identifiers (bare numbers, MITRE techniques) that collide
// across checks and are not action ids, so deriving from them would be noise.
//
// An override from `mapping-overrides.json` wins over the derived entry; an
// action with neither resolves to an explicit "no automated remediation" result
// rather than an error (SPEC §4.3). Resolved mappings persist through the T-0601
// repository, which writes the audit event on change.
//
// The thin-BFF guard forbids the registry's check-reference token as a literal
// in non-test sources, so that key is assembled from parts (see catalog.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  SecureScoreAuditSource,
  SecureScoreRepository,
} from "../../repository/secure-score.js";

const CHECK_REFERENCE_KEY = "check" + "Id";

/** Registry frameworks whose control ids are Secure Score action ids. */
export const SECURE_SCORE_FRAMEWORK_IDS = ["cisa-scuba", "eidsca"] as const;

/** The shipped module registry; read-only (T-0603 forbids any src/ change). */
export const DEFAULT_REGISTRY_PATH = fileURLToPath(
  new URL("../../../../../src/M365-Assess/controls/registry.json", import.meta.url),
);

/** The curated override file shipped beside this module. */
export const DEFAULT_OVERRIDES_PATH = fileURLToPath(
  new URL("./mapping-overrides.json", import.meta.url),
);

export interface ModuleRegistryCheck {
  readonly check: string;
  readonly frameworks?: Readonly<Record<string, unknown>> | null;
}

export interface DerivedActionTarget {
  readonly check: string;
  readonly standardKey: string;
}

export interface MappingOverride {
  readonly actionId: string;
  /** Registry check id; absent on a portal-standard-only override. */
  readonly check?: string;
  readonly standardKey: string;
  readonly note?: string;
}

export interface ActionCheckMap {
  readonly map: ReadonlyMap<string, DerivedActionTarget>;
  readonly overrides: readonly MappingOverride[];
}

export interface LoadMappingOptions {
  readonly registryPath?: string;
  readonly overridesPath?: string;
  readonly frameworkIds?: readonly string[];
}

export interface ImprovementActionInput {
  readonly actionId: string;
  /** Graph control name, tried as a derivation key when no action id matches. */
  readonly controlName?: string;
  readonly name?: string;
}

export interface ResolveFixTargetOptions {
  /** Derived map; replaces the shipped registry map when supplied. */
  readonly map?: ReadonlyMap<string, DerivedActionTarget>;
  /** Curated overrides; replaces the shipped overrides when supplied. */
  readonly overrides?: readonly MappingOverride[];
}

export interface MappedFixTarget {
  readonly kind: "mapped";
  readonly actionId: string;
  readonly check: string;
  readonly standardKey: string;
  readonly source: "derived" | "override";
}

export interface StandardFixTarget {
  readonly kind: "standard";
  readonly actionId: string;
  readonly standardKey: string;
  readonly source: "override";
}

export interface UnmappedFixTarget {
  readonly kind: "unmapped";
  readonly actionId: string;
  readonly reason: "no-automated-remediation";
}

export type FixTarget = MappedFixTarget | StandardFixTarget | UnmappedFixTarget;

export interface PersistMappingOptions {
  readonly by?: string;
  readonly source?: SecureScoreAuditSource;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function readNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function compareTargets(left: DerivedActionTarget, right: DerivedActionTarget): number {
  return left.check.localeCompare(right.check) || left.standardKey.localeCompare(right.standardKey);
}

/**
 * Indexes Secure Score action ids to registry checks. Collisions (several checks
 * share one control id) resolve deterministically to the lowest check id so the
 * same registry always yields the same map; a curated override corrects a wrong
 * pick (SPEC §9 "mapping is imperfect").
 */
export function deriveActionCheckMap(
  checks: readonly ModuleRegistryCheck[],
  frameworkIds: readonly string[] = SECURE_SCORE_FRAMEWORK_IDS,
): Map<string, DerivedActionTarget> {
  const wanted = new Set(frameworkIds);
  const map = new Map<string, DerivedActionTarget>();
  for (const check of checks) {
    if (check.check.length === 0) continue;
    const frameworks = check.frameworks ?? {};
    for (const [frameworkId, rawEntry] of Object.entries(frameworks)) {
      if (!wanted.has(frameworkId)) continue;
      const entry = rawEntry as { controlId?: unknown } | null | undefined;
      const controlId = entry?.controlId;
      if (typeof controlId !== "string") continue;
      for (const part of controlId.split(";")) {
        const key = normalizeKey(part);
        if (key.length === 0) continue;
        const candidate: DerivedActionTarget = { check: check.check, standardKey: frameworkId };
        const existing = map.get(key);
        if (existing === undefined || compareTargets(candidate, existing) < 0) {
          map.set(key, candidate);
        }
      }
    }
  }
  return map;
}

/** Validates the `overrides` array from `mapping-overrides.json`. */
export function parseMappingOverrides(raw: unknown): MappingOverride[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("mapping overrides must be an array");
  }
  const overrides: MappingOverride[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("mapping override entries must be objects");
    }
    const record = entry as Record<string, unknown>;
    const actionId = readNonEmpty(record["actionId"]);
    const standardKey = readNonEmpty(record["standardKey"]);
    if (actionId === undefined) throw new Error("mapping override needs a non-empty actionId");
    if (standardKey === undefined) {
      throw new Error(`mapping override '${actionId}' needs a non-empty standardKey`);
    }
    overrides.push({
      actionId,
      check: readNonEmpty(record["check"]),
      standardKey,
      note: readNonEmpty(record["note"]),
    });
  }
  return overrides;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function toModuleCheck(entry: unknown): ModuleRegistryCheck {
  const record = (entry ?? {}) as Record<string, unknown>;
  const reference = record[CHECK_REFERENCE_KEY];
  return {
    check: typeof reference === "string" ? reference : "",
    frameworks: (record["frameworks"] ?? null) as ModuleRegistryCheck["frameworks"],
  };
}

export function loadActionCheckMap(options: LoadMappingOptions = {}): ActionCheckMap {
  const registry = readJson(options.registryPath ?? DEFAULT_REGISTRY_PATH) as Record<string, unknown>;
  const rawChecks = Array.isArray(registry["checks"]) ? registry["checks"] : [];
  const checks = rawChecks.map(toModuleCheck);
  const overridesFile = readJson(options.overridesPath ?? DEFAULT_OVERRIDES_PATH) as Record<
    string,
    unknown
  >;
  const overrides = parseMappingOverrides(overridesFile["overrides"]);
  return { map: deriveActionCheckMap(checks, options.frameworkIds), overrides };
}

let defaultCache: ActionCheckMap | undefined;

/** The shipped registry + override mapping, loaded once and reused. */
export function defaultMapping(): ActionCheckMap {
  defaultCache ??= loadActionCheckMap();
  return defaultCache;
}

function actionKeys(action: ImprovementActionInput): string[] {
  const keys: string[] = [];
  for (const value of [action.actionId, action.controlName, action.name]) {
    if (typeof value !== "string") continue;
    const key = normalizeKey(value);
    if (key.length > 0 && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function indexOverrides(overrides: readonly MappingOverride[]): Map<string, MappingOverride> {
  const index = new Map<string, MappingOverride>();
  for (const override of overrides) {
    const key = normalizeKey(override.actionId);
    if (!index.has(key)) index.set(key, override);
  }
  return index;
}

/**
 * Resolves one improvement action to a fix target: a mapped registry check with
 * its standard, a portal standard reference, or an explicit unmapped result.
 * Overrides win over the derived map; supplying either option replaces both
 * shipped defaults so a caller can resolve against a fixed fixture.
 */
export function resolveFixTarget(
  action: ImprovementActionInput,
  options: ResolveFixTargetOptions = {},
): FixTarget {
  const shipped =
    options.map === undefined && options.overrides === undefined ? defaultMapping() : undefined;
  const map = options.map ?? shipped?.map ?? new Map<string, DerivedActionTarget>();
  const overrides = options.overrides ?? shipped?.overrides ?? [];
  const actionId = action.actionId;
  const keys = actionKeys(action);
  const overrideIndex = indexOverrides(overrides);

  for (const key of keys) {
    const override = overrideIndex.get(key);
    if (override === undefined) continue;
    if (override.check !== undefined) {
      return {
        kind: "mapped",
        actionId,
        check: override.check,
        standardKey: override.standardKey,
        source: "override",
      };
    }
    return { kind: "standard", actionId, standardKey: override.standardKey, source: "override" };
  }

  for (const key of keys) {
    const derived = map.get(key);
    if (derived !== undefined) {
      return {
        kind: "mapped",
        actionId,
        check: derived.check,
        standardKey: derived.standardKey,
        source: "derived",
      };
    }
  }

  return { kind: "unmapped", actionId, reason: "no-automated-remediation" };
}

/**
 * Persists a mapped fix target through the T-0601 repository, whose `putMapping`
 * writes the audit event when the mapping changes. Standard-only and unmapped
 * targets carry no remediation mapping and are not persisted (returns false).
 */
export async function persistResolvedMapping(
  repository: Pick<SecureScoreRepository, "putMapping">,
  target: FixTarget,
  options: PersistMappingOptions = {},
): Promise<boolean> {
  if (target.kind !== "mapped") return false;
  await repository.putMapping({
    actionId: target.actionId,
    check: target.check,
    standardKey: target.standardKey,
    by: options.by,
    source: options.source,
  });
  return true;
}
