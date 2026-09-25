import { describe, expect, it } from "vitest";
import {
  OffboardingPlanError,
  buildOffboardingPlan,
  type OffboardingPlanOptions,
} from "./plan.js";

function expectPlanError(fn: () => unknown, code: string): OffboardingPlanError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(OffboardingPlanError);
  const planError = thrown as OffboardingPlanError;
  expect(planError.code).toBe(code);
  return planError;
}

describe("offboarding v1 plan builder", () => {
  it("emits the ordered v1 step set by default", () => {
    const plan = buildOffboardingPlan();
    expect(plan.steps).toEqual([
      { order: 1, action: "disable-sign-in" },
      { order: 2, action: "remove-licenses" },
      { order: 3, action: "convert-mailbox" },
      { order: 4, action: "remove-groups" },
    ]);
    expect(plan.mailboxAccess).toEqual({ mode: "full", automap: false });
  });

  it("resolves a subset while preserving catalogue order", () => {
    const plan = buildOffboardingPlan({
      removeLicenses: false,
      disableSignIn: true,
      removeGroups: true,
      convertMailbox: true,
    });
    expect(plan.steps).toEqual([
      { order: 1, action: "disable-sign-in" },
      { order: 2, action: "convert-mailbox" },
      { order: 3, action: "remove-groups" },
    ]);
  });

  it("is deterministic for the same options", () => {
    const options: OffboardingPlanOptions = {
      disableSignIn: true,
      convertMailbox: false,
      mailboxAccess: { mode: "send-on-behalf", automap: true },
    };
    expect(buildOffboardingPlan(options)).toEqual(buildOffboardingPlan(options));
    expect(JSON.stringify(buildOffboardingPlan(options))).toBe(
      JSON.stringify(buildOffboardingPlan(options)),
    );
  });

  it("records the resolved mailbox access mode", () => {
    const plan = buildOffboardingPlan({
      mailboxAccess: { mode: "send-as", automap: true },
    });
    expect(plan.mailboxAccess).toEqual({ mode: "send-as", automap: true });
  });

  it("rejects an option outside the v1 catalogue", () => {
    const error = expectPlanError(
      () =>
        buildOffboardingPlan({
          disableSignIn: true,
          wipeDevices: true,
        } as unknown as OffboardingPlanOptions),
      "offboarding.unknown_option",
    );
    expect(error.option).toBe("wipeDevices");
  });

  it("rejects an unknown nested mailbox access key", () => {
    expectPlanError(
      () =>
        buildOffboardingPlan({
          mailboxAccess: { mode: "full", shared: true } as unknown as Partial<{ mode: "full" }>,
        }),
      "offboarding.unknown_option",
    );
  });

  it("rejects a non-boolean step toggle", () => {
    expectPlanError(
      () => buildOffboardingPlan({ disableSignIn: "yes" } as unknown as OffboardingPlanOptions),
      "offboarding.invalid_option",
    );
  });

  it("rejects an unknown mailbox access mode", () => {
    expectPlanError(
      () =>
        buildOffboardingPlan({
          mailboxAccess: { mode: "delegate" } as unknown as Partial<{ mode: "full" }>,
        }),
      "offboarding.invalid_mailbox_access",
    );
  });

  it("rejects a plan with no steps", () => {
    expectPlanError(
      () =>
        buildOffboardingPlan({
          disableSignIn: false,
          removeLicenses: false,
          convertMailbox: false,
          removeGroups: false,
        }),
      "offboarding.empty_plan",
    );
  });
});
