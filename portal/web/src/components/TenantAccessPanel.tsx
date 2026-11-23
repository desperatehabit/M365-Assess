"use client";

import React, { useState, type ReactElement } from "react";
import { CredentialBadge, type CredentialState } from "./CredentialBadge";
import {
  DANGEROUS_WRITE_GROUPS,
  WRITE_GROUPS,
  newProgressId,
  signInLabel,
  useOnboardingSignInProgress,
  writeGroupName,
} from "./AddTenantWizard";

/** One credential row from GET /v1/tenants/{id}/credentials (T-0942). */
export interface TenantCredentialSummary {
  readonly purpose: "reader" | "operator";
  readonly clientId: string;
  readonly authMethod: string;
  readonly thumbprint: string | null;
  readonly secretRef: string;
  readonly environment: string;
  readonly expiresOn: string | null;
  readonly lastValidated: string | null;
  readonly state: CredentialState;
  readonly permissionGroups: readonly string[];
}

export interface TenantAccessPanelProps {
  readonly tenantId: string;
  /** null while the credential list is loading. */
  readonly credentials: readonly TenantCredentialSummary[] | null;
  /** Load failure for the credential list; action failures render separately. */
  readonly error?: string | null;
  readonly onReload: () => Promise<void> | void;
  /** Tests shorten the device-code poll; the BFF default is 1500ms. */
  readonly progressPollIntervalMs?: number;
}

interface ApiErrorBody {
  code?: unknown;
  message?: unknown;
  error?: unknown;
}

/** Reads the BFF's `{ code, message }` error body, so the UI never shows a bare failure. */
async function responseError(response: Response, fallback: string): Promise<Error> {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body && typeof body === "object") {
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") message = body.message;
      if (body.error && typeof body.error === "object") {
        const nested = body.error as { code?: unknown; message?: unknown };
        if (!code && typeof nested.code === "string") code = nested.code;
        if (!message && typeof nested.message === "string") message = nested.message;
      } else if (!message && typeof body.error === "string") {
        message = body.error;
      }
    }
  } catch {
    // Non-JSON error body; the status below still identifies it.
  }
  const detail = [code, message].filter(Boolean).join(": ");
  return new Error(`${fallback} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}

export interface GrantCliCommandInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly thumbprint?: string | null;
  readonly adminUpn?: string;
  readonly groups: readonly string[];
  readonly confirmDangerous?: boolean;
  readonly replaceWriteGroups?: boolean;
}

/** Builds the copyable cmdlet fallback for PFX credentials that cannot submit here. */
export function buildGrantCliCommand(input: GrantCliCommandInput): string {
  const groups =
    input.groups.length > 0
      ? input.groups.join(",")
      : "<identity|security|intune|sharepoint|exchange>";
  const args = [
    "Grant-M365AssessConsent",
    `-TenantId '${input.tenantId}'`,
    `-ClientId '${input.clientId}'`,
  ];
  if (input.thumbprint) args.push(`-CertificateThumbprint '${input.thumbprint}'`);
  if (input.adminUpn?.trim()) args.push(`-AdminUpn '${input.adminUpn.trim()}'`);
  args.push("-IncludeWritePermissions");
  args.push(`-WritePermissionGroups ${groups}`);
  if (input.confirmDangerous) args.push("-ConfirmDangerous");
  if (input.replaceWriteGroups) args.push("-ReplaceWriteGroups");
  return args.map((arg, index) => (index === args.length - 1 ? arg : `${arg} \``)).join("\n");
}

