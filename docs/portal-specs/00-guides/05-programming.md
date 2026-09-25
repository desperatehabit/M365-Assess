# 05 — Programming Guidelines

- **Status:** Drafted
- **Audience:** Every code ticket (module PowerShell, service layer, frontend).
- **Related:** [`01-architecture.md`](01-architecture.md), [`02-ui-design.md`](02-ui-design.md)
- **Existing module rules:** `.claude/rules/powershell.md`, `.claude/rules/pester.md`

## 1. Language boundaries

| Layer | Language | Lives in |
|---|---|---|
| Domain (collectors, remediation, exporters) | PowerShell 7 | `src/M365-Assess/` (existing) |
| Envelopes, OpenAPI, shared types | TypeScript | `portal/contracts/` |
| Service/API (thin BFF) | TypeScript — [ADR-0014](../../adr/0014-thin-bff-over-powershell-workers.md) | `portal/bff/` |
| Frontend | TypeScript + React (Next.js) | `portal/web/` |
| Domain workers | PowerShell 7 | `portal/workers/` |
| Storage (repository + migrations) | TypeScript | `portal/db/` |
| Tooling (fleet) | Python 3.11+ stdlib only | copied from DAXX, separate |

The portal layout is fixed by
[`../01-feature-epics/EPIC-001-platform-foundation/SPEC.md`](../01-feature-epics/EPIC-001-platform-foundation/SPEC.md)
§1. A second backend language is admissible here only because ADR-0014 chose a TypeScript BFF;
no further runtime may be added without its own ADR.

## 2. PowerShell conventions (module & service)

Follow `.claude/rules/powershell.md`. Non-negotiables carried into the portal:

- Approved verbs (`Get-`, `Set-`, `New-`, `Invoke-`, `Export-`, `Test-`); no aliases.
- `[CmdletBinding()]` on advanced functions; parameter sets for mutually exclusive modes.
- No `Write-Host` in library code; use the structured logging path.
- No `Invoke-Expression` / `iex` — anywhere. (The repo currently has none; keep it that way.)
- `pwsh` (7.x) only; never `powershell.exe`.
- No comments unless they explain *why* (repo rule).
- No PII in code, tests, or fixtures — placeholders only.

### 2.1 Collector contract is frozen

Collectors keep the `SecurityConfigHelper` contract (`Initialize-SecurityConfig`,
`Add-Setting`, `Export-SecurityConfigReport`) and the nine-status taxonomy. The portal does
not change collector output shape; it consumes it.

### 2.2 Read-only vs write code is separated by folder

`scripts/Test-CollectorReadOnly.ps1` AST-scans collector folders for mutating verbs and
blocks `Invoke-MgGraphRequest -Method POST|PATCH|PUT|DELETE`. Remediation code must live in
a **new folder** with its own guardrail policy — never by adding exceptions to the collector
scan. See [`06-remediation.md`](06-remediation.md) §2.

## 3. API conventions

- **Contract-first.** Endpoints are described in OpenAPI 3.1; the spec is generated from or
  checked against the implementation in CI.
- **REST-ish, verb-free resource paths** for reads; explicit action endpoints for operations
  (`POST /tenants/{id}/runs`, `POST /remediation/plans/{id}/apply`).
- **Every response is tenant-scoped** by the caller's RBAC scope; never trust a client-sent
  tenant list without intersecting it.
- **Errors** are structured: `{ code, message, details, correlationId }` with stable `code`
  values; no stack traces to clients.
- **Pagination** is cursor-based (`?cursor=&limit=`), default limit 100, hard max 1000.
- **Idempotency** for mutating calls via an `Idempotency-Key` header where retries are
  expected (remediation apply, job enqueue).
- **Versioning** in the path (`/v1/...`); breaking changes require a new version.
- **Rate limiting** per API client (CIPP uses 100 req/10s — adopt a similar model).

## 4. Frontend conventions

- **TypeScript strict**; no `any` without a justification comment.
- **No new color literals** — consume the token contract from
  [`02-ui-design.md`](02-ui-design.md) §3. Lint rule to be added (EPIC-037).
- **Server state** via a query library (TanStack Query, as CIPP uses); local UI state via
  hooks. No bespoke global store for server data.
- **Forms** use one `FormField` wrapper so labels/validation/accessibility are consistent.
- **Components** are colocated with their tests; charts are hand-rolled SVG unless an ADR
  approves a library.
- **Accessibility** is a merge gate: keyboard reachable, Escape closes, focus-visible,
  `prefers-reduced-motion` honored.
- **No direct tenant calls** from the browser — the UI only talks to our API.

## 5. Testing

| Layer | Framework | Gate |
|---|---|---|
| Module PowerShell | Pester | existing 65% coverage threshold, 166 suites |
| Service PowerShell | Pester | new suites; coverage threshold TBD |
| Frontend | Vitest + Testing Library | new; required per component |
| End-to-end | Playwright (later) | key flows only |

- Collector tests filter by `$_.Setting`, not `$_.CheckId` (sub-numbering — see
  `.claude/rules/pester.md`).
- Every fix ships a regression test that fails without it (fleet acceptance default).
- The fleet QA is **baseline-relative**: `fleet.py baseline` must be run before dispatch.

## 6. Linting & CI

- PowerShell: PSScriptAnalyzer with `PSScriptAnalyzerSettings.psd1`, `-Severity Warning`.
- Frontend: ESLint + Prettier + `tsc --noEmit`.
- CI jobs mirror the existing `.github/workflows/ci.yml` gates plus new frontend/service
  jobs. A red gate blocks merge.
- Docs changes run the existing `docs-gates` job.

## 7. Naming

- Functions/classes: `PascalCase`; files match the primary function/component.
- API paths: plural nouns, kebab-case (`/tenant-groups`).
- DB columns: snake_case; JSON fields: camelCase.
- Feature flags, permission strings, and check IDs are stable identifiers — rename requires
  a migration.

## 8. Secrets & safety

- Never commit secrets; the fleet tool's absolute rule (no `.env`) carries over.
- Never log secrets or full tokens; redact in errors.
- Any code path that serializes credentials to disk (see the PowerBI temp-script issue,
  `Invoke-M365Assessment.ps1:1062-1064`) is a defect — file it.
- Remediation code obeys [`06-remediation.md`](06-remediation.md) without exception.

## 9. Commit & PR conventions

- Commit subject `fix(<ID>): <title>` on fleet branches; human commits follow repo style.
- No "claude" in branch names, PR titles/bodies, or commit messages (repo rule).
- PRs are required for `main`; no force-push.
- Never bump the module version without owner approval.

## See also

- `.claude/rules/powershell.md`, `.claude/rules/pester.md`
- [`06-remediation.md`](06-remediation.md)
- [`../99-reference/fleet-conventions.md`](../99-reference/fleet-conventions.md)
