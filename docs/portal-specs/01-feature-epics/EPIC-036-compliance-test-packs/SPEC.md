# EPIC-036 — Compliance Test Packs

- **Status:** Drafted
- **Cluster:** Tenant Ops
- **Severity:** medium
- **Depends on:** EPIC-003, EPIC-007, EPIC-029
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #10; CIPP `CIPPTests/Public/Tests/` (CIS, CISA, EIDSCA, ORCA, ZTNA, SMB1001, E8, CopilotReadiness, Custom)
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Framework test packs and custom tests on top of the module's existing framework mappings: run a
named pack (CIS, CISA, ORCA, E8, etc.), score it, author custom tests, and produce test reports.
The module already ships 15 framework JSONs and the 292-check registry; this epic adds pack
management, custom authoring, and reporting.

### Planned scope

- Pack definitions + scoring
- Custom test authoring + versions
- Test reports
- Enable/disable + alerts

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an assessor, I can run a named test pack against a tenant. | `T-TP-01` run pack |
| US-2 | As an assessor, I can see a scored pack report. | `T-TP-02` pack report |
| US-3 | As an assessor, I can author a custom test. | `T-TP-03` custom tests |
| US-4 | As an assessor, I can version and enable/disable custom tests. | `T-TP-04` versions/enable |
| US-5 | As an assessor, I can alert on custom-test failures. | `T-TP-05` test alerts |

## 3. UI design

Nav: *Tools → Custom Tests* and *Tenant Administration → Reports → Custom Test Report*
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Packs (US-1, US-2)

Page title: **Compliance Test Packs**. List of available packs (CIS, CISA, EIDSCA, ORCA, ZTNA,
SMB1001, E8, CopilotReadiness, Custom) with description and check count. Row actions: `Run`,
`View report`, `Configure`. A pack report shows per-control results and a score, reusing the
report's framework-quilt/scoring components.

### 3.2 Custom tests (US-3, US-4)

Page title: **Custom Tests**. Table: Name · Category · Enabled · Alerts · Version · Last run. Row
actions: `Edit`, `View versions`, `Enable/Disable test`, `Enable/Disable alerts`, `Delete`,
`Save to GitHub` (EPIC-039).

Editor: `ScriptContent` (PowerShell), a `MarkdownTemplate` for output, `TestParameters` JSON, and
an **Explore data structure** helper. Saving creates a version.

### 3.3 Test reports (US-2)

Generated pack/test reports with scores, per-control detail, and export.

### 3.4 Test alerts (US-5)

Enable alerts on a custom test's failure; delivery via EPIC-029.

## 4. Workflows

### 4.1 Run a pack (US-1)

1. Operator selects a pack and tenant; the pack expands to its checks.
2. The run reuses the assessment engine (EPIC-003) for the checks it needs.
3. Results are scored per the pack definition and stored as a test report.

### 4.2 Custom test (US-3)

1. Author script + template + parameters; save a version.
2. A dry run shows output against a tenant.
3. Enabling schedules/exposes the test; execution is **sandboxed** (EPIC-007).

### 4.3 Test alerts (US-5)

A failing custom test fires an alert (EPIC-029) with the test's output.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `TestPack` | `id`, `name`, `description`, `checkIds[]`/`frameworkId`, `scoring` | derived from module frameworks |
| `TestRun` | `id`, `packId`/`testId`, `tenantId`, `at`, `score`, `results[]` | report source |
| `CustomTest` | `id`, `name`, `category`, `enabled`, `alertsEnabled`, `currentVersionId` | |
| `CustomTestVersion` | `id`, `testId`, `content`, `markdownTemplate`, `parameters`, `createdAt`, `createdBy` | immutable |
| `AuditEvent` | full shape | test changes |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/test-packs` | available packs |
| `POST` | `/v1/test-packs/{id}/run` | run |
| `GET` | `/v1/test-runs/{id}` | report |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/custom-tests` … | custom tests |
| `GET`/`POST` | `/v1/custom-tests/{id}/versions` … | versions |
| `POST` | `/v1/custom-tests/{id}/run` | dry-run/run |

## 7. Permissions & scopes

- **RBAC:** `tests.read`, `tests.run`, `tests.write`; custom-test authoring/execution is high
  privilege (arbitrary script) and gated like EPIC-007. Tenant-scoped (EPIC-038).

## 8. Remediation behavior

Test packs and custom tests are **read-only** against tenants unless a custom test explicitly
writes, in which case it obeys EPIC-006 and the EPIC-007 sandbox. Standard packs never write.

## 9. Dependencies & risks

- Depends on EPIC-003 (assessment engine), EPIC-007 (sandbox + scheduling), EPIC-029 (alerts).
- **Risk: overlap with the module's existing frameworks/registry.** Mitigation: packs are derived
  from the module's framework JSONs; no duplication of check logic.
- **Risk: arbitrary code in custom tests.** Mitigation: sandbox, admin gate, audit.
- **Risk: pack scoring divergence.** Mitigation: define scoring once per pack; document it.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] A named pack runs and produces a scored report.
- [ ] Custom tests author, version, enable/disable, and run in the sandbox.
- [ ] Test alerts fire on custom-test failure.
- [ ] Packs are derived from module frameworks (no duplicated check logic).

## 11. Open questions

1. **Pack set for v1** — **Resolved (adopted):** ship CIS and Essential Eight (E8) first;
   the remaining packs (CISA, EIDSCA, ORCA, ZTNA, SMB1001, CopilotReadiness) are later cuts.
2. **Relationship to existing 15 framework JSONs** — **Resolved (adopted):** pack definitions are
   **derived from** the module's framework JSONs, not a parallel set; no check logic is duplicated.
   Implemented by T-0701.
3. **Scoring model** — **Resolved (adopted):** a **per-pack score** computed through one shared
   normalization. Implemented by T-0701.
4. **Custom test parameters** — **Resolved (adopted):** a typed parameter schema with validation on
   author-save and run. Implemented by T-0705.

---

## See also

- [`../EPIC-003-assessment-runs/SPEC.md`](../EPIC-003-assessment-runs/SPEC.md) — engine
- [`../EPIC-007-scheduler-custom-scripts/SPEC.md`](../EPIC-007-scheduler-custom-scripts/SPEC.md) — sandbox
- [`../EPIC-029-alerting-notifications/SPEC.md`](../EPIC-029-alerting-notifications/SPEC.md) — test alerts
- [`epic.md`](epic.md) — fleet rollup
