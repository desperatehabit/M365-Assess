// Feature-flag enforcement seam (EPIC-037 SPEC.md §3.3, §9). Nav and endpoint
// code both consult this one guard so the UI can never show a feature the API
// disables: a disabled or unknown flag is a structured 403, not a silent 404
// or a rendered nav item. The guard reads the same Repository source the
// /v1/feature-flags API serves, so there is exactly one source of truth.
import { AppError } from "../errors.js";
import type { FeatureFlag } from "@m365-assess/db";

export const FEATURE_FLAG_DISABLED = "feature_flag.disabled";

/** Structured "feature disabled" error (SPEC §9): stable code, 403, client-safe. */
export class FeatureDisabledError extends AppError {
  constructor(key: string) {
    super(FEATURE_FLAG_DISABLED, `feature '${key}' is disabled`, 403, [
      { field: "feature", reason: "disabled" },
    ]);
    this.name = "FeatureDisabledError";
  }
}

/** The flag source the guard consults — the Repository satisfies this as-is. */
export interface FeatureFlagSource {
  getFeatureFlags(): Promise<FeatureFlag[]>;
}

export function isFeatureEnabled(flags: readonly FeatureFlag[], key: string): boolean {
  return flags.some((flag) => flag.key === key && flag.enabled);
}

/**
 * The single server-side guard. Throws {@link FeatureDisabledError} when the
 * flag is missing or disabled; returns undefined when the feature is on.
 */
export async function assertFeatureEnabled(
  source: FeatureFlagSource,
  key: string,
): Promise<void> {
  const flags = await source.getFeatureFlags();
  if (!isFeatureEnabled(flags, key)) {
    throw new FeatureDisabledError(key);
  }
}
