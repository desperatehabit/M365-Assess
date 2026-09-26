// Findings filter model and URL query serialization (EPIC-004 SPEC.md §4.2, T-0069).
// Manages typed filter context across tenant, widget metrics, status, and severity,
// with round-trip URL query serialization and client-side predicate matching.

export interface FindingsFilter {
  readonly tenantId?: string | null;
  readonly runId?: string | null;
  readonly status?: string | null; // Pass, Fail, Warning, Review, Info, Skipped, Unknown, NotApplicable, NotLicensed
  readonly severity?: string | null; // Critical, High, Medium, Low
  readonly category?: string | null;
  readonly collector?: string | null;
  readonly search?: string | null;
}

export interface FindingLike {
  readonly id: string;
  readonly tenantId?: string;
  readonly runId?: string;
  readonly status: string;
  readonly severity?: string | null;
  readonly category?: string | null;
  readonly collector?: string | null;
  readonly controlName?: string | null;
  readonly title?: string;
  readonly message?: string;
}

/**
 * Serializes a FindingsFilter into a URL query parameter string.
 */
export function serializeFindingsFilter(filter: FindingsFilter): string {
  const params = new URLSearchParams();

  if (filter.tenantId) params.set("tenantId", filter.tenantId);
  if (filter.runId) params.set("runId", filter.runId);
  if (filter.status) params.set("status", filter.status);
  if (filter.severity) params.set("severity", filter.severity);
  if (filter.category) params.set("category", filter.category);
  if (filter.collector) params.set("collector", filter.collector);
  if (filter.search) params.set("q", filter.search);

  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * Parses a FindingsFilter from URLSearchParams, location.search, or a query string.
 */
export function parseFindingsFilter(input: URLSearchParams | string): FindingsFilter {
  const params =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;

  return {
    tenantId: params.get("tenantId") || null,
    runId: params.get("runId") || null,
    status: params.get("status") || null,
    severity: params.get("severity") || null,
    category: params.get("category") || null,
    collector: params.get("collector") || null,
    search: params.get("q") || params.get("search") || null,
  };
}

/**
 * Builds a navigation URL to a findings view with the serialized filter.
 */
export function buildFindingsUrl(basePath: string, filter: FindingsFilter): string {
  const query = serializeFindingsFilter(filter);
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return `${base}${query}`;
}

/**
 * Derives a FindingsFilter from a widget type and clicked metric key.
 */
export function filterFromWidgetMetric(
  widgetType: string,
  metricKey: string,
  tenantId?: string | null,
  runId?: string | null,
): FindingsFilter {
  const base: FindingsFilter = {
    tenantId: tenantId ?? null,
    runId: runId ?? null,
  };

  const keyLower = metricKey.toLowerCase();
  const typeLower = widgetType.toLowerCase();

  // Alerts Overview widget drill-down
  if (typeLower.includes("alert")) {
    switch (keyLower) {
      case "critical":
        return { ...base, severity: "Critical", status: "Fail" };
      case "high":
        return { ...base, severity: "High", status: "Fail" };
      case "medium":
        return { ...base, severity: "Medium" };
      case "low":
        return { ...base, severity: "Low" };
      default:
        return { ...base, status: "Fail" };
    }
  }

  // Assessment summary counts drill-down
  if (typeLower.includes("assessment")) {
    switch (keyLower) {
      case "fail":
        return { ...base, status: "Fail" };
      case "pass":
        return { ...base, status: "Pass" };
      case "warning":
        return { ...base, status: "Warning" };
      case "review":
        return { ...base, status: "Review" };
      case "skipped":
        return { ...base, status: "Skipped" };
      default:
        return base;
    }
  }

  // Tenant Metrics Grid drill-down
  if (typeLower.includes("metric")) {
    switch (keyLower) {
      case "failed":
        return { ...base, status: "Fail" };
      case "passed":
        return { ...base, status: "Pass" };
      case "warnings":
        return { ...base, status: "Warning" };
      case "critical-high":
        return { ...base, severity: "Critical", status: "Fail" };
      default:
        return base;
    }
  }

  // Identity widgets (MFA, AuthMethods, SecureScore)
  if (typeLower.includes("auth") || typeLower.includes("mfa") || typeLower.includes("identity")) {
    return { ...base, category: "Identity", search: metricKey };
  }

  return base;
}

/**
 * Predicate to evaluate whether a finding satisfies a FindingsFilter.
 */
export function matchesFindingsFilter(finding: FindingLike, filter: FindingsFilter): boolean {
  if (filter.tenantId && finding.tenantId && finding.tenantId !== filter.tenantId) {
    return false;
  }

  if (filter.runId && finding.runId && finding.runId !== filter.runId) {
    return false;
  }

  if (filter.status && filter.status.toLowerCase() !== "all") {
    if (finding.status.toLowerCase() !== filter.status.toLowerCase()) {
      return false;
    }
  }

  if (filter.severity && filter.severity.toLowerCase() !== "all") {
    if (!finding.severity || finding.severity.toLowerCase() !== filter.severity.toLowerCase()) {
      return false;
    }
  }

  if (filter.category && filter.category.toLowerCase() !== "all") {
    if (!finding.category || finding.category.toLowerCase() !== filter.category.toLowerCase()) {
      return false;
    }
  }

  if (filter.collector && filter.collector.toLowerCase() !== "all") {
    if (!finding.collector || finding.collector.toLowerCase() !== filter.collector.toLowerCase()) {
      return false;
    }
  }

  if (filter.search && filter.search.trim().length > 0) {
    const q = filter.search.trim().toLowerCase();
    const haystack = [
      finding.id,
      finding.controlName,
      finding.title,
      finding.message,
      finding.category,
      finding.collector,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (!haystack.includes(q)) {
      return false;
    }
  }

  return true;
}
