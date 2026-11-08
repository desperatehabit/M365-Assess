# Handoff — M365-Assess portal

_Last updated: 2026-11-08, after the EPIC-031/032/033 mount batch._

## State

- Branch: `main`.
- T-0861 mounted EPIC-031 Secure Score: the current/peers/trend/fleet routes run
  `get-secure-score.ps1`, improvement actions resolve through the registry mapping
  (and persist as `ScoreActionMapping` rows), and a daily `secure-score-snapshot`
  maintenance timer records one trend point per tenant and prunes retention.
- T-0862 mounted EPIC-032 Audit Logs & Webhooks: search/directory/coverage run
  `search-audit.ps1` / `get-audit-coverage.ps1`; saved searches and exclusion
  windows persist through the audit repository; webhooks run `manage-webhooks.ps1`
  with the configured notification URL; migration 0129 adds webhook soft delete and
  the repository gains update/soft-delete. The Saved Log Searches page now exists
  under `web/src/app/audit-logs/searches/`.
- T-0863 mounted EPIC-033 Licensing: consumption/optimization/gates/per-user changes
  run their Graph workers; pricing and `LicenseChange` rows persist through
  `SqliteLicensingRepository`. The missing `get-license-optimization.ps1` and
  `get-license-gates.ps1` entrypoints now exist with Pester tests.
- Tickets **T-0861**, **T-0862**, and **T-0863** are `fixed-unverified`;
  `TICKETS.md` reflects the new counts (open 14, fixed-unverified 24).
- Full portal test suites are green:
  - BFF: `365 files / 4202 tests`
  - Web: `154 files / 1324 tests`
  - DB: `44 files / 303 tests`
  - `npm run typecheck` at `portal/` is clean.
- The EPIC-032 notification receiver (`POST /v1/webhooks/notify`) is deliberately
  **not mounted**: the repository does not yet store the subscription
  `clientState` it validates, and content-bundle handling is deferred by SPEC §11.2.


## Verification commands

```powershell
cd portal
npm run typecheck
npm test --workspace @m365-assess/db
npm test --workspace @m365-assess/bff
npm test --workspace @m365-assess/web
```

## Next issues up to bat

Register order (severity, then id) after T-0863:

| Ticket | Sev | Title |
|---|---|---|
| T-0864 | medium | Mount and deliver EPIC-034 Domains & DNS routes and worker |
| T-0866 | medium | Mount EPIC-036 Compliance Test Packs and Custom Tests routes |
| T-0867 | medium | Mount EPIC-037 Settings, Branding & Preferences routes |
| T-0869 | medium | Mount EPIC-039 Template Library & Catalog routes |
| T-0870 | medium | Mount EPIC-040 Graph Explorer & Admin Tools routes |
| T-0874 | medium | No scheduled credential-expiry check |
| T-0875 | medium | Report bundle is not assembled; executive report renders empty sections |
| T-0877 | medium | Standards catalog tenant license classification returns 501 |
| T-0878 | medium | Drift deviation remediate endpoint is missing |
| T-0892 | medium | Add a system-wide demo dataset and explicit demo mode |
| T-0896 | medium | SharePoint Templates page and in-portal site property editing have no backend |
| T-0900 | medium | Groups: Convert has no endpoint; GAL/delivery options are decorative |
| T-0853 | low | Mount EPIC-023 Contacts & Resources routes |
| T-0865 | low | Mount EPIC-035 Backup routes and invoke retention/replication |

**Recommended next batch:** T-0864, T-0866, T-0867 (same “mount and deliver”
pattern, contiguous in the register). T-0874/T-0877/T-0878 are small targeted
fixes and good fill-ins between larger mounts.

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

- `fleet/fleet.py index` is **not usable on this machine**: `fleet/config.toml`
  points at `/home/wcoulter/Projects/M365-Assess`. Running it writes a stray
  `C:\home\...` register. Either fix the config paths first or update the
  affected `TICKETS.md` rows/counts by hand.
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
