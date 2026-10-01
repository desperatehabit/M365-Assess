// Custom-test parameter schema and validation (EPIC-036 SPEC.md §3.2, §11.4;
// T-0705). A custom test's `parameters` document is a typed, versioned schema
// of primitive parameter definitions, never a free-form blob. The same
// validator runs on author-save (parseTestParameterSchema) and again on run
// (validateTestParameterValues), rejecting unknown parameters, type mismatches,
// and out-of-choice values with stable codes.
//
// Secret parameters are reference-only: a secret default or run value must be a
// reference (ref:// or cert://), so secret material is never persisted in the
// schema or in a validated parameter set.

export const TEST_PARAMETER_SCHEMA_VERSION = "v1" as const;

export type TestParameterSchemaVersion = typeof TEST_PARAMETER_SCHEMA_VERSION;

export const TEST_PARAMETER_TYPES = ["string", "number", "boolean"] as const;

export type TestParameterType = (typeof TEST_PARAMETER_TYPES)[number];

export const TEST_PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const SECRET_REFERENCE_PATTERN = /^(?:ref|cert):\/\/\S+$/;

export interface TestParameterDefinition {
  readonly name: string;
  readonly type: TestParameterType;
  readonly required: boolean;
  readonly default?: unknown;
  readonly choices?: readonly unknown[];
  readonly secret: boolean;
}

export interface TestParameterSchema {
  readonly schemaVersion: TestParameterSchemaVersion;
  readonly parameters: readonly TestParameterDefinition[];
}

export type TestParameterValues = Record<string, unknown>;

export const TestParameterErrorCodes = {
  invalidSchema: "test-parameter.invalid_schema",
  invalidValues: "test-parameter.invalid_values",
  unknownParameter: "test-parameter.unknown_parameter",
  missingRequired: "test-parameter.missing_required",
  typeMismatch: "test-parameter.type_mismatch",
  invalidChoice: "test-parameter.invalid_choice",
  secretReferenceRequired: "test-parameter.secret_reference_required",
} as const;

export type TestParameterErrorCode =
  (typeof TestParameterErrorCodes)[keyof typeof TestParameterErrorCodes];

export interface TestParameterViolation {
  readonly code: TestParameterErrorCode;
  readonly parameter: string;
  readonly reason: string;
}

export class TestParameterValidationError extends Error {
  readonly code = "test-parameter.invalid";
  readonly violations: readonly TestParameterViolation[];

  constructor(violations: readonly TestParameterViolation[]) {
    super(violations.map((violation) => `${violation.parameter}: ${violation.reason}`).join("; "));
    this.name = "TestParameterValidationError";
    this.violations = violations;
  }
}

const SCHEMA_FIELDS = new Set(["schemaVersion", "parameters"]);
const DEFINITION_FIELDS = new Set(["name", "type", "required", "default", "choices", "secret"]);
const TYPE_SET = new Set<string>(TEST_PARAMETER_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTestParameterSecretRef(value: unknown): value is string {
  return typeof value === "string" && SECRET_REFERENCE_PATTERN.test(value);
}

function matchesType(value: unknown, type: TestParameterType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function violation(
  code: TestParameterErrorCode,
  parameter: string,
  reason: string,
): TestParameterViolation {
  return { code, parameter, reason };
}

function parseJsonInput(input: string | unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new TestParameterValidationError([
      violation(TestParameterErrorCodes.invalidSchema, "parameters", "parameters are not valid JSON"),
    ]);
  }
}

function parseChoices(
  raw: unknown,
  field: string,
  type: TestParameterType | undefined,
  secret: boolean,
  violations: TestParameterViolation[],
): readonly unknown[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    violations.push(
      violation(TestParameterErrorCodes.invalidSchema, field, `${field} must be a non-empty array`),
    );
    return undefined;
  }
  const seen = new Set<unknown>();
  const choices: unknown[] = [];
  for (const [index, choice] of raw.entries()) {
    const choiceField = `${field}[${index}]`;
    if (type !== undefined && !matchesType(choice, type)) {
      violations.push(
        violation(TestParameterErrorCodes.invalidSchema, choiceField, `${choiceField} must be a ${type}`),
      );
      continue;
    }
    if (secret && !isTestParameterSecretRef(choice)) {
      violations.push(
        violation(
          TestParameterErrorCodes.invalidSchema,
          choiceField,
          `${choiceField} must be a secret reference`,
        ),
      );
      continue;
    }
    if (seen.has(choice)) {
      violations.push(
        violation(TestParameterErrorCodes.invalidSchema, field, `${field} has a duplicate entry`),
      );
      continue;
    }
    seen.add(choice);
    choices.push(choice);
  }
  return choices;
}

