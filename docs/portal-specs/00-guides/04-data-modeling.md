# 04 — Data Modeling

- **Status:** Drafted
- **Audience:** Every spec that introduces or changes an entity; every API/storage ticket.
- **Related:** [`03-database.md`](03-database.md), [`05-programming.md`](05-programming.md)

## 1. Modeling rules

1. **Model the domain, not the UI.** A screen may join several entities; an entity is a
   thing with identity and lifecycle.
2. **Tenant-scoped entities carry `tenantId`; global entities do not.** Tenant, Run,
   Finding, Standard-assignment, Drift deviation are tenant-scoped. Template, Standard
   definition, Alert-rule definition, Role are global (assignment rows are scoped).
3. **The control registry is the source of truth for checks.** `registry.json` checkIds are
   the canonical IDs; portal entities *reference* them, never re-key them.
4. **Immutability for history.** Runs, findings snapshots, and audit events are immutable.
   Live configuration (tenants, templates) is mutable with soft delete.
5. **Reference by ID, embed by value only when immutable.** Findings embed a snapshot of the
   control (name/status/severity) so history survives registry changes.
6. **Enums are closed sets with an owning spec.** Status, severity, remediation mode, etc.
   are defined once and referenced.

## 2. Core entity catalog

### Tenancy

| Entity | Scope | Key fields | Notes |
|---|---|---|---|
| `Tenant` | global | `id` (= Entra tenant GUID), `displayName`, `defaultDomain`, `initialDomain`, `source(direct\|gdap)`, `status(active\|excluded\|error)`, `excluded`, `lastRunAt`, `errorCount` | Dual-shape identity per module ADR-0012 |
| `TenantGroup` | global | `id`, `name`, `kind(static\|dynamic)`, `filter` | Dynamic filter on SKU/variable |
| `TenantGroupMember` | global | `groupId`, `tenantId` | |
| `TenantVariable` | tenant | `tenantId`, `name`, `value` | `%name%` substitution in standards |
| `TenantCredential` | tenant | `tenantId`, `authMethod`, `clientId`, `secretRef`, `thumbprint`, `environment`, `expiresOn`, `lastValidated` | See 03-database §4 |
| `GdapRelationship` | tenant | `tenantId`, `relationshipEnd`, `delegatedPrivilegeStatus`, `cpvConsentState`, `lastSynced` | GDAP satellite (optional) |

### Runs & findings

| Entity | Scope | Key fields | Notes |
|---|---|---|---|
| `Run` | tenant | `id`, `tenantId`, `trigger(manual\|schedule\|api)`, `sections[]`, `startedAt`, `finishedAt`, `status`, `artifactPath`, `summaryCounts`, `provenance` | One per tenant-run |
| `RunSection` | run | `runId`, `section`, `collector`, `status`, `startedAt`, `finishedAt` | Progress granularity |
| `Finding` | run (snapshot) | `id`, `runId`, `tenantId`, `checkId`, `controlName`, `category`, `collector`, `status`, `severity`, `currentValue`, `recommendedValue`, `evidence`, `frameworkRefs[]`, `remediationMode` | Immutable snapshot |
| `BaselineSnapshot` | tenant | `id`, `tenantId`, `label`, `takenAt`, `findingsDigest` | Module baselines, indexed |
| `BaselineDiff` | tenant | `baselineId`, `fromRunId`, `toRunId`, `changes[]` | Drift between runs |

### Remediation

| Entity | Scope | Key fields | Notes |
|---|---|---|---|
| `RemediationPlan` | run/finding | `id`, `tenantId`, `runId`, `findingIds[]`, `mode(manual\|automated)`, `createdAt`, `createdBy` | Plan-only output |
| `RemediationAction` | plan | `id`, `planId`, `checkId`, `command`, `target`, `state(planned\|approved\|applied\|failed\|skipped)`, `before`, `after`, `appliedAt`, `appliedBy`, `result` | Executed step + audit |
| `ManualInstruction` | control (global) | `checkId`, `portalPath`, `steps[]`, `notes` | From registry `remediation.portal` |

### Standards / Drift / Baselines

