# Handoff — M365-Assess portal

_Last updated: 2026-11-07, after commits `0f1715b8` and `b5263aec`._

## State

- Branch: `main`, working tree clean.
- `0f1715b8` — mounted EPIC-019 Defender and EPIC-021 Transport routes (T-0849, T-0851).
- `b5263aec` — restored a green BFF test suite (no ticket; fixes stale tests and two
  real adapter bugs found while greening it).
- Tickets **T-0849** and **T-0851** are `fixed-unverified`; `TICKETS.md` reflects the
  new counts (open 20, fixed-unverified 18).
- Full portal test suites are green:
  - BFF: `353 files / 4104 tests`
  - Web: `152 files / 1316 tests`
  - DB: `44 files / 302 tests`
  - `npm run typecheck` at `portal/` is clean.

## Verification commands

```powershell
cd portal
npm run typecheck
npm test --workspace @m365-assess/db
npm test --workspace @m365-assess/bff
npm test --workspace @m365-assess/web
```

## Next issues up to bat

Register order (severity, then id) after T-0851:

| Ticket | Sev | Title |
|---|---|---|
| T-0854 | medium | Mount and deliver EPIC-024 Email Tools routes and Message Viewer |
| T-0856 | medium | Mount and deliver EPIC-026 Teams & Voice routes and UI |
| T-0857 | medium | Mount and wire EPIC-027 Sharing & Permissions routes |
| T-0861 | medium | Mount and deliver EPIC-031 Secure Score routes |
| T-0862 | medium | Mount and deliver EPIC-032 Audit Logs & Webhooks routes |
| T-0863 | medium | Mount and deliver EPIC-033 Licensing routes and workers |
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

**Recommended next batch:** T-0854, T-0856, T-0857 (same “mount and deliver”
pattern, contiguous in the register). T-0874/T-0877/T-0878 are small targeted
fixes and good fill-ins between larger mounts.

Each ticket file under `ISSUES/` has the authoritative scope, SPEC link, and
acceptance criteria.

## Recipe for a “mount and deliver” ticket

1. Read the ticket and its `SPEC.md` §6. Confirm which route factories already
   exist under `portal/bff/src/routes/` and which are only in tests.
2. Add the worker-backed adapter under `portal/bff/src/adapters/` using
   `createTenantWorker` / `createEnvelopeWorker` from `adapters/workers.ts`.
   Check the worker’s `Read-*Job` function for exact job field names.
3. If a store is in-memory only, add a SQLite repository over the existing
   migration. Keep it in `portal/bff/src/repository/` when it implements a
   BFF-owned interface (see `defender-deployment-templates.ts`), or export a
   `@m365-assess/db` repository from `portal/db/src/index.ts` when it already
   lives there (see `transport-template-repository.ts`). After editing db
   sources run `npm run build` in `portal/db` — `dist/` is gitignored but BFF
   typecheck/tests resolve it.
4. Mount in `portal/bff/src/app.ts`: pass `resolveCaller`, the shared
   authorizer, tenant-scope guards, the audit sink, and any template store.
   Keep static paths before `:param` paths.
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
   give 200/201; assert “not a router 404”).
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
- SQLite migrations are forward-only. Add a new numbered migration; never edit
  an applied one.
- `portal/contracts/openapi/portal.v1.yaml` drift is enforced by
  `src/routes/openapi.test.ts`.
