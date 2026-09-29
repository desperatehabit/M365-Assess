// Filter policy guard (EPIC-022 SPEC.md §3.1, §4.1, §8, §9; T-0422).
// Validates a proposed spam/anti-phish/malware/connection filter change and
// classifies disable/weakening changes as security-impacting (SPEC §4.1, §8):
// a disabling change surfaces the warning before apply, and every write is
// audited with before/after through the EPIC-006 gated executor (T-0107).
export const FILTER_TYPES = ["spam", "antiphish", "malware", "connection"] as const;

export type FilterType = (typeof FILTER_TYPES)[number];

export type FilterPolicyAction = "create" | "edit" | "enable" | "disable" | "delete";

export interface FilterPolicyState {
  readonly name: string;
  readonly enabled: boolean;
  readonly settings: Record<string, unknown>;
}

export interface FilterPolicyProposal {
  readonly action: FilterPolicyAction;
  readonly filterType: FilterType;
  readonly before?: FilterPolicyState | null;
  readonly after?: FilterPolicyState | null;
}

export interface FilterPolicyAssessment {
  readonly valid: boolean;
  readonly securityImpacting: boolean;
  readonly requiresConfirmation: boolean;
  readonly warning?: string;
  readonly reasons: readonly string[];
}

export const FILTER_SECURITY_IMPACTING_CODE = "filters.security_impacting";

export const FILTER_SECURITY_IMPACTING_WARNING =
  "Disabling or weakening a filter reduces protection against spam, phishing, or malware. " +
  "Review the plan preview before applying. This change is audited with before/after.";

const DESTRUCTIVE_ACTIONS: ReadonlySet<FilterPolicyAction> = new Set(["disable", "delete"]);

const SPAM_ACTION_STRENGTH: Readonly<Record<string, number>> = {
  quarantine: 4,
  movetojmf: 3,
  delete: 2,
  redirect: 1,
  allow: 0,
};

const MALWARE_ACTION_STRENGTH: Readonly<Record<string, number>> = {
  quarantine: 3,
  delete: 2,
  allow: 0,
};

