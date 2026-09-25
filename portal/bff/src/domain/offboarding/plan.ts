// EPIC-011 SPEC.md §4.4: the offboarding wizard builds an ordered plan of steps
// before any tenant write. §11.1 resolves v1 to the first-cut catalogue below.
// Options outside the catalogue are rejected rather than silently ignored, and
// the resolved mailbox access mode is recorded on the plan for the worker. This
// module is pure and performs no tenant write (T-0206 executes the plan).

export const OFFBOARDING_STEP_CATALOGUE = [
  { option: "disableSignIn", action: "disable-sign-in" },
  { option: "removeLicenses", action: "remove-licenses" },
  { option: "convertMailbox", action: "convert-mailbox" },
  { option: "removeGroups", action: "remove-groups" },
] as const;

export type OffboardingStepAction = (typeof OFFBOARDING_STEP_CATALOGUE)[number]["action"];

export const MAILBOX_ACCESS_MODES = ["full", "send-as", "send-on-behalf"] as const;

export type MailboxAccessMode = (typeof MAILBOX_ACCESS_MODES)[number];

export interface MailboxAccess {
  readonly mode: MailboxAccessMode;
  readonly automap: boolean;
}

export interface OffboardingPlanOptions {
  readonly disableSignIn?: boolean;
  readonly removeLicenses?: boolean;
  readonly convertMailbox?: boolean;
  readonly removeGroups?: boolean;
  readonly mailboxAccess?: Partial<MailboxAccess>;
}

export interface OffboardingPlanStep {
  readonly order: number;
  readonly action: OffboardingStepAction;
}

export interface OffboardingPlan {
  readonly steps: readonly OffboardingPlanStep[];
  readonly mailboxAccess: MailboxAccess;
}

export type OffboardingPlanErrorCode =
  | "offboarding.unknown_option"
  | "offboarding.invalid_option"
  | "offboarding.invalid_mailbox_access"
  | "offboarding.empty_plan";

export class OffboardingPlanError extends Error {
  readonly code: OffboardingPlanErrorCode;
  readonly option: string | undefined;

  constructor(code: OffboardingPlanErrorCode, message: string, option?: string) {
    super(message);
    this.name = "OffboardingPlanError";
    this.code = code;
    this.option = option;
  }
}

const STEP_OPTION_KEYS: readonly string[] = OFFBOARDING_STEP_CATALOGUE.map(
  (entry) => entry.option,
);

const ALLOWED_OPTION_KEYS: readonly string[] = [...STEP_OPTION_KEYS, "mailboxAccess"];

const MAILBOX_ACCESS_KEYS: readonly string[] = ["mode", "automap"];

const DEFAULT_MAILBOX_ACCESS: MailboxAccess = { mode: "full", automap: false };

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: OffboardingPlanErrorCode,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new OffboardingPlanError(code, `unknown offboarding option '${key}'`, key);
    }
  }
}

function resolveMailboxAccess(value: unknown): MailboxAccess {
  if (value === undefined) {
    return DEFAULT_MAILBOX_ACCESS;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OffboardingPlanError(
      "offboarding.invalid_mailbox_access",
      "mailboxAccess must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  assertKnownKeys(record, MAILBOX_ACCESS_KEYS, "offboarding.unknown_option");
  const mode = record["mode"] ?? DEFAULT_MAILBOX_ACCESS.mode;
  if (typeof mode !== "string" || !(MAILBOX_ACCESS_MODES as readonly string[]).includes(mode)) {
    throw new OffboardingPlanError(
      "offboarding.invalid_mailbox_access",
      `mailbox access mode must be one of ${MAILBOX_ACCESS_MODES.join(", ")}`,
      "mailboxAccess.mode",
    );
  }
  const automap = record["automap"] ?? DEFAULT_MAILBOX_ACCESS.automap;
  if (typeof automap !== "boolean") {
    throw new OffboardingPlanError(
      "offboarding.invalid_mailbox_access",
      "mailboxAccess.automap must be a boolean",
      "mailboxAccess.automap",
    );
  }
  return { mode: mode as MailboxAccessMode, automap };
}

export function buildOffboardingPlan(
  options: OffboardingPlanOptions = {},
): OffboardingPlan {
  const source = (options ?? {}) as Record<string, unknown>;
  assertKnownKeys(source, ALLOWED_OPTION_KEYS, "offboarding.unknown_option");

  const steps: OffboardingPlanStep[] = [];
  for (const entry of OFFBOARDING_STEP_CATALOGUE) {
    const value = source[entry.option];
    if (value !== undefined && typeof value !== "boolean") {
      throw new OffboardingPlanError(
        "offboarding.invalid_option",
        `option '${entry.option}' must be a boolean`,
        entry.option,
      );
    }
    if (value === false) continue;
    steps.push({ order: steps.length + 1, action: entry.action });
  }

  if (steps.length === 0) {
    throw new OffboardingPlanError(
      "offboarding.empty_plan",
      "offboarding plan must contain at least one step",
    );
  }

  return { steps, mailboxAccess: resolveMailboxAccess(source["mailboxAccess"]) };
}
