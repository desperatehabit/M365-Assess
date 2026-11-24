# Handoff — M365-Assess portal

_Last updated: 2026-11-20, after the Phase 2 ticket batch._

## State

- Branch: `fix/phase2-ticket-batch`, based on `main`.
- 119 active tickets: 69 `fixed-unverified`, 2 `open` (T-0917, T-0941),
  39 epics, 9 closed epics. T-0899, T-0906, T-0907, T-0908 and T-0913 were
  verified from CI/local checks and closed on 2026-11-22. T-0942 adds the
  per-tenant Access tab for write-access management; the remaining
  `fixed-unverified` tickets need the Phase 2 live walk.
- Batch highlights:
  - **Run validity:** EXO/Purview `-Organization` resolves to the initial domain;
    run options reach the worker and are validated; `partial` runs and
    `_Assessment-Issues` are served; Info is in every summary roll-up; duplicate
    single-tenant runs are collapsed; the Runs list shows tenant names.
  - **Collectors:** SharePoint/Forms read the documented and legacy property names
    and return Review when a property is unverifiable; Power BI uses the Fabric admin
    endpoint and a real sentinel id; licence gating records `NotLicensed`; collectors
    report `Complete | Partial | Skipped | Failed`; XLSX uses one strict pass rate;
    the Entra/CA spot-check items are fixed.
  - **Portal:** collapsible nav with per-item descriptions; styled report builder
    with data-bound blocks and built-in templates; run-screen remediation drawer,
    bulk apply and remediation tab; run templates and locked built-in templates;
    webhook `clientState` storage plus `POST /v1/webhooks/notify`.
  - **Onboarding:** module preflight before the wizard starts; `Agreement.Read.All`
    in the read set; device-code sign-in for a headless BFF; opt-in
    `M365-Assess-Operator` app with purpose-aware credentials. Remaining write
    adapters are T-0940; live runbook verification is T-0941.
- Verification (2026-11-20):
  - `npm run typecheck` at `portal/`: clean.
  - BFF: `385 files / 4501 tests` passed.
  - Web: `163 files / 1567 tests` passed.
  - DB: `46 files / 310 tests` passed.
  - Pester: 5811 passed, 2 failed (pre-existing Windows `chmod` limitation in
    `Invoke-ReportRender`), 14 skipped.
- T-0917 stays `open` until T-0941 verifies the runbook W rows on a live tenant.
  Every other ticket in the batch is `fixed-unverified`.

## Verification commands

```powershell
cd portal
npm run typecheck
npm test --workspace @m365-assess/db
npm test --workspace @m365-assess/bff
npm test --workspace @m365-assess/web
```

## Next issues up to bat

- **T-0941** - run the Phase 2 runbook W rows with the operator app; add the
  Security & Compliance and MicrosoftTeams connection paths or document the blockers.
- **T-0917** - close once T-0941 passes.
- Phase 2 live verification of the `fixed-unverified` batch, starting with the
  high-severity run-validity and write-path tickets.

## Compliance-console epics (drafted 2026-11-16)

The ordered checklist for everything that remains is in `MASTER_PLAN.md`.

EPIC-042 to EPIC-048 extend the portal from M365 management to a multi-source
compliance console (frameworks, evidence, Intune CIS baselines, ConnectWise
Automate and NinjaOne, policy documents, network posture, agent). SPECs are
**Drafted, not Approved**, and no child tickets exist yet; new children start at
T-0905. Epic tickets live only in `ISSUES/epics/` (the `epic.md` drafts were
removed 2026-11-16). An epic is `closed` only when every child is closed; 32
epics were reopened on that rule, so most EPIC-001 to EPIC-041 are `epic` until
their `fixed-unverified` children are verified in Phase 2.

Each ticket file under `ISSUES/` has the authoritative scope, SPEC link, and
acceptance criteria.

## Recipe for a “mount and deliver” ticket

1. Read the ticket and its `SPEC.md` §6. Confirm which route factories already
   exist under `portal/bff/src/routes/` and which are only in tests.
