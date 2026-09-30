"use client";

// Teams Activity page (EPIC-026 SPEC.md §3.2, §4.2; T-0507).
// Page title "Teams Activity": usage per team and per user (active users,
// messages, meetings) as report-style tables with drill-through, read from the
// T-0507 API. Period and date filters map to the route query parameters.
import React, { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import {
  TeamsActivityTable,
  type TeamsActivityReportData,
} from "../../../components/teams/TeamsActivityTable";

function TeamsActivityView({ tenantId }: { readonly tenantId: string }): React.ReactElement {
  const [report, setReport] = useState<TeamsActivityReportData | null>(null);
  const [period, setPeriod] = useState<string>("D7");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const loadActivity = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ period });
      if (startDate) query.set("startDate", startDate);
      if (endDate) query.set("endDate", endDate);
      const res = await fetch(`/v1/tenants/${encodeURIComponent(tenantId)}/teams/activity?${query.toString()}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || `Failed to load Teams activity: HTTP ${res.status}`);
      }
      const data = (await res.json()) as TeamsActivityReportData;
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Teams activity");
    } finally {
      setLoading(false);
    }
  }, [tenantId, period, startDate, endDate]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  return (
    <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div style={{ fontSize: "12px", color: "var(--text-muted, #6b7280)" }}>
          <a href={`/teams?tenantId=${encodeURIComponent(tenantId)}`} style={{ color: "inherit", textDecoration: "none" }}>
            Teams &amp; SharePoint &gt; Teams
          </a>{" "}
          &gt; Teams Activity
        </div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: 0 }}>Teams Activity</h1>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted, #6b7280)" }}>
          Usage per team and per user (active users, messages, meetings). Click a team to drill through to its user activity.
        </p>
      </div>

      <TeamsActivityTable
        report={report}
        loading={loading}
        error={error}
        period={period}
        onPeriodChange={setPeriod}
        startDate={startDate}
        onStartDateChange={setStartDate}
        endDate={endDate}
        onEndDateChange={setEndDate}
        onRefresh={() => void loadActivity()}
      />
    </div>
  );
}

export default function TeamsActivityPage(): React.ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <TeamsActivityView tenantId={tenantId} />
    </RequireTenant>
  );
}
