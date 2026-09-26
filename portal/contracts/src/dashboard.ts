// Dashboard read-model contracts (EPIC-004 SPEC.md §4.1, §5, §11.1, T-0061).
// Defines typed per-tenant DashboardPayload and all-tenants FleetPayload shapes
// sourced from persisted Run and Finding rows. Explicit about the empty-state signal
// when a tenant has no completed run.

export const DASHBOARD_SCHEMA_VERSION = "v1" as const;

export type DashboardSchemaVersion = typeof DASHBOARD_SCHEMA_VERSION;

export interface DashboardEmptyState {
  readonly isEmpty: true;
  readonly reason: "no_completed_run";
  readonly message: string;
}

export interface TenantInfoWidget {
  readonly tenantId: string;
  readonly displayName: string | null;
  readonly defaultDomain: string | null;
  readonly initialDomain: string | null;
  readonly status: string;
  readonly source: string;
  readonly lastRunAt: string | null;
}

export interface SecureScoreWidget {
  readonly current: number;
  readonly max: number;
  readonly percentage: number;
  readonly evaluatedCount: number;
}

export interface AssessmentSummaryCounts {
  readonly pass: number;
  readonly fail: number;
  readonly warning: number;
  readonly review: number;
  readonly skipped: number;
  readonly notLicensed: number;
  readonly total: number;
}

export interface AssessmentCardWidget {
  readonly runId: string;
  readonly finishedAt: string | null;
  readonly status: string;
  readonly headlineScore: number;
  readonly summaryCounts: AssessmentSummaryCounts;
}

export interface TenantMetricItem {
  readonly id: string;
  readonly label: string;
  readonly value: number | string;
  readonly status?: "pass" | "fail" | "warn" | "neutral" | string;
}

export interface TenantMetricsGridWidget {
  readonly metrics: readonly TenantMetricItem[];
}

export interface AlertsOverviewWidget {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly total: number;
}

export interface AuthMethodWidget {
  readonly phishingResistant: number;
  readonly authenticatorApp: number;
  readonly smsOrVoice: number;
  readonly passwordOnly: number;
  readonly totalUsers: number;
}

export interface MFAWidget {
  readonly enforcedPercentage: number;
  readonly registeredCount: number;
  readonly totalUsers: number;
  readonly adminMfaPercentage?: number;
}

export interface LicenseSkuItem {
  readonly name: string;
  readonly assigned: number;
  readonly total: number;
}

export interface LicenseWidget {
  readonly topSkus: readonly LicenseSkuItem[];
  readonly totalAssigned: number;
  readonly totalPurchased: number;
}

export interface IdentityWidgetData {
  readonly mfaEnforcedCount: number;
  readonly adminCount: number;
  readonly riskyUserCount: number;
  readonly totalUsers: number;
}

export interface DeviceWidgetData {
  readonly compliantCount: number;
  readonly nonCompliantCount: number;
  readonly totalDevices: number;
}

export interface DashboardPayload {
  readonly schemaVersion: DashboardSchemaVersion;
  readonly tenantId: string;
  readonly tenantInfo: TenantInfoWidget;
  readonly isEmpty: boolean;
  readonly emptyState: DashboardEmptyState | null;
  readonly score: SecureScoreWidget | null;
  readonly assessment: AssessmentCardWidget | null;
  readonly metrics: TenantMetricsGridWidget | null;
  readonly alerts: AlertsOverviewWidget | null;
  readonly authMethods: AuthMethodWidget | null;
  readonly mfa: MFAWidget | null;
  readonly licenses: LicenseWidget | null;
  readonly identity: IdentityWidgetData | null;
  readonly devices: DeviceWidgetData | null;
  readonly generatedAt: string;
}

export interface FleetFindingCounts {
  readonly pass: number;
  readonly fail: number;
  readonly warning: number;
  readonly total: number;
}

export interface FleetTenantItem {
  readonly tenantId: string;
  readonly displayName: string | null;
  readonly defaultDomain: string | null;
  readonly status: string;
  readonly hasCompletedRun: boolean;
  readonly score: number | null;
  readonly complianceRate: number | null;
  readonly lastRunAt: string | null;
  readonly lastRunId: string | null;
  readonly lastRunStatus: string | null;
  readonly findingCounts: FleetFindingCounts | null;
  readonly openAlerts: AlertsOverviewWidget;
}

export interface FleetPayload {
  readonly schemaVersion: DashboardSchemaVersion;
  readonly items: readonly FleetTenantItem[];
  readonly total: number;
  readonly generatedAt: string;
}

export function isDashboardEmpty(payload: DashboardPayload): boolean {
  return payload.isEmpty;
}