2. Add the worker-backed adapter under `portal/bff/src/adapters/` using
   `createTenantWorker` / `createEnvelopeWorker` from `adapters/workers.ts`.
   Check the worker’s `Read-*Job` function for exact job field names: several
   teams/sharing workers read flat top-level fields rather than the T-0007
   `payload`, and some read `action` at the envelope’s top level.
3. If a store is in-memory only, add a SQLite repository over the existing
   migration. Keep it in `portal/bff/src/repository/` when it implements a
   BFF-owned interface (see `defender-deployment-templates.ts`), or export a
   `@m365-assess/db` repository from `portal/db/src/index.ts` when it already
   lives there (see `transport-template-repository.ts`). After editing db
   sources run `npm run build` in `portal/db` — `dist/` is gitignored but BFF
   typecheck/tests resolve it.
4. Mount in `portal/bff/src/app.ts`: pass `resolveCaller`, the shared
   authorizer, tenant-scope guards, the audit sink, and any template store.
   Keep static paths before `:param` paths (`/teams/activity` and `/teams/lis`
   before `/teams/:teamId`).
5. Register every endpoint in `portal/bff/src/rbac/permissions.ts` and add the
   route module’s OpenAPI fragment to `ROUTE_OPENAPI_FRAGMENTS` in
   `portal/bff/src/routes/openapi.ts`. Regenerate the checked-in contract:

   ```powershell
   # temporary file under portal/bff/src, then delete it
   npx vitest run src/__regen-openapi.test.ts
   ```

   The temp test writes `portal/contracts/openapi/portal.v1.yaml` from
   `renderOpenApiYaml()`. The drift test fails if this is stale.
6. Add an adapter unit test and an `app-epic0XX-mounts.test.ts` that probes every
   endpoint through the real app (no credential gives 409; portal-local stores
   give 200/201; a domain 404 is allowed when the route reaches a store, but
   assert “not a router 404”).
7. For missing PowerShell entrypoints, add the wrapper under `portal/workers/`
   plus the implementation under `M365Portal.Workers/`, following the flat-job
   or T-0007-envelope convention of the neighbouring worker. Add a Pester test
   under `tests/Portal/Workers/`.
8. Update the ticket frontmatter (`status: fixed-unverified`, real `scope` and
   `tests` lists), tick acceptance, and add a `## Fix` section. Update the two
   rows and counts in `TICKETS.md`.

## Environment caveats

- The `fleet/` ticket tool was removed on 2026-11-16. `TICKETS.md` is
  maintained by hand: when a ticket's status changes, update its row and the
  counts in the same commit. Ticket format:
  `docs/portal-specs/99-reference/ticket-conventions.md`.
- The BFF guard test bans collector constructs, not finding data. `checkId`,
  `CheckID`, and action tokens such as `set-default` are allowed; do not
  reintroduce `securityconfighelper`, `Initialize-SecurityConfig`,
  `Add-Setting`, or real PowerShell cmdlet calls into `portal/bff/src`.
- Local full-suite Pester is unreliable with the installed **Pester 6.2.0**:
  several tests use the Pester 5 `Assert-MockCalled`, and
  `Get-LicenseReport.Tests.ps1` leaks a `global:Test-Path` mock into later
  files. Run only the worker test you touched:

  ```powershell
  pwsh -NoProfile -Command "Invoke-Pester -Path './tests/Portal/Workers/<Name>.Tests.ps1' -Output Detailed"
  ```

  The local `Pester 3.4.0` install also shadows `BeforeAll` when `#Requires
  -Module Pester` runs; explicit single-file runs avoid it.
- The web suite occasionally flakes on `src/components/settings/Settings.test.tsx`
  when the whole suite runs (a jsdom timing issue, not a code failure); rerun
  the file or the suite before treating it as a regression.
- SQLite migrations are forward-only. Add a new numbered migration; never edit
  an applied one.
- `portal/contracts/openapi/portal.v1.yaml` drift is enforced by
  `src/routes/openapi.test.ts`.
