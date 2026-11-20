// Shared built-in template contract (T-0924).
//
// Pre-defined templates are served read-only: they can be read and copied, but
// never edited or deleted in place. Every family that ships built-in content
// uses the same marker (`builtIn: true`), the same 403 code
// (`template.builtin_locked`) and the same `(copy)` naming convention, so the
// API and the web UI can treat them uniformly. T-0922's run templates reuse
// this module, and T-0923's report templates follow the same shape.
import { AppError } from "../errors.js";

/** The one shared code returned by PATCH/DELETE on a built-in template. */
export const TEMPLATE_BUILTIN_LOCKED = "template.builtin_locked";

/** The copy suffix used for the first copy of a template. */
export const TEMPLATE_COPY_SUFFIX = " (copy)";

/**
 * Raised when a caller tries to mutate a pre-defined template. The copy route is
 * the supported path, so the message names it and the details identify the id.
 */
export function builtinLockedError(kind: string, id: string): AppError {
  return new AppError(
    TEMPLATE_BUILTIN_LOCKED,
    `Built-in ${kind} '${id}' is locked; make a copy to edit it`,
    403,
    [{ field: "id", reason: "builtin_locked" }],
  );
}

/**
 * True when a record is marked pre-defined. Kept structural so every template
 * family can use it without importing each other's record types.
 */
export function isBuiltInTemplate(value: { readonly builtIn?: boolean } | undefined): boolean {
  return value?.builtIn === true;
}

/**
 * Returns a copy name that does not collide with an existing template. Follows
 * the long-standing `"<name> (copy)"` convention, then `"(copy 2)"`, ….
 */
export function copyTemplateName(
  baseName: string,
  existingNames: Iterable<string>,
): string {
  const names = new Set(existingNames);
  const first = `${baseName}${TEMPLATE_COPY_SUFFIX}`;
  if (!names.has(first)) return first;
  for (let index = 2; ; index += 1) {
    const candidate = `${baseName} (copy ${index})`;
    if (!names.has(candidate)) return candidate;
  }
}