function parseDefinition(
  entry: unknown,
  index: number,
  violations: TestParameterViolation[],
): TestParameterDefinition | undefined {
  const field = `parameters[${index}]`;
  const before = violations.length;
  if (!isRecord(entry)) {
    violations.push(
      violation(TestParameterErrorCodes.invalidSchema, field, `${field} must be an object`),
    );
    return undefined;
  }
  for (const key of Object.keys(entry)) {
    if (!DEFINITION_FIELDS.has(key)) {
      violations.push(
        violation(
          TestParameterErrorCodes.invalidSchema,
          `${field}.${key}`,
          `${field} has an unknown field '${key}'`,
        ),
      );
    }
  }

  const name = entry["name"];
  if (typeof name !== "string" || !TEST_PARAMETER_NAME_PATTERN.test(name)) {
    violations.push(
      violation(
        TestParameterErrorCodes.invalidSchema,
        `${field}.name`,
        `${field}.name must be a parameter name such as 'tenantId'`,
      ),
    );
  }

  const rawType = entry["type"];
  const type =
    typeof rawType === "string" && TYPE_SET.has(rawType) ? (rawType as TestParameterType) : undefined;
  if (type === undefined) {
    violations.push(
      violation(
        TestParameterErrorCodes.invalidSchema,
        `${field}.type`,
        `${field}.type must be one of ${TEST_PARAMETER_TYPES.join(", ")}`,
      ),
    );
  }

  const required = entry["required"] === undefined ? false : entry["required"];
  if (typeof required !== "boolean") {
    violations.push(
      violation(TestParameterErrorCodes.invalidSchema, `${field}.required`, `${field}.required must be a boolean`),
    );
  }

  const secret = entry["secret"] === undefined ? false : entry["secret"];
  if (typeof secret !== "boolean") {
    violations.push(
      violation(TestParameterErrorCodes.invalidSchema, `${field}.secret`, `${field}.secret must be a boolean`),
    );
  }

  const choices =
    entry["choices"] === undefined
      ? undefined
      : parseChoices(entry["choices"], `${field}.choices`, type, secret === true, violations);

  if (entry["default"] !== undefined) {
    const value = entry["default"];
    if (secret === true) {
      if (!isTestParameterSecretRef(value)) {
        violations.push(
          violation(
            TestParameterErrorCodes.secretReferenceRequired,
            `${field}.default`,
            `${field}.default must be a secret reference; secret values are never persisted`,
          ),
        );
      }
    } else if (type !== undefined && !matchesType(value, type)) {
      violations.push(
        violation(TestParameterErrorCodes.typeMismatch, `${field}.default`, `${field}.default must be a ${type}`),
      );
    } else if (choices !== undefined && !choices.includes(value)) {
      violations.push(
        violation(TestParameterErrorCodes.invalidChoice, `${field}.default`, `${field}.default must be one of its choices`),
      );
    }
  }

  if (violations.length > before) return undefined;
  const definition: {
    name: string;
    type: TestParameterType;
    required: boolean;
    default?: unknown;
    choices?: readonly unknown[];
    secret: boolean;
  } = {
    name: name as string,
    type: type as TestParameterType,
    required: required as boolean,
    secret: secret === true,
  };
  if (entry["default"] !== undefined) definition.default = entry["default"];
  if (choices !== undefined) definition.choices = choices;
  return definition;
}