| Entity | Scope | Key fields | Notes |
|---|---|---|---|
| `StandardDefinition` | global | `id`, `checkId` (or check-group), `name`, `category`, `licensePreset` | Maps to registry checks |
| `StandardTemplate` | global | `id`, `name`, `kind(standards\|drift)`, `actions{report,alert,remediate}`, `settings[]`, `schedule` | CIPP template |
| `TemplateAssignment` | global | `templateId`, `targetType(allTenants\|group\|tenant)`, `targetId`, `precedence` | 3-tier merge: all → group → tenant |
| `DriftDeviation` | tenant | `id`, `tenantId`, `checkId`, `current`, `expected`, `state(open\|accepted\|customerSpecific\|denied\|deletePending)`, `reason`, `expiresOn`, `autoRemediateOnExpiry` | Triage workflow |
| `Baseline` | global | `id`, `name`, `stages[]`, `logic` | CIPP baselines engine |
| `BaselineStage` | baseline | `baselineId`, `order`, `conditions[]`, `action` | Rollout staging |
| `BaselineRollout` | tenant | `baselineId`, `tenantId`, `stage`, `state`, `lastRunAt`, `history[]` | Progress + trend |

### Operations

| Entity | Scope | Key fields | Notes |
|---|---|---|---|
| `Job` | global | `id`, `type(assessment\|standards\|drift\|baseline\|backup)`, `tenantId`, `payload`, `state(queued\|running\|done\|failed)`, `attempts`, `progress` | Queue item |
| `Schedule` | global | `id`, `type`, `cron`, `targetScope`, `enabled`, `lastRunAt`, `nextRunAt` | Scheduler |
| `AlertRule` | global | `id`, `name`, `source`, `conditions[]`, `actions[]`, `enabled`, `snoozeUntil` | Built-in + custom |
| `AlertEvent` | tenant | `id`, `ruleId`, `tenantId`, `firedAt`, `severity`, `payload`, `state(open\|snoozed\|resolved)` | |
| `NotificationConfig` | global | `id`, `channel(email\|webhook\|psa\|slack)`, `target`, `enabled` | Delivery |
| `WebhookSubscription` | global | `id`, `resource`, `expiresOn`, `state` | Graph change notifications |

### Platform

| Entity | Scope | Key fields | Notes |
|---|---|---|---|
| `PortalUser` | global | `id`, `upn`, `displayName`, `status`, `preferences` | Federated identity |
| `Role` | global | `id`, `name`, `permissions[]`, `builtin` | CIPP role presets |
| `UserScope` | global | `userId`, `targetType(tenant\|group\|all)`, `targetId` | Tenant scoping |
| `ApiClient` | global | `id`, `name`, `secretHash`, `scopes[]`, `rateLimit`, `enabled` | External API |
| `BrandingConfig` | global | `colors`, `logoRef`, `watermark`, `footer` | White-label |
| `FeatureFlag` | global | `key`, `enabled`, `scope` | Progressive rollout |
| `Template` | global | `id`, `type(CA\|Intune\|transport\|... )`, `body`, `source(local\|community)` | Template library |
| `AuditEvent` | global | see 03-database §6 | Append-only |

## 3. Relationships (high level)

```
Tenant 1─* Run 1─* Finding
Tenant 1─* TenantCredential
Tenant *─* TenantGroup (via TenantGroupMember)
Tenant 1─* TenantVariable
Run 1─* RemediationPlan 1─* RemediationAction
StandardTemplate 1─* TemplateAssignment *─1 (Tenant | TenantGroup | All)
StandardDefinition 1─* DriftDeviation (per tenant)
Baseline 1─* BaselineStage ; Baseline 1─* BaselineRollout *─1 Tenant
AlertRule 1─* AlertEvent
PortalUser *─* UserScope ; PortalUser *─1 Role
Finding *─1 StandardDefinition (by checkId, soft link)
```

## 4. Naming conventions

- Entity names singular PascalCase in prose and code (`Tenant`, `RemediationAction`).
- Table names plural snake_case in SQL (`tenants`, `remediation_actions`).
- IDs are opaque strings (UUID or the module's tenant GUID). Check IDs use the module's
  `checkId` verbatim, including sub-numbering (`CA-REPORTONLY-001.1`).
- Timestamps are UTC ISO-8601, suffixed `At` (`createdAt`, `appliedAt`).
- Booleans read as assertions (`excluded`, `enabled`), never `isX`/`hasX`.

## 5. Checklist for entity-changing specs

- [ ] New/changed entity listed here first?
- [ ] Scope (tenant vs global) stated?
- [ ] Lifecycle (create/update/delete/soft-delete) defined?
- [ ] Relationships added to §3?
- [ ] Registry checkIds referenced, not re-keyed?
- [ ] Migration + audit implications noted (03-database)?

## See also

- [`03-database.md`](03-database.md) — storage & audit
- [`06-remediation.md`](06-remediation.md) — RemediationPlan/Action semantics
- [`01-architecture.md`](01-architecture.md) — where entities are owned
