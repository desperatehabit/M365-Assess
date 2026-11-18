# Master Plan — M365-Assess portal to compliance console

_Written 2026-11-16. Update the checkboxes as work lands; do not reorder phases without
recording why._

## The finish line

A single console where, for each client, an operator can see compliance posture by framework
(CMMC, NIST, CIS, HIPAA, PCI DSS, STIG) across four surfaces:

1. **Microsoft 365** — assessed and managed by the existing portal and module.
2. **Workstations and servers** — CIS baselines deployed through Intune; state read from Intune
   and from the client's RMM (NinjaOne or ConnectWise Automate).
3. **Network** — switches, access points, routers, and firewalls, read from Auvik or the
   NinjaOne network collector.
4. **Documentation** — the client's policies, System Security Plan, and POA&M.

Evidence is collected automatically, and remediation is automated where a safe path exists.

Sources are chosen **per client**: one client may be NinjaOne for endpoints and network; another
may be Automate for endpoints and Auvik for network.

## How to read this plan

- Phases run in order. Within a phase, items run top to bottom unless marked _parallel_.
- Ticket scope and acceptance live in `ISSUES/T-NNNN.md`. Epic scope lives in
  `docs/portal-specs/01-feature-epics/EPIC-NNN-*/SPEC.md`.
- EPIC-042 to EPIC-048 are **Drafted, not Approved**, and have no child tickets yet. New
  tickets start at T-0905.
- `fixed-unverified` means code is merged but nobody has confirmed it against a live tenant.

---

## Phase 0 — Housekeeping

Small, and it stops the tracking problems that hid T-0852.

- [x] Commit the 2026-11-16 planning changes (T-0852 reopen, EPIC-042 to EPIC-048, this file).
      _On `main` in 217abe00._
- [x] Retire the `fleet/` ticket tool. _Removed 2026-11-16. A final `fleet.py index` run
      regenerated `TICKETS.md` (10 open, 29 fixed-unverified, 7 epic; matched the hand edits)
      and found T-0852's malformed front-matter delimiter, which had hidden it. `TICKETS.md`
      is now maintained by hand._
- [x] Settle epic status. _Done 2026-11-16: an epic is `closed` only when every child is
      closed. 32 of the 41 "closed" epics had open or `fixed-unverified` children and are back
      to `epic`, each with a "Reopened" section listing what is outstanding. 9 remain closed
      (EPIC-001, 003, 006, 012, 013, 017, 018, 030, 041)._
- [x] Reconcile `epic.md` originals with their `ISSUES/epics/` copies. _Done 2026-11-16:
      `ISSUES/epics/` is the only copy (it held every status change and resolution note);
      the 48 `epic.md` drafts were deleted and each SPEC links to its epic ticket._