export function parseTestParameterSchema(input: string | unknown): TestParameterSchema {
  const record = parseJsonInput(input);
  if (!isRecord(record)) {
    throw new TestParameterValidationError([
      violation(TestParameterErrorCodes.invalidSchema, "parameters", "parameters must be a JSON object"),
    ]);
  }

  const violations: TestParameterViolation[] = [];
  for (const key of Object.keys(record)) {
    if (!SCHEMA_FIELDS.has(key)) {
      violations.push(
        violation(TestParameterErrorCodes.invalidSchema, key, `parameters has an unknown field '${key}'`),
      );
    }
  }

  const version = record["schemaVersion"];
  if (version !== undefined && version !== TEST_PARAMETER_SCHEMA_VERSION) {
    violations.push(
      violation(
        TestParameterErrorCodes.invalidSchema,
        "schemaVersion",
        `parameters have unsupported schemaVersion ${JSON.stringify(version)}; expected ${TEST_PARAMETER_SCHEMA_VERSION}`,
      ),
    );
  }

  const definitions: TestParameterDefinition[] = [];
  const rawParameters = record["parameters"] === undefined ? [] : record["parameters"];
  if (!Array.isArray(rawParameters)) {
    violations.push(
      violation(TestParameterErrorCodes.invalidSchema, "parameters", "parameters must be an array"),
    );
  } else {
    const seen = new Set<string>();
    for (const [index, entry] of rawParameters.entries()) {
      const definition = parseDefinition(entry, index, violations);
      if (definition === undefined) continue;
      if (seen.has(definition.name)) {
        violations.push(
          violation(
            TestParameterErrorCodes.invalidSchema,
            `parameters[${index}].name`,
            `parameters has a duplicate name '${definition.name}'`,
          ),
        );
        continue;
      }
      seen.add(definition.name);
      definitions.push(definition);
    }
  }

  if (violations.length > 0) throw new TestParameterValidationError(violations);
  return { schemaVersion: TEST_PARAMETER_SCHEMA_VERSION, parameters: definitions };
}

export function serializeTestParameterSchema(schema: TestParameterSchema): string {
  return JSON.stringify(parseTestParameterSchema(schema));
}

/**
 * Validates run-time parameter values against a schema and returns the resolved
 * set: defaults fill absent optional parameters, unknown keys are rejected, and
 * a secret parameter keeps only its reference. The same call is the author-save
 * gate for a test's parameters.
 */
export function validateTestParameterValues(
  schema: TestParameterSchema | string | unknown,
  values: unknown,
): TestParameterValues {
  const parsed = parseTestParameterSchema(schema);
  if (!isRecord(values)) {
    throw new TestParameterValidationError([
      violation(TestParameterErrorCodes.invalidValues, "parameters", "parameter values must be an object"),
    ]);
  }

  const violations: TestParameterViolation[] = [];
  const definitions = new Map(parsed.parameters.map((definition) => [definition.name, definition]));
  for (const key of Object.keys(values)) {
    if (!definitions.has(key)) {
      violations.push(
        violation(TestParameterErrorCodes.unknownParameter, key, `unknown parameter '${key}'`),
      );
    }
  }

  const resolved: TestParameterValues = {};
  for (const definition of parsed.parameters) {
    if (!Object.prototype.hasOwnProperty.call(values, definition.name)) {
      if (definition.default !== undefined) {
        resolved[definition.name] = definition.default;
      } else if (definition.required) {
        violations.push(
          violation(
            TestParameterErrorCodes.missingRequired,
            definition.name,
            `parameter '${definition.name}' is required`,
          ),
        );
      }
      continue;
    }

    const value = values[definition.name];
    if (definition.secret) {
      if (!isTestParameterSecretRef(value)) {
        violations.push(
          violation(
            TestParameterErrorCodes.secretReferenceRequired,
            definition.name,
            `parameter '${definition.name}' must be a secret reference; secret values are never persisted`,
          ),
        );
        continue;
      }
      resolved[definition.name] = value;
      continue;
    }

    if (!matchesType(value, definition.type)) {
      violations.push(
        violation(
          TestParameterErrorCodes.typeMismatch,
          definition.name,
          `parameter '${definition.name}' must be a ${definition.type}`,
        ),
      );
      continue;
    }
    if (definition.choices !== undefined && !definition.choices.includes(value)) {
      violations.push(
        violation(
          TestParameterErrorCodes.invalidChoice,
          definition.name,
          `parameter '${definition.name}' must be one of ${JSON.stringify(definition.choices)}`,
        ),
      );
      continue;
    }
    resolved[definition.name] = value;
  }

  if (violations.length > 0) throw new TestParameterValidationError(violations);
  return resolved;
}
