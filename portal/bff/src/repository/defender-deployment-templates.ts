// DefenderDeploymentTemplate entity (EPIC-019 SPEC §5): the setup-wizard output
// persisted so it can later be re-applied or saved as an Intune template
// (T-0364/T-0365). This module owns the entity shape, validation against the
// T-0361 policy-area registry, tenant scoping, and soft delete. It names no
// storage engine and contains no SQL: migration 0022 owns the relational shape
// and a portal/db adapter implements this interface for durable storage, while
// the in-memory implementation here wires the routes and the tests.
import { AppError, ErrorCodes, type ErrorDetail } from "../errors.js";

// v1 policy areas per EPIC-019 SPEC §11.2. T-0361 owns the canonical registry;
// this list is the default the repository validates against until the registry
// module lands and is injected via DefenderTemplateValidationOptions.
export const DEFENDER_POLICY_AREAS = ["av", "edr", "asr"] as const;
export type DefenderPolicyArea = (typeof DEFENDER_POLICY_AREAS)[number];

export interface DefenderDeploymentTemplate {
  id: string;
  tenantId: string;
  name: string;
  policyAreas: string[];
  policyJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface DefenderDeploymentTemplateInput {
  id: string;
  tenantId: string;
  name: string;
  policyAreas: readonly string[];
  policyJson: Record<string, unknown>;
}

export interface DefenderDeploymentTemplatePatch {
  name?: string;
  policyAreas?: readonly string[];
  policyJson?: Record<string, unknown>;
}

export interface DefenderTemplateListOptions {
  includeDeleted?: boolean;
  policyArea?: string;
}

export interface DefenderTemplateValidationOptions {
  policyAreas?: readonly string[];
}

export interface DefenderDeploymentTemplateRepository {
  get(
    tenantId: string,
    id: string,
    options?: DefenderTemplateListOptions,
  ): Promise<DefenderDeploymentTemplate | undefined>;
  list(
    tenantId: string,
    options?: DefenderTemplateListOptions,
  ): Promise<DefenderDeploymentTemplate[]>;
  create(
    input: DefenderDeploymentTemplateInput,
    options?: DefenderTemplateValidationOptions,
  ): Promise<DefenderDeploymentTemplate>;
  update(
    tenantId: string,
    id: string,
    patch: DefenderDeploymentTemplatePatch,
    options?: DefenderTemplateValidationOptions,
  ): Promise<DefenderDeploymentTemplate | undefined>;
  softDelete(tenantId: string, id: string, options?: { now?: string }): Promise<boolean>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationError(details: ErrorDetail[]): AppError {
  return new AppError(
    ErrorCodes.validationFailed,
    "invalid defender deployment template",
    400,
    details,
  );
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError([{ field, reason: "must be a non-empty string" }]);
  }
  return value.trim();
}

export function validateTemplateName(value: unknown): string {
  return requireNonEmptyString(value, "name");
}

export function validatePolicyAreas(
  value: unknown,
  options: DefenderTemplateValidationOptions = {},
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError([
      { field: "policyAreas", reason: "must be a non-empty array of policy areas" },
    ]);
  }
  const supported = new Set(options.policyAreas ?? DEFENDER_POLICY_AREAS);
  const seen = new Set<string>();
  const areas: string[] = [];
  const details: ErrorDetail[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      details.push({ field: `policyAreas[${index}]`, reason: "must be a non-empty string" });
      return;
    }
    if (!supported.has(entry)) {
      details.push({
        field: `policyAreas[${index}]`,
        reason: `unsupported policy area '${entry}'`,
      });
      return;
    }
    if (seen.has(entry)) {
      details.push({ field: `policyAreas[${index}]`, reason: `duplicate policy area '${entry}'` });
      return;
    }
    seen.add(entry);
    areas.push(entry);
  });
  if (details.length > 0) {
    throw validationError(details);
  }
  return areas;
}

export function validatePolicyJson(value: unknown): Record<string, unknown> {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      throw validationError([{ field: "policyJson", reason: "must be well-formed JSON" }]);
    }
  }
  if (!isPlainObject(candidate)) {
    throw validationError([{ field: "policyJson", reason: "must be a JSON object" }]);
  }
  return candidate;
}

function clone(template: DefenderDeploymentTemplate): DefenderDeploymentTemplate {
  return {
    ...template,
    policyAreas: [...template.policyAreas],
    policyJson: { ...template.policyJson },
  };
}

function buildTemplate(
  input: DefenderDeploymentTemplateInput,
  options: DefenderTemplateValidationOptions,
): DefenderDeploymentTemplate {
  const timestamp = nowIso();
  return {
    id: requireNonEmptyString(input.id, "id"),
    tenantId: requireNonEmptyString(input.tenantId, "tenantId"),
    name: validateTemplateName(input.name),
    policyAreas: validatePolicyAreas(input.policyAreas, options),
    policyJson: validatePolicyJson(input.policyJson),
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
}

export function createInMemoryDefenderDeploymentTemplateRepository(): DefenderDeploymentTemplateRepository {
  const rows = new Map<string, DefenderDeploymentTemplate>();
  const key = (tenantId: string, id: string): string => `${tenantId}\u0000${id}`;

  return {
    async get(tenantId, id, options = {}) {
      const row = rows.get(key(tenantId, id));
      if (!row) return undefined;
      if (options.includeDeleted !== true && row.deletedAt !== null) return undefined;
      return clone(row);
    },

    async list(tenantId, options = {}) {
      return [...rows.values()]
        .filter((row) => row.tenantId === tenantId)
        .filter((row) => options.includeDeleted === true || row.deletedAt === null)
        .filter(
          (row) => options.policyArea === undefined || row.policyAreas.includes(options.policyArea),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map(clone);
    },

    async create(input, options = {}) {
      const record = buildTemplate(input, options);
      rows.set(key(record.tenantId, record.id), record);
      return clone(record);
    },

    async update(tenantId, id, patch, options = {}) {
      const existing = rows.get(key(tenantId, id));
      if (!existing || existing.deletedAt !== null) return undefined;
      const updated: DefenderDeploymentTemplate = {
        ...existing,
        ...(patch.name === undefined ? {} : { name: validateTemplateName(patch.name) }),
        ...(patch.policyAreas === undefined
          ? {}
          : { policyAreas: validatePolicyAreas(patch.policyAreas, options) }),
        ...(patch.policyJson === undefined
          ? {}
          : { policyJson: validatePolicyJson(patch.policyJson) }),
        updatedAt: nowIso(),
      };
      rows.set(key(tenantId, id), updated);
      return clone(updated);
    },

    async softDelete(tenantId, id, options = {}) {
      const existing = rows.get(key(tenantId, id));
      if (!existing || existing.deletedAt !== null) return false;
      const at = options.now ?? nowIso();
      rows.set(key(tenantId, id), { ...existing, deletedAt: at, updatedAt: at });
      return true;
    },
  };
}
