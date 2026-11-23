import React, { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";

export type SetupMethod = "create-app" | "existing-app" | "manual-creds" | "import-gdap";
export type M365Environment = "commercial" | "gcc" | "gcchigh" | "dod";
export type AuthMethod = "certificate-thumbprint" | "certificate-pfx" | "client-secret";

export interface ServiceTestResult {
  readonly service: string;
  readonly status: "pass" | "fail";
  readonly connected: boolean;
  readonly error?: string | null;
}

/** One PowerShell module the onboarding worker needs on the BFF host. */
export interface OnboardingModuleStatus {
  readonly name: string;
  readonly installed: boolean;
  readonly version: string | null;
}

/** Read-only preflight the wizard shows before the final onboarding step. */
export interface OnboardingPreflight {
  readonly ready: boolean;
  readonly graphVersion?: string | null;
  readonly modules?: readonly OnboardingModuleStatus[];
  readonly missingModules: readonly string[];
  /** Exact Install-Module commands; Graph modules carry -RequiredVersion. */
  readonly installCommands: readonly string[];
  readonly message: string;
}

export const ONBOARDING_PREFLIGHT_PATH = "/v1/onboarding/preflight";

async function fetchOnboardingPreflight(): Promise<OnboardingPreflight> {
  const response = await fetch(ONBOARDING_PREFLIGHT_PATH);
  if (!response.ok) {
    throw new Error(`Prerequisite check failed: HTTP ${response.status}`);
  }
  return (await response.json()) as OnboardingPreflight;
}

/** One sign-in event from the onboarding job's progress channel (T-0916). */
export type OnboardingSignInKind = "device-code" | "sign-in-complete" | "sign-in-failed";

export interface OnboardingSignInEvent {
  readonly sequence: number;
  readonly kind: OnboardingSignInKind;
  /** graph-bootstrap, graph-permissions, graph-operator, exchange-online. */
  readonly signIn: string;
  readonly provider: string;
  readonly code?: string | null;
  readonly verificationUrl?: string | null;
  readonly expiresAt?: string | null;
  readonly message?: string | null;
  readonly account?: string | null;
  readonly error?: string | null;
  readonly at?: string;
}

export interface OnboardingProgressSnapshot {
  readonly state: "unknown" | "pending" | "done";
  readonly events: readonly OnboardingSignInEvent[];
}

export const ONBOARDING_PROGRESS_PREFIX = "/v1/tenants";

async function fetchOnboardingProgress(
  tenantId: string,
  progressId: string,
  since: number,
): Promise<OnboardingProgressSnapshot> {
  const path = `${ONBOARDING_PROGRESS_PREFIX}/${encodeURIComponent(tenantId)}/onboard/progress/${encodeURIComponent(progressId)}?since=${since}`;
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Onboarding progress failed: HTTP ${response.status}`);
  }
  return (await response.json()) as OnboardingProgressSnapshot;
}

function newProgressId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `onboard-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const SIGN_IN_LABELS: Record<string, string> = {
  "graph-bootstrap": "Microsoft Graph (app registration bootstrap)",
  "graph-permissions": "Microsoft Graph (permissions and roles)",
  "graph-operator": "Microsoft Graph (operator app)",
  "exchange-online": "Exchange Online (RBAC role groups)",
};

function signInLabel(signIn: string): string {
  return SIGN_IN_LABELS[signIn] ?? signIn;
}

export interface AddTenantWizardProps {
  readonly onComplete?: (data: Record<string, unknown>) => void;
  readonly onCancel?: () => void;
  readonly onResolveTenant?: (input: string) => Promise<{ id: string; defaultDomain?: string; displayName?: string }>;
  readonly onTestConnection?: (tenantId: string, payload?: Record<string, unknown>) => Promise<{
    success: boolean;
    services: ServiceTestResult[];
  }>;
  readonly onSubmitOnboarding?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Optional override for the module preflight; the wizard calls the BFF by default. */
  readonly onCheckPrerequisites?: () => Promise<OnboardingPreflight>;
  /**
   * Optional override for the device-code progress poll; the wizard calls the BFF by
   * default. Receives only events with a sequence greater than `since` (T-0916).
   */
  readonly onWatchOnboardingProgress?: (
    progressId: string,
    since: number,
  ) => Promise<OnboardingProgressSnapshot>;
  /** How often the wizard polls for a pending device code. Default: 1500ms. */
  readonly progressPollIntervalMs?: number;
  readonly availableGroups?: readonly { id: string; name: string }[];
}

const containerStyle: CSSProperties = {
  maxWidth: "800px",
  margin: "0 auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  overflow: "hidden",
};

const stepperHeaderStyle: CSSProperties = {
  display: "flex",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
  overflowX: "auto",
};

const stepIndicatorStyle = (isActive: boolean, isPassed: boolean): CSSProperties => ({
  flex: "1 1 0",
  padding: "14px 10px",
  textAlign: "center",
  fontSize: "13px",
  fontWeight: isActive ? 700 : isPassed ? 600 : 500,
  color: isActive ? "var(--accent-text, var(--accent))" : isPassed ? "var(--success-text, var(--text))" : "var(--text-soft)",
  borderBottom: isActive ? "2px solid var(--accent)" : isPassed ? "2px solid var(--success)" : "2px solid transparent",
  whiteSpace: "nowrap",
});

const contentStyle: CSSProperties = {
  padding: "28px",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "16px 28px",
  borderTop: "1px solid var(--border)",
  background: "var(--surface)",
};

const inputStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  width: "100%",
  boxSizing: "border-box",
};

const selectStyle: CSSProperties = {
  ...inputStyle,
};

const buttonStyle: CSSProperties = {
  padding: "10px 20px",
  borderRadius: "6px",
  fontSize: "14px",
  fontWeight: 600,
  cursor: "pointer",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const radioCardStyle = (selected: boolean): CSSProperties => ({
  padding: "16px",
  borderRadius: "8px",
  border: selected ? "2px solid var(--accent)" : "1px solid var(--border)",
  background: selected ? "var(--accent-soft)" : "var(--surface)",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
});

const warningBannerStyle: CSSProperties = {
  padding: "16px",
  borderRadius: "8px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "14px",
  lineHeight: 1.5,
};

const STEP_TITLES = [
  "1. Setup Method",
  "2. Tenant",
  "3. Credentials",
  "4. Groups & Vars",
  "5. Test Connect",
  "6. Confirmation",
];

/** Opt-in portal write groups (T-0917); mirrors PermissionDefinitions.ps1. */
const WRITE_GROUPS = [
  { id: "identity", name: "Identity", description: "Users, groups, Conditional Access, authentication methods, PIM." },
  { id: "security", name: "Security", description: "Defender alerts, incidents, and threat submissions." },
  { id: "intune", name: "Intune", description: "Configuration, apps, enrollment, and managed-device actions." },
  { id: "sharepoint", name: "SharePoint & Teams", description: "Site permissions, site edits, Teams creation and settings." },
  { id: "exchange", name: "Exchange & Purview", description: "Mailbox, transport, quarantine, and eDiscovery writes." },
] as const;

/** Groups whose grants need the extra dangerous-action confirmation. */
const DANGEROUS_WRITE_GROUPS = new Set<string>(["identity", "intune", "sharepoint"]);

export function AddTenantWizard({
  onComplete,
  onCancel,
  onResolveTenant,
  onTestConnection,
  onSubmitOnboarding,
  onCheckPrerequisites,
  onWatchOnboardingProgress,
  progressPollIntervalMs = 1500,
  availableGroups = [],
}: AddTenantWizardProps): ReactElement {
  const [step, setStep] = useState(1);
  const [setupMethod, setSetupMethod] = useState<SetupMethod>("create-app");
  const [tenantInput, setTenantInput] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [defaultDomain, setDefaultDomain] = useState("");
  const [isResolving, setIsResolving] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Step 3 credentials
  const [adminUpn, setAdminUpn] = useState("");
  const [appDisplayName, setAppDisplayName] = useState("M365-Assess-Reader");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("certificate-thumbprint");
  const [clientId, setClientId] = useState("");
  const [certificateThumbprint, setCertificateThumbprint] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [environment, setEnvironment] = useState<M365Environment>("commercial");

  // Step 4 groups & vars
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [variables, setVariables] = useState<{ name: string; value: string }[]>([]);
  const [newVarName, setNewVarName] = useState("");
  const [newVarValue, setNewVarValue] = useState("");

  // Step 5 test connection
  const [testingConnection, setTestingConnection] = useState(false);
  const [serviceResults, setServiceResults] = useState<ServiceTestResult[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // Step 6 confirmation
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<OnboardingPreflight | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const preflightRequest = useRef<Promise<OnboardingPreflight | null> | null>(null);

  // Step 6 opt-in write access (T-0917). Off by default: onboarding behaves exactly
  // as before and the reader app stays read-only.
  const [includeWritePermissions, setIncludeWritePermissions] = useState(false);
  const [writeGroups, setWriteGroups] = useState<string[]>([]);
  const [confirmDangerous, setConfirmDangerous] = useState(false);
  const [onboardingResult, setOnboardingResult] = useState<Record<string, unknown> | null>(null);

  // Step 6 headless sign-in relay (T-0916). Only one sign-in is pending at a time;
  // a new device-code event supersedes the previous code and a sign-in-complete
  // event clears it.
  const [deviceCode, setDeviceCode] = useState<OnboardingSignInEvent | null>(null);
  const [signedInStage, setSignedInStage] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressActive = useRef(false);

  const handleResolveIdentity = async (): Promise<void> => {
    if (!tenantInput.trim()) return;
    setIsResolving(true);
    setResolveError(null);
    try {
      if (onResolveTenant) {
        const res = await onResolveTenant(tenantInput.trim());
        setTenantId(res.id);
        if (res.displayName && !displayName) setDisplayName(res.displayName);
        if (res.defaultDomain && !defaultDomain) setDefaultDomain(res.defaultDomain);
        setResolved(true);
      } else {
        // Fallback resolution
        setTenantId(tenantInput.trim());
        setResolved(true);
      }
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Failed to resolve tenant");
      setResolved(false);
    } finally {
      setIsResolving(false);
    }
  };

  const handleTestConnection = async (): Promise<void> => {
    setTestingConnection(true);
    setTestError(null);
    try {
      if (onTestConnection) {
        const res = await onTestConnection(tenantId || tenantInput, {
          clientId,
          certificateThumbprint,
          clientSecret,
          authMethod,
          environment,
        });
        setServiceResults(res.services);
      }
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Connection probe failed");
    } finally {
      setTestingConnection(false);
    }
  };

  const checkPrerequisites = (): Promise<OnboardingPreflight | null> => {
    if (preflightRequest.current) return preflightRequest.current;
    const check = onCheckPrerequisites ?? fetchOnboardingPreflight;
    setPreflightError(null);
    const pending = Promise.resolve()
      .then(check)
      .then((result) => {
        setPreflight(result);
        return result;
      })
      .catch((err: unknown) => {
        // The check is advisory when unavailable; the worker still refuses to start
        // without the modules, and reports them as onboard.failed.
        setPreflightError(
          err instanceof Error ? err.message : "Onboarding prerequisite check failed",
        );
        return null;
      });
    preflightRequest.current = pending;
    return pending;
  };

  const dangerousWriteGroups = writeGroups.filter((group) => DANGEROUS_WRITE_GROUPS.has(group));
  const writeSelectionValid =
    !includeWritePermissions ||
    (writeGroups.length > 0 && (dangerousWriteGroups.length === 0 || confirmDangerous));

  const stopProgressWatch = (): void => {
    progressActive.current = false;
    if (progressTimer.current) {
      clearInterval(progressTimer.current);
      progressTimer.current = null;
    }
  };

  useEffect(() => stopProgressWatch, []);

  const applySignInEvent = (event: OnboardingSignInEvent): void => {
    if (event.kind === "device-code") {
      setDeviceCode(event);
      setSignedInStage(null);
      setCopyState("idle");
      return;
    }
    // sign-in-complete / sign-in-failed clear only their own pending code, so a
    // late event can never wipe the next sign-in's code.
    setDeviceCode((current) => (current && current.signIn === event.signIn ? null : current));
    if (event.kind === "sign-in-complete") {
      setSignedInStage(event.signIn);
    }
  };

  const startProgressWatch = (progressId: string): void => {
    stopProgressWatch();
    progressActive.current = true;
    const tenant = tenantId || tenantInput;
    let since = 0;

    const tick = async (): Promise<void> => {
      if (!progressActive.current) return;
      try {
        const snapshot = onWatchOnboardingProgress
          ? await onWatchOnboardingProgress(progressId, since)
          : await fetchOnboardingProgress(tenant, progressId, since);
        const events = [...(snapshot.events ?? [])].sort((a, b) => a.sequence - b.sequence);
        for (const event of events) {
          if (event.sequence <= since) continue;
          since = event.sequence;
          applySignInEvent(event);
        }
        if (snapshot.state === "done") {
          stopProgressWatch();
        }
      } catch {
        // Progress is advisory: the submit response still reports failures.
      }
    };

    void tick();
    progressTimer.current = setInterval(() => {
      void tick();
    }, progressPollIntervalMs);
  };

  const copyDeviceCode = async (): Promise<void> => {
    if (!deviceCode?.code) return;
    try {
      await navigator.clipboard?.writeText(deviceCode.code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const deviceCodeExpired =
    deviceCode?.expiresAt !== null &&
    deviceCode?.expiresAt !== undefined &&
    Date.parse(deviceCode.expiresAt) <= Date.now();

  const handleSubmit = async (): Promise<void> => {
    if (!confirmed) {
      setSubmitError("Explicit confirmation is required before proceeding.");
      return;
    }
    if (includeWritePermissions && writeGroups.length === 0) {
      setSubmitError("Select at least one write permission group, or turn write access off.");
      return;
    }
    if (includeWritePermissions && dangerousWriteGroups.length > 0 && !confirmDangerous) {
      setSubmitError(
        "Confirm the dangerous write permissions (PIM role assignment, device wipe, or full SharePoint control) before proceeding.",
      );
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setOnboardingResult(null);
    setDeviceCode(null);
    setSignedInStage(null);
    setCopyState("idle");
    try {
      const prerequisites = await checkPrerequisites();
      if (prerequisites && !prerequisites.ready) {
        setSubmitError(prerequisites.message);
        return;
      }
      const progressId = newProgressId();
      const payload = {
        confirmed: true,
        tenantId: tenantId || tenantInput,
        setupMethod,
        displayName: displayName || undefined,
        defaultDomain: defaultDomain || undefined,
        environment,
        adminUpn: adminUpn || undefined,
        appDisplayName: appDisplayName || undefined,
        clientId: clientId || undefined,
        certificateThumbprint: certificateThumbprint || undefined,
        createNew: setupMethod === "create-app",
        groups: selectedGroups,
        variables,
        progressId,
        ...(includeWritePermissions
          ? {
              includeWritePermissions: true,
              writePermissionGroups: writeGroups,
              confirmDangerous,
            }
          : {}),
      };

      // Poll while the POST waits: a headless BFF relays each device code here.
      startProgressWatch(progressId);

      if (onSubmitOnboarding) {
        const result = await onSubmitOnboarding(payload);
        setOnboardingResult(result);
        onComplete?.(result);
      } else {
        setOnboardingResult(payload);
        onComplete?.(payload);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Onboarding failed");
    } finally {
      stopProgressWatch();
      setDeviceCode(null);
      setSubmitting(false);
    }
  };

  const canGoNext = (): boolean => {
    if (step === 1) return true;
    if (step === 2) return (tenantId.length > 0 || tenantInput.length > 0) && resolved;
    if (step === 3) {
      if (setupMethod === "create-app") return adminUpn.trim().length > 0;
      if (setupMethod === "existing-app" || setupMethod === "manual-creds") {
        if (!clientId.trim()) return false;
        if (authMethod === "certificate-thumbprint" && !certificateThumbprint.trim()) return false;
        if (authMethod === "client-secret" && !clientSecret.trim()) return false;
      }
      return true;
    }
    if (step === 4) return true;
    // Step 5 is advisory: the tenant and its credential only exist after step 6 submits, so a
    // probe can neither be required nor trusted to gate onboarding.
    return true;
  };

  const handleNext = (): void => {
    // Check the worker host's onboarding modules while still on the advisory step, so
    // the final step reports any missing module before onboarding starts.
    if (step === 4 || step === 5) {
      void checkPrerequisites();
    }
    setStep((s) => s + 1);
  };

  const prerequisitesNotice = (
    <>
      {preflight && !preflight.ready && (
        <div style={warningBannerStyle} data-testid="onboarding-prerequisites-missing">
          <strong>Onboarding prerequisites are not met:</strong>
          <p
            style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}
            data-testid="prerequisites-message"
          >
            {preflight.message}
          </p>
          {preflight.installCommands.length > 0 && (
            <pre
              style={{
                margin: "10px 0 0",
                padding: "10px",
                background: "var(--surface)",
                borderRadius: "6px",
                overflowX: "auto",
                fontSize: "12px",
              }}
            >
              <code data-testid="prerequisites-install-commands">
                {preflight.installCommands.join("\n")}
              </code>
            </pre>
          )}
        </div>
      )}

      {preflightError && (
        <div style={warningBannerStyle} data-testid="onboarding-prerequisites-error">
          Could not check onboarding prerequisites: {preflightError}. Onboarding can
          continue; the worker reports any missing module when it starts.
        </div>
      )}
    </>
  );

  return (
    <div style={containerStyle} data-testid="add-tenant-wizard">
      {/* Stepper Header */}
      <div style={stepperHeaderStyle} data-testid="wizard-stepper">
        {STEP_TITLES.map((title, idx) => {
          const stepNumber = idx + 1;
          const isActive = step === stepNumber;
          const isPassed = step > stepNumber;
          return (
            <div
              key={title}
              style={stepIndicatorStyle(isActive, isPassed)}
              data-testid={`step-indicator-${stepNumber}`}
            >
              {title}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div style={contentStyle}>
        {/* Step 1: Setup Method */}
        {step === 1 && (
          <div data-testid="wizard-step-1" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>Select Setup Method</h2>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Choose how to connect and grant permissions to this Microsoft 365 tenant.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div
                style={radioCardStyle(setupMethod === "create-app")}
                onClick={() => setSetupMethod("create-app")}
                data-testid="method-create-app"
              >
                <strong>Create app registration & grant consent (Recommended)</strong>
                <span style={{ fontSize: "13px", color: "var(--text-soft)" }}>
                  Automates creating the Entra ID application, self-signed certificate, and assigning all 29 read-only permissions via Grant-M365AssessConsent.
                </span>
              </div>

              <div
                style={radioCardStyle(setupMethod === "existing-app")}
                onClick={() => setSetupMethod("existing-app")}
                data-testid="method-existing-app"
              >
                <strong>Use existing app registration</strong>
                <span style={{ fontSize: "13px", color: "var(--text-soft)" }}>
                  Configure an already created App Registration in the tenant with client ID and certificate.
                </span>
              </div>

              <div
                style={radioCardStyle(setupMethod === "manual-creds")}
                onClick={() => setSetupMethod("manual-creds")}
                data-testid="method-manual-creds"
              >
                <strong>Enter credentials manually</strong>
                <span style={{ fontSize: "13px", color: "var(--text-soft)" }}>
                  Manually supply certificate thumbprint, PFX path, or client secret.
                </span>
              </div>

              <div
                style={radioCardStyle(setupMethod === "import-gdap")}
                onClick={() => setSetupMethod("import-gdap")}
                data-testid="method-import-gdap"
              >
                <strong>Import from GDAP</strong>
                <span style={{ fontSize: "13px", color: "var(--text-soft)" }}>
                  Import an existing partner tenant discovered via active Granular Delegated Admin Privileges.
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Tenant Identity */}
        {step === 2 && (
          <div data-testid="wizard-step-2" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>Tenant Identification</h2>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Specify the Microsoft 365 tenant ID or primary domain. We will validate the identity via Resolve-TenantIdentity.
            </p>

            <div>
              <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600 }}>
                Tenant Domain or Entra GUID *
              </label>
              <div style={{ display: "flex", gap: "10px" }}>
                <input
                  type="text"
                  placeholder="e.g. contoso.onmicrosoft.com or 00000000-0000-0000-0000-000000000001"
                  value={tenantInput}
                  onChange={(e) => {
                    setTenantInput(e.target.value);
                    setResolved(false);
                  }}
                  style={inputStyle}
                  data-testid="tenant-input"
                />
                <button
                  type="button"
                  onClick={handleResolveIdentity}
                  disabled={isResolving || !tenantInput.trim()}
                  style={buttonStyle}
                  data-testid="resolve-tenant-btn"
                >
                  {isResolving ? "Resolving..." : "Resolve"}
                </button>
              </div>
            </div>

            {resolved && (
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: "6px",
                  background: "var(--success-soft)",
                  border: "1px solid var(--success)",
                  color: "var(--success-text)",
                  fontSize: "14px",
                }}
                data-testid="resolve-success-banner"
              >
                Tenant identity resolved successfully! Entra ID: <code>{tenantId}</code>
              </div>
            )}

            {resolveError && (
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: "6px",
                  background: "var(--danger-soft)",
                  border: "1px solid var(--danger)",
                  color: "var(--danger-text)",
                  fontSize: "14px",
                }}
                data-testid="resolve-error-banner"
              >
                {resolveError}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div>
                <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600 }}>
                  Display Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Contoso Production"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  style={inputStyle}
                  data-testid="display-name-input"
                />
              </div>

              <div>
                <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600 }}>
                  Primary Domain
                </label>
                <input
                  type="text"
                  placeholder="e.g. contoso.com"
                  value={defaultDomain}
                  onChange={(e) => setDefaultDomain(e.target.value)}
                  style={inputStyle}
                  data-testid="default-domain-input"
                />
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Credentials */}
        {step === 3 && (
          <div data-testid="wizard-step-3" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>Configure Credentials</h2>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              {setupMethod === "create-app"
                ? "Enter administrator credentials required to perform the delegated app creation and admin consent bootstrap."
                : "Provide authentication details for the registered application."}
            </p>

            <div>
              <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600 }}>
                Target Cloud Environment
              </label>
              <select
                value={environment}
                onChange={(e) => setEnvironment(e.target.value as M365Environment)}
                style={selectStyle}
                data-testid="environment-select"
              >
                <option value="commercial">Commercial / Standard</option>
                <option value="gcc">GCC (Government Community Cloud)</option>
                <option value="gcchigh">GCC High</option>
                <option value="dod">DoD (Department of Defense)</option>
              </select>
            </div>

            {setupMethod === "create-app" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <div>
                  <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600 }}>
                    Global / Application Admin UPN *
                  </label>
                  <input
                    type="email"
                    placeholder="admin@contoso.onmicrosoft.com"
                    value={adminUpn}
                    onChange={(e) => setAdminUpn(e.target.value)}
                    style={inputStyle}
                    data-testid="admin-upn-input"
                  />
                  <span style={{ fontSize: "12px", color: "var(--text-soft)", marginTop: "4px", display: "block" }}>
                    Used solely for the bootstrap step to grant admin consent and assign directory roles.
                  </span>
                </div>

                <div>
                  <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600 }}>
                    App Registration Display Name
                  </label>
                  <input
                    type="text"
                    value={appDisplayName}
                    onChange={(e) => setAppDisplayName(e.target.value)}
                    style={inputStyle}
                    data-testid="app-display-name-input"
                  />
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <div>
                  <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600 }}>
                    Authentication Method
                  </label>
                  <select
                    value={authMethod}
                    onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}
                    style={selectStyle}
                    data-testid="auth-method-select"
                  >
                    <option value="certificate-thumbprint">Certificate Thumbprint (Windows Keystore)</option>
                    <option value="certificate-pfx">Certificate PFX File (Cross-platform)</option>
                    <option value="client-secret">Client Secret (Graph only)</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600 }}>
                    Application (Client) ID *
                  </label>
                  <input
                    type="text"
                    placeholder="00000000-0000-0000-0000-000000000000"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    style={inputStyle}
                    data-testid="client-id-input"
                  />
                </div>

                {authMethod === "certificate-thumbprint" && (
                  <div>
                    <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600 }}>
                      Certificate Thumbprint *
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 40-character hex thumbprint"
                      value={certificateThumbprint}
                      onChange={(e) => setCertificateThumbprint(e.target.value)}
                      style={inputStyle}
                      data-testid="thumbprint-input"
                    />
                  </div>
                )}

                {authMethod === "client-secret" && (
                  <div>
                    <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 600 }}>
                      Client Secret *
                    </label>
                    <input
                      type="password"
                      placeholder="Enter client secret value"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      style={inputStyle}
                      data-testid="client-secret-input"
                    />
                    <span style={{ fontSize: "12px", color: "var(--warn-text)", marginTop: "4px", display: "block" }}>
                      Note: Exchange Online and Purview do not support client secrets; certificate auth is recommended.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 4: Groups & Variables */}
        {step === 4 && (
          <div data-testid="wizard-step-4" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>Tenant Groups & Variables (Optional)</h2>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Assign this tenant to groups for targeted assessments and configure template variables.
            </p>

            {availableGroups.length > 0 && (
              <div>
                <label style={{ display: "block", marginBottom: "8px", fontSize: "13px", fontWeight: 600 }}>
                  Assign to Tenant Groups
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  {availableGroups.map((g) => {
                    const isSelected = selectedGroups.includes(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() =>
                          setSelectedGroups((prev) =>
                            isSelected ? prev.filter((id) => id !== g.id) : [...prev, g.id],
                          )
                        }
                        style={{
                          ...buttonStyle,
                          background: isSelected ? "var(--accent)" : "var(--surface)",
                          color: isSelected ? "var(--accent-text)" : "var(--text)",
                          borderColor: isSelected ? "var(--accent)" : "var(--border)",
                        }}
                        data-testid={`group-chip-${g.id}`}
                      >
                        {g.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <label style={{ display: "block", marginBottom: "8px", fontSize: "13px", fontWeight: 600 }}>
                Add Custom Variable
              </label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  placeholder="Variable name (e.g. OrgName)"
                  value={newVarName}
                  onChange={(e) => setNewVarName(e.target.value)}
                  style={{ ...inputStyle, width: "40%" }}
                  data-testid="var-name-input"
                />
                <input
                  type="text"
                  placeholder="Value"
                  value={newVarValue}
                  onChange={(e) => setNewVarValue(e.target.value)}
                  style={{ ...inputStyle, width: "40%" }}
                  data-testid="var-value-input"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (newVarName.trim()) {
                      setVariables((prev) => [...prev, { name: newVarName.trim(), value: newVarValue }]);
                      setNewVarName("");
                      setNewVarValue("");
                    }
                  }}
                  style={buttonStyle}
                  data-testid="add-var-btn"
                >
                  Add
                </button>
              </div>

              {variables.length > 0 && (
                <ul style={{ marginTop: "12px", paddingLeft: "20px" }}>
                  {variables.map((v, i) => (
                    <li key={i} style={{ fontSize: "14px", marginBottom: "4px" }}>
                      <code>%{v.name}%</code> = {v.value}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* Step 5: Test Connection */}
        {step === 5 && (
          <div data-testid="wizard-step-5" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>Test Connection</h2>
            {prerequisitesNotice}
            {onTestConnection ? (
              <>
                <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
                  Optionally verify connectivity to Graph, Exchange Online, and Purview. A failed probe does not block onboarding.
                </p>

                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={testingConnection}
                  style={primaryButtonStyle}
                  data-testid="run-test-connection-btn"
                >
                  {testingConnection ? "Probing Cloud Services..." : "Run Test Connection"}
                </button>
              </>
            ) : (
              <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }} data-testid="test-after-onboarding-note">
                The connection can only be tested once the tenant and its credential exist. Continue to add the tenant,
                then run Test connection from the tenant page.
              </p>
            )}

            {testError && (
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: "6px",
                  background: "var(--danger-soft)",
                  border: "1px solid var(--danger)",
                  color: "var(--danger-text)",
                  fontSize: "14px",
                }}
                data-testid="test-error-banner"
              >
                {testError}
              </div>
            )}

            {serviceResults && (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "12px" }}>
                <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>Service Probe Results</h3>
                {serviceResults.map((sr) => (
                  <div
                    key={sr.service}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "12px 16px",
                      borderRadius: "6px",
                      background: sr.status === "pass" ? "var(--success-soft)" : "var(--danger-soft)",
                      border: `1px solid ${sr.status === "pass" ? "var(--success)" : "var(--danger)"}`,
                      color: sr.status === "pass" ? "var(--success-text)" : "var(--danger-text)",
                    }}
                    data-testid={`service-result-${sr.service}`}
                  >
                    <div>
                      <strong>{sr.service}</strong>
                      {sr.error && <p style={{ margin: "4px 0 0", fontSize: "12px" }}>{sr.error}</p>}
                    </div>
                    <span style={{ fontWeight: 700, textTransform: "uppercase", fontSize: "13px" }}>
                      {sr.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 6: Confirmation */}
        {step === 6 && (
          <div data-testid="wizard-step-6" style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>Confirmation & Consent</h2>

            <div style={warningBannerStyle} data-testid="high-impact-warning">
              <strong>HIGH-IMPACT SETUP ACTION:</strong>
              <p style={{ margin: "6px 0 0" }}>
                Onboarding mutates tenant configuration: it provisions an Entra ID application
                registration, assigns 29 read-only API permissions, grants tenant-wide admin consent,
                and adds directory role memberships. This action requires Global Administrator or
                Application Administrator privileges in the tenant.
              </p>
            </div>

            {prerequisitesNotice}

            <div style={{ background: "var(--surface)", padding: "16px", borderRadius: "8px", fontSize: "14px" }}>
              <h4 style={{ margin: "0 0 10px", fontSize: "15px" }}>Summary</h4>
              <div><strong>Tenant:</strong> {displayName || tenantInput} (<code>{tenantId || tenantInput}</code>)</div>
              <div><strong>Setup Method:</strong> {setupMethod}</div>
              <div><strong>Environment:</strong> {environment}</div>
              {setupMethod === "create-app" && <div><strong>Admin UPN:</strong> {adminUpn}</div>}
              {setupMethod !== "create-app" && clientId && <div><strong>Client ID:</strong> <code>{clientId}</code></div>}
              <div>
                <strong>Portal write access:</strong>{" "}
                {includeWritePermissions ? `operator app (${writeGroups.join(", ") || "no groups selected"})` : "not requested"}
              </div>
            </div>

            <div
              style={{
                padding: "16px",
                borderRadius: "8px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
              }}
              data-testid="write-access-section"
            >
              <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={includeWritePermissions}
                  onChange={(e) => {
                    setIncludeWritePermissions(e.target.checked);
                    if (!e.target.checked) {
                      setWriteGroups([]);
                      setConfirmDangerous(false);
                    }
                  }}
                  style={{ marginTop: "3px" }}
                  data-testid="enable-write-access"
                />
                <span style={{ fontSize: "14px", fontWeight: 600 }}>
                  Also grant portal write access (optional)
                </span>
              </label>

              <p
                style={{ margin: 0, fontSize: "13px", color: "var(--text-soft)" }}
                data-testid="writer-reader-note"
              >
                Write actions use a second app registration, <code>M365-Assess-Operator</code>.
                The reader app registration created for assessments is unchanged and stays read-only.
              </p>

              {includeWritePermissions && (
                <>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {WRITE_GROUPS.map((group) => {
                      const selected = writeGroups.includes(group.id);
                      return (
                        <button
                          key={group.id}
                          type="button"
                          title={group.description}
                          onClick={() =>
                            setWriteGroups((prev) =>
                              selected ? prev.filter((id) => id !== group.id) : [...prev, group.id],
                            )
                          }
                          style={{
                            ...buttonStyle,
                            background: selected ? "var(--accent)" : "var(--surface)",
                            color: selected ? "var(--accent-text)" : "var(--text)",
                            borderColor: selected ? "var(--accent)" : "var(--border)",
                          }}
                          data-testid={`write-group-${group.id}`}
                        >
                          {group.name}
                        </button>
                      );
                    })}
                  </div>

                  {writeGroups.length === 0 && (
                    <p style={{ margin: 0, fontSize: "13px", color: "var(--warn-text)" }} data-testid="write-groups-required">
                      Select at least one group to grant write access.
                    </p>
                  )}

                  {dangerousWriteGroups.length > 0 && (
                    <label
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "10px",
                        cursor: "pointer",
                        padding: "12px",
                        borderRadius: "6px",
                        background: "var(--danger-soft)",
                        border: "1px solid var(--danger)",
                        color: "var(--danger-text)",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={confirmDangerous}
                        onChange={(e) => setConfirmDangerous(e.target.checked)}
                        style={{ marginTop: "3px" }}
                        data-testid="confirm-dangerous"
                      />
                      <span style={{ fontSize: "13px" }}>
                        I understand these groups include dangerous grants: PIM role assignment
                        (including Global Administrator), device wipe, and full SharePoint control.
                      </span>
                    </label>
                  )}
                </>
              )}
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "10px",
                cursor: "pointer",
                padding: "12px",
                background: "var(--surface)",
                borderRadius: "6px",
                border: "1px solid var(--border)",
              }}
            >
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                style={{ marginTop: "3px" }}
                data-testid="confirm-checkbox"
              />
              <span style={{ fontSize: "14px", fontWeight: 500 }}>
                I confirm and explicitly authorize this tenant-mutating setup write.
              </span>
            </label>

            {submitting && (
              <div style={{ fontSize: "13px", color: "var(--text-soft)" }} data-testid="onboarding-progress">
                Creating the app registration and granting permissions. This can take a few minutes.
              </div>
            )}

            {submitting && deviceCode && (
              <div
                style={{
                  padding: "16px",
                  borderRadius: "8px",
                  background: "var(--warn-soft, var(--surface))",
                  border: "1px solid var(--warn, var(--border))",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
                data-testid="device-code-panel"
              >
                <h3 style={{ margin: 0, fontSize: "15px" }} data-testid="device-code-title">
                  Sign in to {deviceCode.provider}
                </h3>
                <p style={{ margin: 0, fontSize: "14px" }} data-testid="device-code-instruction">
                  The onboarding worker has no desktop to show a sign-in prompt on. Open the
                  verification page in any browser, then enter this code for{" "}
                  <strong>{signInLabel(deviceCode.signIn)}</strong>:
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
                  <code
                    style={{
                      padding: "8px 14px",
                      borderRadius: "6px",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      fontSize: "20px",
                      fontWeight: 700,
                      letterSpacing: "2px",
                      userSelect: "all",
                    }}
                    data-testid="device-code-value"
                  >
                    {deviceCode.code}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      void copyDeviceCode();
                    }}
                    style={buttonStyle}
                    data-testid="copy-device-code"
                  >
                    {copyState === "copied" ? "Copied" : copyState === "failed" ? "Select the code" : "Copy code"}
                  </button>
                </div>
                {deviceCode.verificationUrl && (
                  <p style={{ margin: 0, fontSize: "14px" }} data-testid="device-code-verification">
                    Verification page:{" "}
                    <a
                      href={deviceCode.verificationUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--accent)" }}
                      data-testid="device-code-url"
                    >
                      {deviceCode.verificationUrl}
                    </a>
                  </p>
                )}
                {deviceCode.expiresAt && !deviceCodeExpired && (
                  <p
                    style={{ margin: 0, fontSize: "12px", color: "var(--text-soft)" }}
                    data-testid="device-code-expiry"
                  >
                    This code expires at {new Date(deviceCode.expiresAt).toLocaleTimeString()}.
                  </p>
                )}
                {deviceCodeExpired && (
                  <p
                    style={{ margin: 0, fontSize: "13px", color: "var(--danger-text)" }}
                    data-testid="device-code-expired"
                  >
                    This code has expired. Onboarding waits for a fresh code; if it does not
                    appear, submit again.
                  </p>
                )}
              </div>
            )}

            {submitting && !deviceCode && signedInStage && (
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: "6px",
                  background: "var(--success-soft)",
                  border: "1px solid var(--success)",
                  color: "var(--success-text)",
                  fontSize: "13px",
                }}
                data-testid="device-code-signed-in"
              >
                Signed in to {signInLabel(signedInStage)}. Continuing onboarding; another code
                may appear for the next sign-in.
              </div>
            )}

            {submitError && (
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: "6px",
                  background: "var(--danger-soft)",
                  border: "1px solid var(--danger)",
                  color: "var(--danger-text)",
                  fontSize: "14px",
                }}
                data-testid="submit-error-banner"
              >
                {submitError}
              </div>
            )}

            {onboardingResult && !submitting && (
              <div
                style={{
                  padding: "16px",
                  borderRadius: "8px",
                  background: "var(--success-soft)",
                  border: "1px solid var(--success)",
                  color: "var(--success-text)",
                  fontSize: "14px",
                }}
                data-testid="onboarding-result"
              >
                <strong>Onboarding complete.</strong>
                <p style={{ margin: "6px 0 0" }}>
                  The reader app registration and its read-only permissions are unchanged.
                </p>
                {includeWritePermissions ? (
                  <p style={{ margin: "6px 0 0" }} data-testid="operator-result">
                    Write access: the <code>M365-Assess-Operator</code> app was provisioned for{" "}
                    {writeGroups.join(", ")}.
                  </p>
                ) : (
                  <p style={{ margin: "6px 0 0" }} data-testid="reader-only-result">
                    Write access was not requested, so no operator app was created.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer Navigation */}
      <div style={footerStyle}>
        <div>
          {step > 1 && (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              style={buttonStyle}
              data-testid="wizard-prev-btn"
            >
              Previous
            </button>
          )}
          {step === 1 && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              style={buttonStyle}
              data-testid="wizard-cancel-btn"
            >
              Cancel
            </button>
          )}
        </div>

        <div>
          {step < 6 ? (
            <button
              type="button"
              onClick={handleNext}
              disabled={!canGoNext()}
              style={primaryButtonStyle}
              data-testid="wizard-next-btn"
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={
                !confirmed ||
                submitting ||
                !writeSelectionValid ||
                (preflight !== null && !preflight.ready)
              }
              style={{
                ...primaryButtonStyle,
                background: confirmed ? "var(--success)" : "var(--chip)",
                borderColor: confirmed ? "var(--success)" : "var(--border)",
                color: confirmed ? "var(--success-text)" : "var(--text-soft)",
              }}
              data-testid="wizard-submit-btn"
            >
              {submitting ? "Onboarding Tenant..." : "Complete Onboarding"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