function settingString(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function settingNumber(settings: Record<string, unknown>, key: string): number | undefined {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function settingBoolean(settings: Record<string, unknown>, key: string): boolean | undefined {
  const value = settings[key];
  return typeof value === "boolean" ? value : undefined;
}

function settingStringArray(settings: Record<string, unknown>, key: string): string[] | undefined {
  const value = settings[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function actionStrength(table: Readonly<Record<string, number>>, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return table[value.toLowerCase()];
}

function assessSpamWeakening(before: FilterPolicyState, after: FilterPolicyState, reasons: string[]): void {
  for (const key of ["spamAction", "highConfidenceSpamAction", "phishSpamAction", "bulkSpamAction"] as const) {
    const beforeStrength = actionStrength(SPAM_ACTION_STRENGTH, settingString(before.settings, key));
    const afterStrength = actionStrength(SPAM_ACTION_STRENGTH, settingString(after.settings, key));
    if (beforeStrength !== undefined && afterStrength !== undefined && afterStrength < beforeStrength) {
      reasons.push(`spam filter ${key} weakens from '${settingString(before.settings, key)}' to '${settingString(after.settings, key)}'`);
    }
  }
  const beforeThreshold = settingNumber(before.settings, "bulkThreshold");
  const afterThreshold = settingNumber(after.settings, "bulkThreshold");
  if (beforeThreshold !== undefined && afterThreshold !== undefined && afterThreshold > beforeThreshold) {
    reasons.push(`spam filter bulkThreshold raises from ${beforeThreshold} to ${afterThreshold}, letting more bulk mail through`);
  }
  for (const key of ["spamZapEnabled", "phishZapEnabled"] as const) {
    if (settingBoolean(before.settings, key) === true && settingBoolean(after.settings, key) === false) {
      reasons.push(`spam filter ${key} is disabled`);
    }
  }
}

function assessAntiPhishWeakening(before: FilterPolicyState, after: FilterPolicyState, reasons: string[]): void {
  const beforeLevel = settingNumber(before.settings, "phishThresholdLevel");
  const afterLevel = settingNumber(after.settings, "phishThresholdLevel");
  if (beforeLevel !== undefined && afterLevel !== undefined && afterLevel > beforeLevel) {
    reasons.push(`anti-phish threshold level raises from ${beforeLevel} to ${afterLevel}, detecting less phish`);
  }
  for (const key of [
    "enableMailboxIntelligence",
    "enableMailboxIntelligenceProtection",
    "enableSpoofIntelligence",
    "enableFirstContactSafetyTips",
    "enableUnauthenticatedSender",
    "enableViaTag",
  ] as const) {
    if (settingBoolean(before.settings, key) === true && settingBoolean(after.settings, key) === false) {
      reasons.push(`anti-phish protection ${key} is disabled`);
    }
  }
}

function assessMalwareWeakening(before: FilterPolicyState, after: FilterPolicyState, reasons: string[]): void {
  const beforeStrength = actionStrength(MALWARE_ACTION_STRENGTH, settingString(before.settings, "fileFilterAction"));
  const afterStrength = actionStrength(MALWARE_ACTION_STRENGTH, settingString(after.settings, "fileFilterAction"));
  if (beforeStrength !== undefined && afterStrength !== undefined && afterStrength < beforeStrength) {
    reasons.push(`malware filter fileFilterAction weakens from '${settingString(before.settings, "fileFilterAction")}' to '${settingString(after.settings, "fileFilterAction")}'`);
  }
  if (settingBoolean(before.settings, "zapEnabled") === true && settingBoolean(after.settings, "zapEnabled") === false) {
    reasons.push("malware filter zapEnabled is disabled");
  }
  if (settingBoolean(before.settings, "enableFileFilter") === true && settingBoolean(after.settings, "enableFileFilter") === false) {
    reasons.push("malware filter enableFileFilter is disabled");
  }
}

function assessConnectionWeakening(before: FilterPolicyState, after: FilterPolicyState, reasons: string[]): void {
  const beforeAllow = settingStringArray(before.settings, "ipAllowList") ?? [];
  const afterAllow = settingStringArray(after.settings, "ipAllowList") ?? [];
  const added = afterAllow.filter((ip) => !beforeAllow.includes(ip));
  if (added.length > 0) {
    reasons.push(`connection filter IPAllowList gains ${added.length} entr${added.length === 1 ? "y" : "ies"} bypassing the filter`);
  }
  if (settingBoolean(before.settings, "enableSafeList") === true && settingBoolean(after.settings, "enableSafeList") === false) {
    reasons.push("connection filter enableSafeList is disabled");
  }
}

function validateProposal(proposal: FilterPolicyProposal): string[] {
  const errors: string[] = [];
  if (!(FILTER_TYPES as readonly string[]).includes(proposal.filterType)) {
    errors.push(`filterType must be one of: ${FILTER_TYPES.join(", ")}`);
  }
  if (proposal.action === "create") {
    const after = proposal.after;
    if (!after || typeof after.name !== "string" || after.name.trim().length === 0) {
      errors.push("after.name is required for create");
    }
    if (!after || typeof after.settings !== "object" || after.settings === null || Array.isArray(after.settings)) {
      errors.push("after.settings is required for create");
    }
  } else if (proposal.action === "edit" || proposal.action === "enable" || proposal.action === "disable") {
    if (!proposal.before || typeof proposal.before.name !== "string" || proposal.before.name.trim().length === 0) {
      errors.push("before state is required for edit/enable/disable");
    }
    if (!proposal.after || typeof proposal.after.name !== "string" || proposal.after.name.trim().length === 0) {
      errors.push("after state is required for edit/enable/disable");
    }
  } else if (proposal.action === "delete") {
    if (!proposal.before || typeof proposal.before.name !== "string" || proposal.before.name.trim().length === 0) {
      errors.push("before state is required for delete");
    }
  } else {
    errors.push(`unknown action: ${String(proposal.action)}`);
  }
  return errors;
}

export function assessFilterPolicyChange(proposal: FilterPolicyProposal): FilterPolicyAssessment {
  const errors = validateProposal(proposal);
  if (errors.length > 0) {
    return {
      valid: false,
      securityImpacting: false,
      requiresConfirmation: false,
      reasons: errors,
    };
  }

  const reasons: string[] = [];
  const { action, before, after } = proposal;

  if (action === "disable") {
    reasons.push(`filter '${before?.name}' is disabled, weakening protection`);
  } else if (action === "delete") {
    reasons.push(`filter '${before?.name}' is deleted, removing a protection layer`);
  } else if (action === "edit" && before && after) {
    switch (proposal.filterType) {
      case "spam":
        assessSpamWeakening(before, after, reasons);
        break;
      case "antiphish":
        assessAntiPhishWeakening(before, after, reasons);
        break;
      case "malware":
        assessMalwareWeakening(before, after, reasons);
        break;
      case "connection":
        assessConnectionWeakening(before, after, reasons);
        break;
    }
  }

  const securityImpacting = DESTRUCTIVE_ACTIONS.has(action) || reasons.length > 0;
  return {
    valid: true,
    securityImpacting,
    requiresConfirmation: securityImpacting,
    ...(securityImpacting ? { warning: FILTER_SECURITY_IMPACTING_WARNING } : {}),
    reasons,
  };
}
