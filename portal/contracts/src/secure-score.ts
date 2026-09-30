// Secure Score contracts (EPIC-031 SPEC.md §5). SecureScoreSnapshot is the trend
// source (SPEC §4.2): one row per tenant per observation, pruned by the
// configured retention window (03-database.md §7). ScoreActionMapping is the
// action→remediation link: global and registry-derived (SPEC §11.1), so it
// carries no tenantId. Mapping changes are routed through the AuditEvent shape
// (03-database.md §6). Types only — no HTTP or storage behavior lives in this
// module.

export interface SecureScoreSnapshot {
  id: string;
  tenantId: string;
  at: string;
  current: number;
  max: number;
  percentage: number;
  categories: Record<string, unknown>;
}

// Storage metadata: snapshots are append-only trend points.
export interface SecureScoreSnapshotRecord extends SecureScoreSnapshot {
  createdAt: string;
}

export interface ScoreActionMapping {
  actionId: string;
  checkId: string;
  standardKey: string;
}

// Storage metadata: mappings are upserted in place, never deleted.
export interface ScoreActionMappingRecord extends ScoreActionMapping {
  createdAt: string;
  updatedAt: string;
}
