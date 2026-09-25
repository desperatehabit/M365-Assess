# COMPLIANCE-AUDIT-001 — Ensure Microsoft 365 audit log search is enabled

- **Mode:** automated
- **Severity:** High
- **License:** E3
- **Collector:** Compliance
- **Category:** AUDIT
- **Registry:** `src/M365-Assess/controls/registry.json` → checkId `COMPLIANCE-AUDIT-001`
- **Command source:** `remediation.powershell.command` (registry)

## Desired state

Unified audit log ingestion is enabled tenant-wide:
`UnifiedAuditLogIngestionEnabled = $true` on the tenant's admin audit log config.

## Command

```powershell
Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true
```

- Deterministic, idempotent (re-running on an already-enabled tenant is a no-op).
- EXO/Purview session required — the remediation executor must run inside the tenant's
  connected process (see `00-guides/01-architecture.md` §3).
- **Must be hand-validated against a real tenant before the apply path ships**
  (`00-guides/06-remediation.md` §2.2). This doc records the validation result.

## Preconditions

| Gate | Requirement |
|---|---|
| License | E3 minimum (registry `licensing.minimum`) |
| Service | Purview / Exchange Online connected |
| RBAC | Caller holds an allowlisted remediation permission |
| Scope | Tenant in caller's `UserScope` |
| Allowlist | `COMPLIANCE-AUDIT-001` on the remediation allowlist |
| Tenant flag | Tenant not marked read-only |

## Before / After capture

- **Before:** `Get-AdminAuditLogConfig | Select-Object UnifiedAuditLogIngestionEnabled`
- **After:** same cmdlet, re-read; record both in `RemediationAction.before`/`.after`.

## Verification

- Re-run the `Compliance` collector and confirm `COMPLIANCE-AUDIT-001` reports `Pass`.
- Audit ingestion can take up to ~60 minutes to begin populating; the check reads the config
  flag, not log volume, so verification is immediate.

## Rollback / safety

- Reverse with `Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $false`.
- Enabling audit logging is low-risk and additive; no user-facing disruption.
- Record the reversal as its own `RemediationAction` if ever applied.

## Test plan

- [ ] Unit: gate — a tenant missing E3 is `skipped` with `license-missing`.
- [ ] Unit: gate — a non-allowlisted checkId is `skipped` with `not-allowlisted`.
- [ ] Unit: idempotency — second apply is a no-op and writes an audit event.
- [ ] Integration (live tenant, gated): apply flips the flag; re-check passes.
- [ ] Audit: `before`/`after`/command/actor/timestamp recorded.
