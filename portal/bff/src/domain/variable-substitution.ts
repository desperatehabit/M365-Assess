// `%name%` substitution for standards templates (EPIC-002 SPEC.md §3.5/§5,
// EPIC-008 SPEC.md §4.5): settings tokens resolve from TenantVariable rows at
// run time. Tenant-scoped values win over globals; an unknown token fails
// loudly instead of substituting an empty string. The helper is pure and its
// errors name only the missing token, so secret values can never leak into
// logs or error responses through this path.

export const VARIABLE_SUBSTITUTION_UNKNOWN_TOKEN = "variable.unknown_token";

export class VariableSubstitutionError extends Error {
  readonly code = VARIABLE_SUBSTITUTION_UNKNOWN_TOKEN;
  readonly status = 400;
  readonly token: string;

  constructor(token: string) {
    super(
      `unknown tenant variable '%${token}%'; define it as a global or tenant variable before running the standard`,
    );
    this.name = "VariableSubstitutionError";
    this.token = token;
  }
}

export interface VariableEntry {
  readonly name: string;
  readonly value: string;
}

export interface VariableScopes {
  readonly global?: readonly VariableEntry[];
  readonly tenant?: readonly VariableEntry[];
}

const TOKEN_PATTERN = /%([A-Za-z0-9_][A-Za-z0-9_.-]*)%/g;

export const VARIABLE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function isVariableName(value: string): boolean {
  return VARIABLE_NAME_PATTERN.test(value);
}

export function extractVariableTokens(template: string): string[] {
  const seen = new Set<string>();
  TOKEN_PATTERN.lastIndex = 0;
  let match = TOKEN_PATTERN.exec(template);
  while (match !== null) {
    seen.add(match[1]!);
    match = TOKEN_PATTERN.exec(template);
  }
  TOKEN_PATTERN.lastIndex = 0;
  return [...seen];
}

function mergedVariables(scopes: VariableScopes): Map<string, string> {
  const merged = new Map<string, string>();
  for (const entry of scopes.global ?? []) {
    merged.set(entry.name, entry.value);
  }
  for (const entry of scopes.tenant ?? []) {
    merged.set(entry.name, entry.value);
  }
  return merged;
}

export function substituteVariables(template: string, scopes: VariableScopes): string {
  const merged = mergedVariables(scopes);
  return template.replace(TOKEN_PATTERN, (_token, name: string) => {
    const value = merged.get(name);
    if (value === undefined) {
      throw new VariableSubstitutionError(name);
    }
    return value;
  });
}
