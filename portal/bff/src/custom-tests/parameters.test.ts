// T-0705 — custom-test parameter schema and validation. Proves a valid schema
// and value set round-trip, that unknown/mistyped/out-of-choice values carry
// stable codes, that secret parameters keep only a reference, and that the
// schema exposes a forward-compatibility version field.

import { describe, expect, it } from "vitest";
import {
  TEST_PARAMETER_SCHEMA_VERSION,
  TestParameterErrorCodes,
  TestParameterValidationError,
  isTestParameterSecretRef,
  parseTestParameterSchema,
  serializeTestParameterSchema,
  validateTestParameterValues,
  type TestParameterSchema,
} from "./parameters.js";

function expectViolation(
  fn: () => unknown,
  code: string,
  parameter?: string,
): TestParameterValidationError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TestParameterValidationError);
  const validation = thrown as TestParameterValidationError;
  const match = validation.violations.find(
    (violation) => violation.code === code && (parameter === undefined || violation.parameter === parameter),
  );
  expect(
    match,
    `expected a '${code}' violation for '${parameter ?? "*"}'; got ${JSON.stringify(validation.violations)}`,
  ).toBeDefined();
  return validation;
}

function validSchema(): TestParameterSchema {
  return {
    schemaVersion: TEST_PARAMETER_SCHEMA_VERSION,
    parameters: [
      { name: "siteUrl", type: "string", required: true, secret: false },
      { name: "retries", type: "number", required: false, default: 3, secret: false },
      {
        name: "mode",
        type: "string",
        required: false,
        default: "report",
        choices: ["report", "remediate"],
        secret: false,
      },
      { name: "verbose", type: "boolean", required: false, default: false, secret: false },
      { name: "apiKey", type: "string", required: false, secret: true },
    ],
  };
}

describe("parseTestParameterSchema", () => {
  it("parses a valid schema and exposes the version field", () => {
    const schema = parseTestParameterSchema(validSchema());
    expect(schema.schemaVersion).toBe(TEST_PARAMETER_SCHEMA_VERSION);
    expect(schema.parameters.map((parameter) => parameter.name)).toEqual([
      "siteUrl",
      "retries",
      "mode",
      "verbose",
      "apiKey",
    ]);
    expect(schema.parameters[2]?.choices).toEqual(["report", "remediate"]);
    expect(schema.parameters[4]?.secret).toBe(true);
  });

  it("defaults the version and empty parameters", () => {
    const schema = parseTestParameterSchema({});
    expect(schema.schemaVersion).toBe(TEST_PARAMETER_SCHEMA_VERSION);
    expect(schema.parameters).toEqual([]);
  });

  it("round-trips through serialize", () => {
    const schema = parseTestParameterSchema(validSchema());
    expect(parseTestParameterSchema(serializeTestParameterSchema(schema))).toEqual(schema);
  });

  it("parses a JSON string", () => {
    const schema = parseTestParameterSchema(JSON.stringify(validSchema()));
    expect(schema.parameters).toHaveLength(5);
  });

  it("rejects a non-object document", () => {
    expectViolation(() => parseTestParameterSchema("[]"), TestParameterErrorCodes.invalidSchema);
  });

  it("rejects an unsupported schema version", () => {
    expectViolation(
      () => parseTestParameterSchema({ schemaVersion: "v2", parameters: [] }),
      TestParameterErrorCodes.invalidSchema,
      "schemaVersion",
    );
  });

  it("rejects an unknown top-level field", () => {
    expectViolation(
      () => parseTestParameterSchema({ ...validSchema(), blob: {} }),
      TestParameterErrorCodes.invalidSchema,
      "blob",
    );
  });

  it("rejects an unknown definition field", () => {
    expectViolation(
      () =>
        parseTestParameterSchema({
          parameters: [{ name: "siteUrl", type: "string", script: "Get-Thing" }],
        }),
      TestParameterErrorCodes.invalidSchema,
      "parameters[0].script",
    );
  });

  it("rejects a malformed parameter name", () => {
    expectViolation(
      () => parseTestParameterSchema({ parameters: [{ name: "1bad name", type: "string" }] }),
      TestParameterErrorCodes.invalidSchema,
      "parameters[0].name",
    );
  });

  it("rejects duplicate parameter names", () => {
    expectViolation(
      () =>
        parseTestParameterSchema({
          parameters: [
            { name: "siteUrl", type: "string" },
            { name: "siteUrl", type: "string" },
          ],
        }),
      TestParameterErrorCodes.invalidSchema,
      "parameters[1].name",
    );
  });

  it("rejects an unsupported parameter type", () => {
    expectViolation(
      () => parseTestParameterSchema({ parameters: [{ name: "payload", type: "object" }] }),
      TestParameterErrorCodes.invalidSchema,
      "parameters[0].type",
    );
  });

  it("rejects a default that does not match its type", () => {
    expectViolation(
      () =>
        parseTestParameterSchema({
          parameters: [{ name: "retries", type: "number", default: "three" }],
        }),
      TestParameterErrorCodes.typeMismatch,
      "parameters[0].default",
    );
  });

  it("rejects a default outside its choices", () => {
    expectViolation(
      () =>
        parseTestParameterSchema({
          parameters: [{ name: "mode", type: "string", choices: ["report"], default: "delete" }],
        }),
      TestParameterErrorCodes.invalidChoice,
      "parameters[0].default",
    );
  });

  it("rejects a secret default that is a raw value", () => {
    expectViolation(
      () =>
        parseTestParameterSchema({
          parameters: [{ name: "apiKey", type: "string", secret: true, default: "s3cr3t" }],
        }),
      TestParameterErrorCodes.secretReferenceRequired,
      "parameters[0].default",
    );
  });

  it("accepts a secret default that is a reference", () => {
    const schema = parseTestParameterSchema({
      parameters: [
        { name: "apiKey", type: "string", secret: true, default: "ref://secrets/api-key/abc123" },
      ],
    });
    expect(schema.parameters[0]?.default).toBe("ref://secrets/api-key/abc123");
    expect(isTestParameterSecretRef(schema.parameters[0]?.default)).toBe(true);
  });
});

