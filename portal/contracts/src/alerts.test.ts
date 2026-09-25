import { describe, expect, it } from "vitest";
import {
  ALERT_SCHEMA_VERSION,
  AlertValidationError,
  isAlertSource,
  isNormalizedAlert,
  normalizeAlert,
  normalizeDefenderAlert,
  normalizeGraphAlert,
  normalizeMdoAlert,
  validateAlert,
  type AlertSource,
} from "./alerts.js";

const defenderAlert = {
  id: "def-0001",
  title: "Suspicious process executed",
  severity: "high",
  status: "inProgress",
  createdDateTime: "2026-01-01T00:00:00.000Z",
  incidentId: "inc-0001",
  serviceSource: "microsoftDefenderForEndpoint",
  detectionSource: "EDR",
  actorDisplayName: "workstation-001",
  evidence: [
    {
      "@odata.type": "#microsoft.graph.security.deviceEvidence",
      deviceDnsName: "workstation-001",
      mdeDeviceId: "device-0001",
    },
  ],
};

const mdoAlert = {
  id: "mdo-0001",
  title: "Phishing email delivered",
  severity: "medium",
  status: "new",
  createdDateTime: "2026-01-02T00:00:00.000Z",
  incidentId: "inc-0002",
  serviceSource: "microsoftDefenderForOffice365",
  evidence: [
    {
      "@odata.type": "#microsoft.graph.security.mailboxEvidence",
      primaryAddress: "mailbox-0001",
    },
  ],
};

const graphAlert = {
  id: "graph-0001",
  title: "Risky sign-in",
  severity: "low",
  status: "resolved",
  createdDateTime: "2026-01-03T00:00:00.000Z",
  serviceSource: "azureAdIdentityProtection",
  evidence: [
    {
      "@odata.type": "#microsoft.graph.security.userEvidence",
      userAccount: { accountName: "user-0001", displayName: "user-0001" },
    },
  ],
};

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

function expectValidationError(fn: () => unknown, code: string): AlertValidationError {
  const error = capture(fn);
  expect(error).toBeInstanceOf(AlertValidationError);
  const validationError = error as AlertValidationError;
  expect(validationError.code).toBe(code);
  return validationError;
}

describe("normalizeAlert across sources", () => {
  it("maps a Defender alert onto the model", () => {
    const alert = normalizeDefenderAlert(defenderAlert);
    expect(alert.schemaVersion).toBe(ALERT_SCHEMA_VERSION);
    expect(alert.id).toBe("def-0001");
    expect(alert.source).toBe("defender");
    expect(alert.title).toBe("Suspicious process executed");
    expect(alert.severity).toBe("high");
    expect(alert.status).toBe("inProgress");
    expect(alert.created).toBe("2026-01-01T00:00:00.000Z");
    expect(alert.incidentId).toBe("inc-0001");
    expect(alert.entity).toEqual({
      kind: "device",
      id: "device-0001",
      displayName: "workstation-001",
    });
    expect(alert.passthrough.serviceSource).toBe("microsoftDefenderForEndpoint");
    expect(alert.passthrough.detectionSource).toBe("EDR");
    expect(alert.passthrough).not.toHaveProperty("id");
    expect(alert.passthrough).not.toHaveProperty("evidence");
  });

  it("maps an MDO alert onto the model", () => {
    const alert = normalizeMdoAlert(mdoAlert);
    expect(alert.source).toBe("mdo");
    expect(alert.severity).toBe("medium");
    expect(alert.status).toBe("new");
    expect(alert.entity).toEqual({ kind: "mailbox", displayName: "mailbox-0001", id: "mailbox-0001" });
    expect(alert.passthrough.serviceSource).toBe("microsoftDefenderForOffice365");
  });

  it("maps a Graph security alert onto the model and tolerates a missing incidentId", () => {
    const alert = normalizeGraphAlert(graphAlert);
    expect(alert.source).toBe("graph");
    expect(alert.status).toBe("resolved");
    expect(alert.incidentId).toBeNull();
    expect(alert.entity).toEqual({ kind: "user", id: "user-0001", displayName: "user-0001" });
  });

  it("dispatches by source and accepts a JSON string", () => {
    const alert = normalizeAlert(JSON.stringify(graphAlert), "graph");
    expect(alert).toEqual(normalizeGraphAlert(graphAlert));
  });
});

describe("normalizeAlert rejection", () => {
  it("rejects an unknown source", () => {
    const error = expectValidationError(
      () => normalizeAlert(graphAlert, "sentry" as AlertSource),
      "alert.unknown_source",
    );
    expect(error.path).toBe("source");
  });

  it("rejects a shape missing a required field", () => {
    const error = expectValidationError(
      () => normalizeGraphAlert({ ...graphAlert, title: undefined }),
      "alert.unmappable_source",
    );
    expect(error.path).toBe("graph.title");
  });

  it("rejects an unmappable severity rather than coercing it", () => {
    expectValidationError(
      () => normalizeGraphAlert({ ...graphAlert, severity: "critical" }),
      "alert.unmappable_source",
    );
  });

  it("rejects a non-object payload", () => {
    expectValidationError(() => normalizeGraphAlert("[]"), "alert.invalid");
  });

  it("rejects a payload that is not valid JSON", () => {
    expectValidationError(() => normalizeGraphAlert("{ not json"), "alert.invalid_json");
  });
});

describe("validateAlert", () => {
  it("round-trips every normalized source", () => {
    const alerts = [
      normalizeDefenderAlert(defenderAlert),
      normalizeMdoAlert(mdoAlert),
      normalizeGraphAlert(graphAlert),
    ];
    for (const alert of alerts) {
      expect(validateAlert(alert)).toEqual(alert);
      expect(isNormalizedAlert(alert)).toBe(true);
    }
  });

  it("rejects an alert with an unknown source", () => {
    const alert = { ...normalizeGraphAlert(graphAlert), source: "sentry" };
    expectValidationError(() => validateAlert(alert), "alert.unknown_source");
  });

  it("rejects an alert with an unsupported schema version", () => {
    const alert = { ...normalizeGraphAlert(graphAlert), schemaVersion: "v0" };
    expectValidationError(() => validateAlert(alert), "alert.unsupported_schema_version");
  });

  it("rejects a malformed entity", () => {
    const alert = { ...normalizeGraphAlert(graphAlert), entity: { kind: "satellite" } };
    expectValidationError(() => validateAlert(alert), "alert.invalid");
  });

  it("reports a raw shape as not normalized", () => {
    expect(isNormalizedAlert(graphAlert)).toBe(false);
  });
});

describe("alert source guard", () => {
  it("recognises only the three modelled sources", () => {
    expect(isAlertSource("defender")).toBe(true);
    expect(isAlertSource("mdo")).toBe(true);
    expect(isAlertSource("graph")).toBe(true);
    expect(isAlertSource("sentry")).toBe(false);
  });
});
