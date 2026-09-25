# 0015 — Portal storage starts on SQLite behind a repository interface

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

The portal must persist tenants, credentials references, runs, findings, remediation plans/actions, standards templates, drift deviations, baselines, alerts, schedules, RBAC, and an append-only audit log ([`00-guides/03-database.md`](../portal-specs/00-guides/03-database.md), [`04-data-modeling.md`](../portal-specs/00-guides/04-data-modeling.md)).

The owner's tenant model is "mixed / not sure yet", and there is no commitment to Azure on day one. The options:

- **SQLite (file-based).** Zero infrastructure; a single file; transactional; ships with the service.
- **Azure Table/Blob/Key Vault.** CIPP's model; serverless-friendly but locks the project to Azure and requires an Azure subscription to run at all.
- **PostgreSQL.** Robust, concurrent, but needs a server to operate.
- **JSON files only.** Simplest, but no queries, transactions, or concurrent-write safety.

Two constraints matter: the storage choice must not block local development, and it must be swappable later without rewriting feature code.

## Decision

Portal storage starts on **SQLite** for single-node development and small deployments, accessed through a **repository interface** that all feature code depends on. Artifacts (HTML/XLSX/JSON/evidence) live on the filesystem initially; secrets live in a separate credential store (OS keystore in dev, Key Vault in prod), referenced — never embedded — by data rows.

Sub-parts:

- Migrations are numbered and forward-only; a `schemaVersion` row gates startup.
- The repository interface is the only place the engine is named. Moving to Azure Table/Blob or Postgres is a later ticket, not a rewrite.
- Tenant scoping, soft delete, and the append-only audit log are enforced in the repository layer, not left to callers.

## Consequences

**Positive**

- Development starts with no infrastructure: clone, run, a `portal.db` appears.
- Transactions give the audit log and remediation records the atomicity they need.
- The repository interface keeps the eventual production choice open (Azure, Postgres, or stay on SQLite).
- Portable across Windows/Linux/macOS for contributors.

**Negative**

- SQLite has a single-writer model; concurrent writes serialize. Fine for single-node, not for a multi-instance deployment.
- No built-in replication, backup, or HA — backup/restore is EPIC-035's job.
- The repository abstraction is extra code that a direct-to-Azure implementation would not need.
- Large fleets may outgrow SQLite and force the migration earlier than planned.

**Failure modes and mitigations**

- *Multi-instance deployment on SQLite* → explicitly unsupported; the migration to a networked store is a prerequisite for scale-out, tracked in EPIC-035/EPIC-001.
- *Database file corruption* → backups (EPIC-035) + WAL mode + migration gate.
- *Interface leak* (SQL string in feature code) → lint/review rule; repository is the only DB-aware layer.

## Alternatives considered

- **Azure Table/Blob/Key Vault now.** Rejected: locks the project to Azure, requires an Azure subscription for any local run, and contradicts the "don't commit to Azure on day one" guidance.
- **PostgreSQL now.** Rejected: operational overhead disproportionate to a single-node start; easy to adopt later behind the same interface.
- **JSON files only.** Rejected: no transactions, no query model, unsafe concurrent writes — inadequate for audit and remediation records.
- **An embedded document DB.** Rejected: no clear advantage over SQLite, smaller ecosystem, and a harder migration target.

---

## See also

- [`../portal-specs/00-guides/03-database.md`](../portal-specs/00-guides/03-database.md) — storage tiers, credentials, audit
- [`../portal-specs/01-feature-epics/EPIC-001-platform-foundation/SPEC.md`](../portal-specs/01-feature-epics/EPIC-001-platform-foundation/SPEC.md) — storage bootstrap
- [`0014-thin-bff-over-powershell-workers.md`](0014-thin-bff-over-powershell-workers.md) — HTTP/runtime decision
- [`README.md`](README.md) — back to the ADR index