function Field({
  label,
  value,
  mono,
  testId,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly mono?: boolean;
  readonly testId?: string;
}): ReactElement {
  return (
    <div className="access-field">
      <p className="access-field-label">{label}</p>
      <p className={`access-field-value${mono ? " mono" : ""}`} data-testid={testId}>
        {value}
      </p>
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function TenantAccessPanel({
  tenantId,
  credentials,
  error,
  onReload,
  progressPollIntervalMs = 1500,
}: TenantAccessPanelProps): ReactElement {
  const reader = credentials?.find((item) => item.purpose === "reader") ?? null;
  const operator = credentials?.find((item) => item.purpose === "operator") ?? null;
  const writeEnabled = operator !== null;

  const [dialogMode, setDialogMode] = useState<"grant" | "change" | null>(null);
  const [adminUpn, setAdminUpn] = useState("");
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [confirmDangerous, setConfirmDangerous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [disableConfirm, setDisableConfirm] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [cliCopyState, setCliCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [urlCopyState, setUrlCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const {
    deviceCode,
    signedInStage,
    copyState,
    deviceCodeExpired,
    start: startProgressWatch,
    reset: resetProgressWatch,
    copyDeviceCode,
  } = useOnboardingSignInProgress({ pollIntervalMs: progressPollIntervalMs });

  const dangerousSelected = selectedGroups.filter((group) => DANGEROUS_WRITE_GROUPS.has(group));
  const dangerousConfirmationNeeded = dangerousSelected.length > 0 && !confirmDangerous;
  const readerSupportsThumbprint = Boolean(reader?.thumbprint);

  const openDialog = (mode: "grant" | "change"): void => {
    setDialogMode(mode);
    setAdminUpn("");
    setSelectedGroups(mode === "change" ? [...(operator?.permissionGroups ?? [])] : []);
    setConfirmDangerous(false);
    setDialogError(null);
    setActionError(null);
    setResult(null);
    setCliCopyState("idle");
    setUrlCopyState("idle");
  };

  const closeDialog = (): void => {
    resetProgressWatch();
    setDialogMode(null);
    setSubmitting(false);
    setDialogError(null);
  };

  const toggleGroup = (id: string): void => {
    setSelectedGroups((current) =>
      current.includes(id) ? current.filter((group) => group !== id) : [...current, id],
    );
  };

  const handleGrant = async (): Promise<void> => {
    if (!reader) return;
    if (!adminUpn.trim()) {
      setDialogError("Enter the admin UPN that will approve the consent prompts.");
      return;
    }
    if (selectedGroups.length === 0) {
      setDialogError("Select at least one write permission group.");
      return;
    }
    if (dangerousConfirmationNeeded) {
      setDialogError(
        "Confirm the dangerous grants (PIM role assignment, device wipe, or full SharePoint control) before continuing.",
      );
      return;
    }
    // A PFX credential has no thumbprint the BFF can use from the Windows store;
    // submit would fail, so the dialog shows the cmdlet fallback instead.
    if (!readerSupportsThumbprint) {
      setDialogError(
        "This tenant's reader credential has no certificate thumbprint, so the portal cannot grant write access. Use the CLI fallback on the BFF host.",
      );
      return;
    }

    const mode = dialogMode ?? "grant";
    const groups = [...selectedGroups];
    const progressId = newProgressId();
    setSubmitting(true);
    setDialogError(null);
    setActionError(null);
    setResult(null);
    startProgressWatch(tenantId, progressId);
    try {
      const response = await fetch(`/v1/tenants/${tenantId}/onboard`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          createNew: false,
          clientId: reader.clientId,
          certificateThumbprint: reader.thumbprint,
          adminUpn: adminUpn.trim(),
          includeWritePermissions: true,
          writePermissionGroups: groups,
          confirmDangerous: dangerousSelected.length > 0,
          replaceWriteGroups: mode === "change",
          progressId,
        }),
      });
      if (!response.ok) {
        throw await responseError(response, "Write access request failed");
      }
      const body = (await response.json().catch(() => ({}))) as {
        operatorClientId?: unknown;
        operatorAppId?: unknown;
        onboarding?: { operatorClientId?: unknown; writePermissionGroups?: unknown };
      };
      const operatorId =
        typeof body.onboarding?.operatorClientId === "string"
          ? body.onboarding.operatorClientId
          : typeof body.operatorClientId === "string"
            ? body.operatorClientId
            : typeof body.operatorAppId === "string"
              ? body.operatorAppId
              : operator?.clientId;
      const groupsLabel = groups.map(writeGroupName).join(", ");
      setResult(
        `${mode === "change" ? "Updated" : "Enabled"} portal write access for ${groupsLabel}.` +
          (operatorId ? ` Operator client id: ${operatorId}.` : "") +
          " The reader app registration is unchanged.",
      );
      closeDialog();
      await onReload();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : "Write access request failed");
    } finally {
      resetProgressWatch();
      setSubmitting(false);
    }
  };

  const handleDisable = async (): Promise<void> => {
    setDisabling(true);
    setActionError(null);
    setResult(null);
    try {
      const response = await fetch(
        `/v1/tenants/${tenantId}/credential?purpose=operator`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        throw await responseError(response, "Could not disable portal write access");
      }
      setDisableConfirm(false);
      setResult(
        "Portal write access is disabled. The M365-Assess-Operator Entra app registration and its granted permissions were retained for audit or re-enable.",
      );
      await onReload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not disable portal write access");
    } finally {
      setDisabling(false);
    }
  };

  const copyCli = async (): Promise<void> => {
    if (!reader) return;
    const command = buildGrantCliCommand({
      tenantId,
      clientId: reader.clientId,
      thumbprint: reader.thumbprint,
      adminUpn,
      groups: selectedGroups,
      confirmDangerous: dangerousSelected.length > 0,
      replaceWriteGroups: true,
    });
    setCliCopyState((await copyText(command)) ? "copied" : "failed");
  };

  const copyVerificationUrl = async (): Promise<void> => {
    if (!deviceCode?.verificationUrl) return;
    setUrlCopyState((await copyText(deviceCode.verificationUrl)) ? "copied" : "failed");
  };

  if (credentials === null) {
    return (
      <div className="access-panel" data-testid="access-tab-content">
        <section className="access-card">
          <h3 className="access-card-title">Tenant access</h3>
          <p className="access-empty" data-testid="access-loading">
            Loading the reader and write-access credentials for this tenant…
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="access-panel" data-testid="access-tab-content">
      {error && (
        <div className="access-alert danger" role="alert" data-testid="access-error">
          <p style={{ margin: 0 }}>{error}</p>
          <div className="access-actions" style={{ marginTop: "10px" }}>
            <button
              type="button"
              className="access-button"
              onClick={() => {
                void onReload();
              }}
              data-testid="retry-credentials"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      <section className="access-card" data-testid="reader-credential-card">
        <div className="access-card-header">
          <h3 className="access-card-title">Reader credential</h3>
          {reader && <CredentialBadge state={reader.state} expiresOn={reader.expiresOn} />}
        </div>
        <p className="access-card-intro">
          Used by assessments and every read-only portal action. Write access never changes
          this app registration.
        </p>
        {reader ? (
          <div className="access-grid">
            <Field label="Client ID" value={reader.clientId} mono testId="reader-client-id" />
            <Field label="Auth Method" value={reader.authMethod} testId="reader-auth-method" />
            <Field
              label="Certificate Thumbprint"
              value={reader.thumbprint ?? "Not recorded (certificate PFX)"}
              mono
              testId="reader-thumbprint"
            />
            <Field label="State" value={reader.state} testId="reader-state" />
            <Field
              label="Expires On"
              value={reader.expiresOn ? new Date(reader.expiresOn).toLocaleDateString() : "Never"}
            />
            <Field
              label="Last Validated"
              value={
                reader.lastValidated
                  ? new Date(reader.lastValidated).toLocaleString()
                  : "Not yet tested"
              }
            />
          </div>
        ) : (
          <p className="access-empty" data-testid="reader-credential-missing">
            No reader credential was returned for this tenant. Reload, or complete onboarding to
            create one.
          </p>
        )}
      </section>

      <section className="access-card" data-testid="write-access-card">
        <div className="access-card-header">
          <h3 className="access-card-title">Portal write access</h3>
          <span
            className={`access-status ${writeEnabled ? "enabled" : "disabled"}`}
            data-testid="write-access-status"
          >
            {writeEnabled ? "Enabled" : "Not enabled"}
          </span>
        </div>
        <p className="access-card-intro">
          Write actions (remediation, remediation apply, and bulk edits) sign in with a separate{" "}
          <code>M365-Assess-Operator</code> app registration. Read actions stay on the reader app.
        </p>

        {operator ? (
          <>
            <div className="access-grid">
              <Field
                label="Operator Client ID"
                value={operator.clientId}
                mono
                testId="operator-client-id"
              />
              <Field
                label="Granted Groups"
                value={
                  operator.permissionGroups.length > 0
                    ? operator.permissionGroups.map(writeGroupName).join(", ")
                    : "None recorded"
                }
                testId="operator-groups"
              />
              <Field
                label="Last Updated"
                value={
                  operator.lastValidated
                    ? new Date(operator.lastValidated).toLocaleString()
                    : "Not recorded"
                }
                testId="operator-last-updated"
              />
              <Field label="State" value={operator.state} testId="operator-state" />
            </div>
            <div className="access-actions">
              <button
                type="button"
                className="access-button"
                onClick={() => openDialog("change")}
                data-testid="change-write-groups"
              >
                Change groups
              </button>
              <button
                type="button"
                className="access-button danger"
                onClick={() => {
                  setDisableConfirm(true);
                  setActionError(null);
                  setResult(null);
                }}
                data-testid="disable-write-access"
              >
                Disable write access
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="access-empty" data-testid="write-access-not-enabled">
              Write access is not enabled, so write actions return{" "}
              <code>409 tenant.operator_credential_missing</code>. Add it to let this tenant run
              remediation from the portal.
            </p>
            {reader && (
              <div className="access-actions">
                <button
                  type="button"
                  className="access-button primary"
                  onClick={() => openDialog("grant")}
                  data-testid="add-write-access"
                >
                  Add write access
                </button>
              </div>
            )}
          </>
        )}

        {disableConfirm && (
          <div
            className="access-alert danger"
            role="alertdialog"
            aria-label="Confirm disabling portal write access"
            data-testid="disable-write-confirmation"
          >
            <p style={{ margin: 0, fontWeight: 600 }}>Disable portal write access?</p>
            <p style={{ margin: "6px 0 0" }}>
              This removes the operator credential, so write actions stop working in the portal.
              The <code>M365-Assess-Operator</code> Entra app registration and its granted
              permissions are retained, so the app can be audited or re-enabled later.
            </p>
            <div className="access-actions" style={{ marginTop: "12px" }}>
              <button
                type="button"
                className="access-button danger"
                onClick={() => {
                  void handleDisable();
                }}
                disabled={disabling}
                data-testid="confirm-disable-write"
              >
                {disabling ? "Disabling…" : "Disable portal write access"}
              </button>
              <button
                type="button"
                className="access-button"
                onClick={() => setDisableConfirm(false)}
                disabled={disabling}
                data-testid="cancel-disable-write"
              >
                Keep write access
              </button>
            </div>
          </div>
        )}

        {actionError && (
          <div className="access-alert danger" role="alert" data-testid="write-action-error">
            {actionError}
          </div>
        )}

        {result && (
          <div className="access-alert success" data-testid="write-access-result">
            {result}
          </div>
        )}
      </section>

      {dialogMode && (
        <div className="access-dialog-backdrop">
          <div
            className="access-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="write-access-dialog-title"
            data-testid="write-access-dialog"
          >
            <div className="access-dialog-header">
              <div>
                <h3 className="access-dialog-title" id="write-access-dialog-title">
                  {dialogMode === "change" ? "Change write permission groups" : "Add write access"}
                </h3>
                <p className="access-hint" style={{ marginTop: "6px" }}>
                  Write actions use <code>M365-Assess-Operator</code>. The reader app registration
                  stays read-only.
                </p>
              </div>
              <button
                type="button"
                className="access-button"
                onClick={closeDialog}
                disabled={submitting}
                data-testid="cancel-write-access"
              >
                Cancel
              </button>
            </div>

            {reader ? (
              <>
                <div className="access-grid">
                  <Field label="Reader Client ID" value={reader.clientId} mono />
                  <Field
                    label="Certificate Thumbprint"
                    value={reader.thumbprint ?? "Not recorded (certificate PFX)"}
                    mono
                  />
                </div>

                <div className="access-field-block">
                  <label className="access-label" htmlFor="write-admin-upn">
                    Admin UPN *
                  </label>
                  <input
                    id="write-admin-upn"
                    type="email"
                    className="access-input"
                    placeholder="admin@contoso.onmicrosoft.com"
                    value={adminUpn}
                    onChange={(event) => setAdminUpn(event.target.value)}
                    disabled={submitting}
                    data-testid="write-admin-upn"
                  />
                  <p className="access-hint" style={{ marginTop: "4px" }}>
                    Global Administrator or Application Administrator in the tenant. Used only to
                    approve the consent prompts.
                  </p>
                </div>

                <div className="access-field-block">
                  <span className="access-label">Permission groups *</span>
                  <div className="access-checkbox-list">
                    {WRITE_GROUPS.map((group) => {
                      const dangerous = DANGEROUS_WRITE_GROUPS.has(group.id);
                      const checked = selectedGroups.includes(group.id);
                      return (
                        <label key={group.id} className="access-checkbox">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleGroup(group.id)}
                            disabled={submitting}
                            data-testid={`write-group-checkbox-${group.id}`}
                          />
                          <span className="access-checkbox-text">
                            <span className="access-checkbox-name">
                              {group.name}
                              {dangerous && (
                                <>
                                  {" "}
                                  <span className="access-danger-tag">Dangerous</span>
                                </>
                              )}
                            </span>
                            <span className="access-checkbox-description">{group.description}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <p className="access-hint" style={{ marginTop: "6px" }}>
                    Saving {dialogMode === "change" ? "reconciles" : "grants"} these groups on the
                    operator app
                    {dialogMode === "change"
                      ? ": selected groups are added and previously granted managed groups that are no longer selected are removed."
                      : ". Unselected groups are not granted."}{" "}
                    The reader app is never touched.
                  </p>
                </div>

                {dangerousSelected.length > 0 && (
                  <label className="access-checkbox access-danger-confirm">
                    <input
                      type="checkbox"
                      checked={confirmDangerous}
                      onChange={(event) => setConfirmDangerous(event.target.checked)}
                      disabled={!readerSupportsThumbprint || submitting}
                      data-testid="confirm-dangerous-grant"
                    />
                    <span className="access-checkbox-text">
                      <span className="access-checkbox-name">
                        I understand these groups include dangerous grants
                      </span>
                      <span className="access-checkbox-description">
                        PIM role assignment (including Global Administrator), device wipe, and full
                        SharePoint control.
                      </span>
                    </span>
                  </label>
                )}

                {!readerSupportsThumbprint ? (
                  <div className="access-alert warning" data-testid="access-cli-fallback">
                    <p style={{ margin: 0, fontWeight: 600 }}>
                      This credential uses a PFX certificate, so it has no thumbprint the BFF can
                      select from the Windows certificate store.
                    </p>
                    <p style={{ margin: "6px 0 8px" }}>
                      Run this on the <strong>BFF host</strong> (Windows, with the reader
                      certificate installed) instead of submitting here. <code>-ReplaceWriteGroups</code>{" "}
                      reconciles the operator app's managed grants and leaves the reader app alone.
                    </p>
                    <pre className="access-code-block" data-testid="access-cli-fallback-command">
                      {buildGrantCliCommand({
                        tenantId,
                        clientId: reader.clientId,
                        thumbprint: reader.thumbprint,
                        adminUpn,
                        groups: selectedGroups,
                        confirmDangerous: dangerousSelected.length > 0,
                        replaceWriteGroups: true,
                      })}
                    </pre>
                    <div className="access-actions" style={{ marginTop: "10px" }}>
                      <button
                        type="button"
                        className="access-button"
                        onClick={() => {
                          void copyCli();
                        }}
                        data-testid="copy-access-cli"
                      >
                        {cliCopyState === "copied"
                          ? "Copied"
                          : cliCopyState === "failed"
                            ? "Select the command"
                            : "Copy command"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="access-actions">
                    <button
                      type="button"
                      className="access-button primary"
                      onClick={() => {
                        void handleGrant();
                      }}
                      disabled={
                        submitting ||
                        !adminUpn.trim() ||
                        selectedGroups.length === 0 ||
                        dangerousConfirmationNeeded
                      }
                      data-testid="submit-write-access"
                    >
                      {submitting
                        ? "Applying write access…"
                        : dialogMode === "change"
                          ? "Save group changes"
                          : "Grant write access"}
                    </button>
                  </div>
                )}

                {submitting && (
                  <p className="access-hint" data-testid="write-access-progress">
                    Creating or reconciling the operator app and granting permissions. Sign in with
                    each device code below; this can take a few minutes.
                  </p>
                )}

                {submitting && deviceCode && (
                  <div className="access-device-code" data-testid="access-device-code-panel">
                    <h4 style={{ margin: 0, fontSize: "15px" }}>
                      Sign in to {deviceCode.provider}
                    </h4>
                    <p style={{ margin: 0, fontSize: "14px" }} data-testid="access-device-code-instruction">
                      Open the verification page in any browser, then enter this code for{" "}
                      <strong>{signInLabel(deviceCode.signIn)}</strong>:
                    </p>
                    <div className="access-device-code-row">
                      <code
                        className="access-device-code-value"
                        data-testid="access-device-code"
                      >
                        {deviceCode.code}
                      </code>
                      <button
                        type="button"
                        className="access-button"
                        onClick={() => {
                          void copyDeviceCode();
                        }}
                        data-testid="copy-access-device-code"
                      >
                        {copyState === "copied"
                          ? "Copied"
                          : copyState === "failed"
                            ? "Select the code"
                            : "Copy code"}
                      </button>
                    </div>
                    {deviceCode.verificationUrl && (
                      <div className="access-device-code-row">
                        <a
                          className="access-device-code-url"
                          href={deviceCode.verificationUrl}
                          target="_blank"
                          rel="noreferrer"
                          data-testid="access-device-code-url"
                        >
                          {deviceCode.verificationUrl}
                        </a>
                        <button
                          type="button"
                          className="access-button"
                          onClick={() => {
                            void copyVerificationUrl();
                          }}
                          data-testid="copy-access-device-code-url"
                        >
                          {urlCopyState === "copied" ? "Copied" : "Copy link"}
                        </button>
                      </div>
                    )}
                    {deviceCode.expiresAt && !deviceCodeExpired && (
                      <p style={{ margin: 0, fontSize: "12px" }}>
                        This code expires at {new Date(deviceCode.expiresAt).toLocaleTimeString()}.
                      </p>
                    )}
                    {deviceCodeExpired && (
                      <p style={{ margin: 0, fontSize: "13px" }} data-testid="access-device-code-expired">
                        This code has expired. The worker waits for a fresh code; if none appears,
                        close this dialog and try again.
                      </p>
                    )}
                  </div>
                )}

                {submitting && !deviceCode && signedInStage && (
                  <div className="access-alert success" data-testid="access-device-code-signed-in">
                    Signed in to {signInLabel(signedInStage)}. Waiting for the worker to finish; a
                    fresh code may appear for the next sign-in.
                  </div>
                )}

                {dialogError && (
                  <div className="access-alert danger" role="alert" data-testid="write-access-error">
                    {dialogError}
                  </div>
                )}
              </>
            ) : (
              <p className="access-empty" data-testid="write-access-no-reader">
                A reader credential is required before write access can be granted. Reload this
                page or complete onboarding first.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