- [x] Fix the local Pester setup (Pester 6.2.0 breaks tests written for Pester 5; a stray 3.4.0
      shadows `BeforeAll`) so the full suite can run before Phase 2. _Done 2026-11-16 (PR #15):
      `Assert-MockCalled` ported to `Should -Invoke`; the full suite passes locally on Pester
      6.2.0 (5585 passed, 0 failed, 13 skipped) and in CI. The fix also turned up three real
      bugs: the Graph Explorer worker was shadowed by a Microsoft.Graph alias (affects T-0870),
      the DomainAction unknown-action error was malformed, and 35 files were missing from the
      module manifest FileList._
- [x] Turn on CI for the fork. _Enabled 2026-11-16. Required jobs are green on PR #15._

**Exit:** met once PRs #14 and #15 are merged.

## Phase 1 — Finish the M365 portal

Ten open tickets. Order is by what blocks later phases, then severity.

- [x] **T-0852** (high) — Mount EPIC-022 Spam, Quarantine and Allow/Block routes; write the
      three missing read workers. Five UI screens have no backend until this lands.
      _Implemented (`fixed-unverified` awaiting Phase 2 live test): added `get-quarantine.ps1`, `get-allow-block.ps1`, `get-quarantine-policies.ps1` (+ `Get-*.ps1` & Pester tests), `spam-quarantine.ts` adapter, DB exports, explicit `/submit` route, filter-template audit source fix, and mounted all 6 route groups._
- [x] **T-0875** — Assemble the report bundle; the executive report renders empty sections.
      Blocks SSP and POA&M documents in Phase 9.
      _Implemented (`fixed-unverified`): added ZIP bundle assembly (`domain/reports/bundle.ts`), wired `secureScore` & `actionBuckets`, removed `createUnavailableTemplateRender` stub, and wired Download Bundle UI._
- [x] **T-0878** — Add the drift deviation remediate endpoint. Core to automated remediation.
      _Implemented (`fixed-unverified`): added `POST /v1/drift/deviations/:deviationId/remediate`, `queueRemediation` adapter, `remediateDeviation` client, and UI Remediate controls._
- [x] **T-0874** — Scheduled credential-expiry check.
      _Implemented (`fixed-unverified`): added `credential-expiry` timer (`Invoke-CredentialExpiryScan`, cron `0 0 4 * * *`), expiry state scan & EPIC-029 alert emission._
- [x] **T-0877** — Standards catalog tenant licence classification (returns 501 today).
      _Implemented (`fixed-unverified`): added `loadLicensingOverlaySync` & `createTenantLicenseResolver` in `adapters/standards.ts` replacing `unavailableTenantLicenses`._
- [x] **T-0853** — Mount EPIC-023 Contacts and Resources routes. Three UI screens have no backend.
      _Implemented (`fixed-unverified`): added `adapters/contacts-resources.ts` and mounted all 7 EPIC-023 route groups (including fixing async `readBody` mismatch on contact templates)._
- [x] **T-0865** — Mount EPIC-035 Backup routes; invoke retention and replication. Two UI
      screens have no backend.
      _Implemented (`fixed-unverified`): added `adapters/backups.ts`, mounted backup/settings/restore routes (`CIPP.Admin.BackupRestore`), and wired `BACKUP_MAINTENANCE_TIMER` pruning & replication._
- [x] **T-0896** — SharePoint Templates page and in-portal site property editing.
      _Implemented (`fixed-unverified`): added `routes/sharepoint-templates.ts`, `/sharepoint/templates` UI & nav link, and `PATCH /v1/tenants/:tenantId/sharepoint/sites/:siteId` worker & edit form._
- [x] **T-0900** — Groups: Convert endpoint; make GAL and delivery options real.
      _Implemented (`fixed-unverified`): added `POST /v1/tenants/:tenantId/groups/:groupId/convert`, wired GAL/delivery create & list fields, and fixed empty description clearing._
- [x] **T-0892** — System-wide demo dataset and explicit demo mode. Last, since it is for
      sales and training, not function.
      _Implemented (`fixed-unverified`): added explicit `?demo=1` / toggle fetch interceptor, `DemoProvider` / `DemoBanner`, and full-surface `demo-dataset.ts` using reserved `*.example` / `*.invalid` domains._

Loose ends with no ticket yet. Triage each: file a ticket, or record that it is accepted.

- [x] EPIC-032 notification receiver (`POST /v1/webhooks/notify`) is deliberately unmounted
      because the subscription `clientState` is not stored.
      _Triaged: filed [T-0905](ISSUES/T-0905.md) (`open`, parent `EPIC-032`) to persist webhook `clientState` and mount `POST /v1/webhooks/notify`._
- [x] Endpoints that can answer 501: MFA reset, Temporary Access Pass, user create and patch,
      some mailbox tag writes, the domain-check tool. Establish when each fires.
      _Established (`portal/bff/src`): MFA reset & TAP (`mfa.ts:431,509,713,867,931`), user create/actions/patch (`users.ts:575,786,951,1045`), and `domain-check` (`tools/geoip-routes.ts:127`) only fire 501 in unit harnesses when optional providers are omitted — all are wired in `app.ts` (`mfa`, `users`, `domainCheck`). Mailbox retention-tag definition CRUD and the mail-flow report (`adapters/mailboxes.ts:784,884,894,902`), cross-tenant `POST /v1/intune/compare` (`routes/intune-compare.ts:88`), `app-protection` Intune policies (`intune-policies.ts`), deferred Intune app types (`office`/`edge`/`msp`/`choco`), deferred Defender areas (`defender-status.ts`), `psa`/`slack` notification channels (`notifications.ts`), and built-in script deletes (`scripts.ts:397`) return 501 intentionally by v1 design._
- [x] "Submit for review" on the Quarantine page is a disabled button.
      _Fixed: enabled `"Submit for review"` in `portal/web/src/app/email/quarantine/page.tsx` wired to `POST /v1/tenants/:tenantId/quarantine/:messageId/submit` (and registered the static `/submit` route in `quarantine.ts`), covered by `quarantine.test.tsx`._
- [x] Breach lookup is fail-closed until a provider is registered.
      _Accepted (tracked under EPIC-040 / EPIC-041): `POST /v1/breach-lookup` intentionally returns 409 `breach.integration_not_configured` (verified by `app-epic040-mounts.test.ts:186`) until an HIBP provider is configured._
- [x] T-0870 (Graph Explorer, `fixed-unverified`): before PR #15, the worker could never run
      once Microsoft.Graph.Authentication was loaded, because that module's
      `Invoke-GraphRequest` alias shadowed it. The worker is now named `Invoke-PortalGraphRequest`.
      Verify T-0870 in Phase 2 against the renamed worker.
      _Accepted for Phase 2: already listed under Security/admin tools (`fixed-unverified`); will be verified live against `Invoke-PortalGraphRequest` in Phase 2._
- [x] Test hygiene: about 118 test files still leave global stub functions behind, which can
      break later tests depending on run order. Add `AfterAll` cleanup using
      `Remove-Item 'Function:\Name'`; the `function:global:Name` form is silently a no-op.
      _Triaged: filed [T-0906](ISSUES/T-0906.md) (`open`) to add `AfterAll` `Function:\` cleanup across `tests/`._
- [x] Pre-existing lint findings: an `$Error` parameter and the `Verify-Domain` verb in
      `Invoke-DomainAction.ps1`, plus `ps` aliases in the Linux-only tests.
      _Triaged: filed [T-0907](ISSUES/T-0907.md) (`open`, parent `EPIC-034`) to fix `Invoke-DomainAction.ps1` alongside `Invoke-DomainAction.Tests.ps1` and Linux test aliases._
- [x] CI: the advisory macOS smoke job never gets a runner and is always cancelled. Drop it,
      or check the account's runner limits.
      _Triaged: filed [T-0908](ISSUES/T-0908.md) (`open`) to gate or adjust `.github/workflows/ci.yml:362`._

**Exit:** all 10 Phase 1 tickets moved to `fixed-unverified` (awaiting Phase 2 live-tenant verification) and all 8 loose ends resolved or triaged (`T-0905`–`T-0908`); every UI route in the nav has a mounted backend.

## Phase 2 — Verify against a live tenant

The largest hidden risk. Releases already require a human live-tenant run
(`.claude/rules/releases.md`); apply the same standard to the portal.

Runbook: [`docs/plans/2026-11-17-phase-2-live-verification.md`](docs/plans/2026-11-17-phase-2-live-verification.md).

- [ ] Gate: PRs #14 and #15 merged, and the Phase 1 work committed and through CI. _On
      2026-11-17 neither had happened: both PRs were open, and Phase 1 was uncommitted. Phase 1
      is now on `feat/portal-phase1-completion`._
- [x] Pre-flight without a tenant. _Done 2026-11-17: all 120 nav routes render, and every web
      `/v1` call was probed against a running BFF. The Phase 1 exit claim that every nav route
      has a backend did not hold. Filed T-0909 (restore preview), T-0910 (tenant detail tabs),
      T-0911 (GDAP relationships) and T-0912 (parked EPIC-041 pages in nav). T-0899 passes
      locally: operator gets 403 on API-client writes. CI never builds or tests the portal
      (T-0913); the production `next build` was broken by about 80 pages missing a Suspense
      boundary, fixed in the Phase 1 PR._
- [ ] Stand up the portal against a real test tenant with a working credential.
- [ ] Walk every nav section once and record failures as tickets.
- [ ] Verify and close the 29 `fixed-unverified` tickets:
  - [ ] Security and auth: T-0899 (API client authorization), T-0876, T-0902, T-0903, T-0904
        (schedules and system timers)
  - [ ] Incidents and alerting: T-0858, T-0859
  - [ ] Defender and devices: T-0849, T-0885
  - [ ] Email: T-0851, T-0854, T-0894, T-0901
  - [ ] Collaboration: T-0856, T-0857
  - [ ] Tenant operations: T-0861, T-0862, T-0863, T-0864
  - [ ] Standards and compliance: T-0866, T-0879
  - [ ] Identity: T-0880, T-0881, T-0884
  - [ ] Platform: T-0867, T-0869, T-0870, T-0887, T-0891
- [ ] Verify the Phase 1 tickets the same way.
- [ ] Run one remediation end to end (plan, apply, verify, rollback) on the test tenant.

**Exit:** zero `fixed-unverified`; the M365 portal is usable for a real client.

## Phase 3 — Approve the compliance-console design

No code. This phase can overlap Phases 1 and 2.

- [ ] Review and approve **EPIC-042** first. Its data model (control, finding, source) is what
      every later phase writes into.
- [ ] Review and approve EPIC-043 to EPIC-047. Leave EPIC-048 parked.
- [ ] Answer the open questions that shape the model:
  - [ ] CMMC assessment objectives: control level, or objective level (800-171A)?
  - [ ] Inherited controls: a distinct `inherited` state?
  - [ ] Evidence retention period (proposed: 6 years).
  - [ ] Intune policy state versus on-device assessment: which will the assessor accept?
  - [ ] Policy template source: existing set, or write one? (Start this early; see Phase 9.)
  - [ ] Policy approval: recorded by the operator, or signed by the client in the portal?
- [ ] Agree the shared `Device` and `DeviceSourceLink` model used by Phases 6, 7, and 8.
- [ ] Author child tickets for EPIC-042 (from T-0909) once it is approved.

**Exit:** EPIC-042 approved with tickets; the others approved or explicitly deferred.

## Phase 4 — Compliance foundation (EPIC-042)

- [ ] Control and finding schema with a `source` discriminator; roll-up rule with tests that
      include non-M365 findings.
- [ ] Feed existing M365 findings into the model.
- [ ] Framework enrolment per client.
- [ ] Framework page and control detail.
- [ ] Applicability (not applicable, with justification) and manual attestation with expiry.
- [ ] Coverage view: controls with no source.
- [ ] Fleet compliance view across clients.

**Exit:** a client enrolled in CMMC L2 shows every control with a derived status from M365
data, and the gaps are visible.

## Phase 5 — Evidence locker (EPIC-043)

- [ ] Immutable, hashed artifact store linked to controls.
- [ ] Automatic capture from assessment runs.
- [ ] Before and after capture from remediations.
- [ ] Manual upload.
- [ ] Scheduled collection and freshness tracking.
- [ ] Auditor export package.

**Exit:** an assessment run leaves evidence against controls with no operator action, and a
package can be handed to an assessor.

## Phase 6 — Workstation CIS baselines via Intune (EPIC-044)

Can start once Phase 4's schema has landed; _parallel_ with Phase 5.

- [ ] Confirm the CIS Build Kit format from SecureSuite; build the importer. No CIS content is
      committed to this public repository.
- [ ] Shared `Device` model migration (if Phase 7 has not already landed it).
- [ ] Staged deployment (pilot ring, then wider) through the remediation engine, with rollback.
- [ ] Per-device, per-setting readback from Intune into control findings.
- [ ] Map benchmark recommendations to `WIN-*` checks; widen `sync-scope.json` only when an
      endpoint source is enabled.
- [ ] Exceptions with reason and expiry.
- [ ] Drift detection and alerting.
- [ ] STIG importer on the same model (second, after CIS).

**Exit:** a CIS Windows 11 baseline is deployed to a pilot group at a real client and its
results change control status.

## Phase 7 — RMM integrations (EPIC-045)

- [ ] Gather access: NinjaOne region and API credentials; Automate version, hosting, and API
      credentials. A non-production instance for each if available.
- [ ] RMM adapter interface and per-client source assignment (which connection supplies
      endpoint data, which supplies network data).
- [ ] **NinjaOne adapter, read-only:** connect, test, map organisations to tenants, sync
      workstations, servers, and network devices.
- [ ] Unified device list and posture facts (patch, encryption, AV, software) as findings.
- [ ] **ConnectWise Automate adapter, read-only:** workstation and server data only.
- [ ] Device reconciliation across Intune, Entra, and the client's assigned RMM.
- [ ] **Script dispatch**, after read-only sync is proven: allow-list, separate permission,
      off by default, audited, output captured as evidence. Security review before enabling
      at any client.

**Exit:** for one NinjaOne client and one Automate client, endpoint state feeds control status
and an approved script can be run on a test device.

## Phase 8 — Network posture (EPIC-047)

- [ ] Network source adapter interface.
- [ ] NinjaOne network collector data (rides on the Phase 7 adapter).
- [ ] **Auvik adapter:** connect, map sites to tenants, sync switches, access points, routers,
      and firewalls.
- [ ] Cross-source device matching: one device, both badges, conflicting facts shown.
- [ ] Firmware and end-of-support posture as findings.
- [ ] External exposure check, limited to operator-confirmed addresses.
- [ ] Manual devices with attestation; boundary record and network diagram.

**Exit:** a NinjaOne-network client and an Auvik client both show network devices feeding
control status.

## Phase 9 — Policies, SSP, and POA&M (EPIC-046)

The template **content** is the long pole and needs no code. Start writing or sourcing it
during Phase 3. The 20-document set is listed in the EPIC-046 SPEC §11.

- [ ] Policy template library (content): 20 documents, original or redistributable.
- [ ] Policy documents per client: variables, versions, approval, publish, review cycle.
- [ ] Policy-to-control mapping; a published policy satisfies its documentation controls.
- [ ] SSP generation from live control status (needs T-0875 from Phase 1).
- [ ] POA&M: items opened from failing controls, closure proposed when they pass.
- [ ] Document export for policies, SSP, and POA&M.

**Exit:** a client's documentation controls are no longer `not-assessed`, and an SSP and POA&M
can be produced on demand.

## Phase 10 — Agent decision (EPIC-048)

- [ ] With Phases 6 to 8 live, read the reconciliation and coverage views: which devices and
      which checks does nothing reach?
- [ ] Decide: build the agent, or close the epic. Record the decision as an ADR.
- [ ] If building: settle hosting, endpoint privilege, runtime, and code signing before any
      ticket is authored; independent security review before any client deployment.

## Phase 11 — Production readiness

- [ ] Security review of the whole portal, with attention to RMM script dispatch, credential
      storage, tenant isolation, and evidence containing client data.
- [ ] Hosting and deployment model, backup and restore of the portal's own data.
- [ ] Decide whether the portal remains in this public repository.
- [ ] Operator documentation and client onboarding runbook.
- [ ] Full dry run with one real client: enrol, assess, collect evidence, remediate, produce
      the assessor package.

**Exit:** the finish line above, demonstrated on one client end to end.

---

## Dependency summary

```
Phase 0 ─► Phase 1 ─► Phase 2 ───────────────────────────────┐
              │                                              │
Phase 3 (design, overlaps 1-2) ─► Phase 4 ─┬─► Phase 5 ──────┤
                                           ├─► Phase 6 ──┐   │
                                           └─► Phase 7 ──┼─► Phase 8
                                                         │      │
              T-0875 (Phase 1) + Phases 4, 5 ─► Phase 9  │      │
                                                         ▼      ▼
                                               Phase 10 ─► Phase 11
```

## Decisions already made

| Date | Decision |
|---|---|
| 2026-11-16 | Frameworks: CMMC, NIST (800-171, 800-53, CSF), CIS, HIPAA, PCI DSS, STIG |
| 2026-11-16 | CIS SecureSuite is held; Build Kits are the Intune importer's first input |
| 2026-11-16 | RMM targets: NinjaOne (first) and ConnectWise Automate |
| 2026-11-16 | Automate supplies workstation and server data only; its network collector is not used |
| 2026-11-16 | Network sources: Auvik and the NinjaOne network collector, both supported |
| 2026-11-16 | Sources are assigned per client |
| 2026-11-16 | RMM script dispatch is wanted, after read-only sync |
| 2026-11-16 | The agent is last, and built only if coverage data shows a need |