describe("validateTestParameterValues", () => {
  it("round-trips valid values and applies defaults", () => {
    const schema = parseTestParameterSchema(validSchema());
    const resolved = validateTestParameterValues(schema, {
      siteUrl: "https://contoso.example",
      mode: "remediate",
      apiKey: "ref://secrets/api-key/abc123",
    });
    expect(resolved).toEqual({
      siteUrl: "https://contoso.example",
      retries: 3,
      mode: "remediate",
      verbose: false,
      apiKey: "ref://secrets/api-key/abc123",
    });
  });

  it("accepts a schema passed as its serialized JSON", () => {
    const resolved = validateTestParameterValues(serializeTestParameterSchema(validSchema()), {
      siteUrl: "https://contoso.example",
    });
    expect(resolved["siteUrl"]).toBe("https://contoso.example");
  });

  it("rejects an unknown parameter with a stable code", () => {
    expectViolation(
      () => validateTestParameterValues(validSchema(), { siteUrl: "https://contoso.example", rogue: 1 }),
      TestParameterErrorCodes.unknownParameter,
      "rogue",
    );
  });

  it("rejects a type mismatch with a stable code", () => {
    expectViolation(
      () => validateTestParameterValues(validSchema(), { siteUrl: "https://contoso.example", retries: "3" }),
      TestParameterErrorCodes.typeMismatch,
      "retries",
    );
  });

  it("rejects an out-of-choice value with a stable code", () => {
    expectViolation(
      () => validateTestParameterValues(validSchema(), { siteUrl: "https://contoso.example", mode: "delete" }),
      TestParameterErrorCodes.invalidChoice,
      "mode",
    );
  });

  it("rejects a missing required parameter with a stable code", () => {
    expectViolation(
      () => validateTestParameterValues(validSchema(), {}),
      TestParameterErrorCodes.missingRequired,
      "siteUrl",
    );
  });

  it("stores only a secret reference and rejects a raw secret value", () => {
    const schema = parseTestParameterSchema(validSchema());
    const resolved = validateTestParameterValues(schema, {
      siteUrl: "https://contoso.example",
      apiKey: "cert://thumbprint/abcdef0123456789",
    });
    expect(resolved["apiKey"]).toBe("cert://thumbprint/abcdef0123456789");

    expectViolation(
      () =>
        validateTestParameterValues(schema, {
          siteUrl: "https://contoso.example",
          apiKey: "s3cr3t",
        }),
      TestParameterErrorCodes.secretReferenceRequired,
      "apiKey",
    );
  });

  it("rejects a non-object value set", () => {
    expectViolation(
      () => validateTestParameterValues(validSchema(), ["siteUrl"]),
      TestParameterErrorCodes.invalidValues,
      "parameters",
    );
  });

  it("rejects values validated against an invalid schema", () => {
    expectViolation(
      () => validateTestParameterValues({ parameters: [{ name: "x", type: "object" }] }, { x: 1 }),
      TestParameterErrorCodes.invalidSchema,
      "parameters[0].type",
    );
  });
});
