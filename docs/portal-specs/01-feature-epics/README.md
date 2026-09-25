# Feature Epics — Index & Status

> Generated tracker for the 41 portal feature epics. Update `Status` in each SPEC.md's
> header; this table reflects it. **Stub** = skeleton only; **Drafted** = sections 2-11
> written; **Approved** = owner sign-off, ready for ticket authoring.

| Epic | Title | Cluster | Sev | Depends on | Status |
|---|---|---|---|---|---|
| [EPIC-001](EPIC-001-platform-foundation/SPEC.md) | Platform Foundation | Platform | critical | none | Drafted |
| [EPIC-002](EPIC-002-tenants-onboarding/SPEC.md) | Tenants & Onboarding | Platform | critical | EPIC-001 | Drafted |
| [EPIC-003](EPIC-003-assessment-runs/SPEC.md) | Assessment Runs & Queue | Platform | high | EPIC-001, EPIC-002 | Drafted |
| [EPIC-004](EPIC-004-dashboard-widgets/SPEC.md) | Dashboard & Widgets | Platform | high | EPIC-003, EPIC-008, EPIC-009 | Drafted |
| [EPIC-005](EPIC-005-executive-reports/SPEC.md) | Executive/PDF Reports & Report Builder | Platform | high | EPIC-003, EPIC-004, EPIC-031, EPIC-037, EPIC-007, EPIC-029 | Drafted |
| [EPIC-006](EPIC-006-remediation-engine/SPEC.md) | Remediation Engine | Platform | critical | EPIC-001, EPIC-002 | Drafted |
| [EPIC-007](EPIC-007-scheduler-custom-scripts/SPEC.md) | Scheduler & Custom Scripts | Platform | high | EPIC-003, EPIC-001, EPIC-002 | Drafted |
| [EPIC-008](EPIC-008-standards-templates/SPEC.md) | Standards Templates | Standards | critical | EPIC-006, EPIC-003, EPIC-007 | Drafted |
| [EPIC-009](EPIC-009-drift-management/SPEC.md) | Drift Management | Standards | high | EPIC-008 | Drafted |
| [EPIC-010](EPIC-010-baselines-rollouts/SPEC.md) | Baselines & Rollouts | Standards | medium | EPIC-008, EPIC-006, EPIC-007 | Drafted |
| [EPIC-011](EPIC-011-users-offboarding/SPEC.md) | Users & Offboarding | Identity | high | EPIC-002, EPIC-006 | Drafted |
| [EPIC-012](EPIC-012-mfa-auth-methods/SPEC.md) | MFA & Auth Methods | Identity | high | EPIC-011, EPIC-006 | Drafted |
| [EPIC-013](EPIC-013-roles-pim-jit/SPEC.md) | Roles, PIM & JIT | Identity | high | EPIC-011, EPIC-006, EPIC-038 | Drafted |
| [EPIC-014](EPIC-014-groups/SPEC.md) | Groups | Identity | medium | EPIC-011, EPIC-006 | Drafted |
| [EPIC-015](EPIC-015-conditional-access/SPEC.md) | Conditional Access | Identity | high | EPIC-002, EPIC-006 | Drafted |
| [EPIC-016](EPIC-016-intune-policies/SPEC.md) | Intune Policies | Devices | high | EPIC-002, EPIC-006 | Drafted |
| [EPIC-017](EPIC-017-intune-apps-autopilot/SPEC.md) | Intune Apps & Autopilot | Devices | medium | EPIC-016, EPIC-006, EPIC-007 | Drafted |
| [EPIC-018](EPIC-018-device-actions/SPEC.md) | Device Actions & BitLocker | Devices | medium | EPIC-016, EPIC-006 | Drafted |
| [EPIC-019](EPIC-019-defender-vulnerabilities/SPEC.md) | Defender & Vulnerabilities | Devices | medium | EPIC-002, EPIC-006, EPIC-016 | Drafted |
| [EPIC-020](EPIC-020-mailboxes/SPEC.md) | Mailboxes | Email | high | EPIC-002, EPIC-006 | Drafted |
| [EPIC-021](EPIC-021-transport-connectors/SPEC.md) | Transport & Connectors | Email | medium | EPIC-020, EPIC-006 | Drafted |
| [EPIC-022](EPIC-022-spam-quarantine/SPEC.md) | Spam, Quarantine & Allow/Block | Email | high | EPIC-020, EPIC-006 | Drafted |
| [EPIC-023](EPIC-023-contacts-resources/SPEC.md) | Contacts & Resources | Email | low | EPIC-020, EPIC-006 | Drafted |
| [EPIC-024](EPIC-024-email-tools/SPEC.md) | Email Tools | Email | medium | EPIC-020, EPIC-006 | Drafted |
| [EPIC-025](EPIC-025-sharepoint-onedrive/SPEC.md) | SharePoint & OneDrive | Collaboration | high | EPIC-002, EPIC-006 | Drafted |
| [EPIC-026](EPIC-026-teams-voice/SPEC.md) | Teams & Voice | Collaboration | medium | EPIC-002, EPIC-006 | Drafted |
| [EPIC-027](EPIC-027-sharing-permissions-reports/SPEC.md) | Sharing & Permissions Reports | Collaboration | medium | EPIC-025, EPIC-020, EPIC-006 | Drafted |
| [EPIC-028](EPIC-028-incidents-alerts-triage/SPEC.md) | Incidents & Alerts Triage | Security | high | EPIC-002, EPIC-006, EPIC-029 | Drafted |
| [EPIC-029](EPIC-029-alerting-notifications/SPEC.md) | Alerting & Notifications | Security | high | EPIC-007, EPIC-003, EPIC-002 | Drafted |
| [EPIC-030](EPIC-030-purview-dlp-labels/SPEC.md) | Purview, DLP & Labels | Security | high | EPIC-002, EPIC-006 | Drafted |
| [EPIC-031](EPIC-031-secure-score/SPEC.md) | Secure Score | Security | medium | EPIC-003, EPIC-007, EPIC-006, EPIC-008 | Drafted |
| [EPIC-032](EPIC-032-audit-logs-webhooks/SPEC.md) | Audit Logs & Webhooks | Security | medium | EPIC-002, EPIC-007, EPIC-029 | Drafted |
| [EPIC-033](EPIC-033-licensing/SPEC.md) | Licensing | Tenant Ops | medium | EPIC-002, EPIC-006, EPIC-011 | Drafted |
| [EPIC-034](EPIC-034-domains-dns/SPEC.md) | Domains & DNS | Tenant Ops | medium | EPIC-002, EPIC-006, EPIC-029 | Drafted |
| [EPIC-035](EPIC-035-backup-restore/SPEC.md) | Backup & Restore | Tenant Ops | low | EPIC-001, EPIC-002 | Drafted |
| [EPIC-036](EPIC-036-compliance-test-packs/SPEC.md) | Compliance Test Packs | Tenant Ops | medium | EPIC-003, EPIC-007, EPIC-029 | Drafted |
| [EPIC-037](EPIC-037-settings-branding/SPEC.md) | Settings & Branding | Platform Admin | medium | EPIC-001 | Drafted |
| [EPIC-038](EPIC-038-rbac-api-clients/SPEC.md) | RBAC & API Clients | Platform Admin | critical | EPIC-001, EPIC-002 | Drafted |
| [EPIC-039](EPIC-039-template-library/SPEC.md) | Template Library & Catalog | Platform Admin | medium | EPIC-015, EPIC-016, EPIC-008 | Drafted |
| [EPIC-040](EPIC-040-graph-explorer-tools/SPEC.md) | Graph Explorer & Admin Tools | Platform Admin | medium | EPIC-002 | Drafted |
| [EPIC-041](EPIC-041-integrations-copilot/SPEC.md) | Integrations, Copilot & Shadow AI | Platform Admin | low | EPIC-038 | Drafted (PARKED) |

## Conventions

> **Tickets:** all 41 epics now have child tickets authored in `ISSUES/` (T-0001–T-0820, 398
> children). `bash fleet/sync-epics.sh` keeps `ISSUES/epics/` in step. The `Status` column
> above is the SPEC's status, not ticket progress — dispatch state lives in `TICKETS.md`.

See [`../README.md`](../README.md) for the SPEC template, ID scheme, and directory contract.
Fleet ticket format: [`../99-reference/fleet-conventions.md`](../99-reference/fleet-conventions.md).
