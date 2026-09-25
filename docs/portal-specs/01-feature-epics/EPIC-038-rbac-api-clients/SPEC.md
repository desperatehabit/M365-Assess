# EPIC-038 — RBAC & API Clients

- **Status:** Drafted
- **Cluster:** Platform Admin
- **Severity:** critical
- **Depends on:** EPIC-001, EPIC-002
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #57-#58; [`cipp-ui-patterns.md`](../../99-reference/cipp-ui-patterns.md) §1 (scoping); [`05-programming.md`](../../00-guides/05-programming.md) §3
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

Decide *who can do what, on which tenants* — the gate every API endpoint and every UI
action passes through. Also expose the portal as an external API (client credentials,
OpenAPI, rate limiting). Referenced by EPIC-002 (tenant scoping) and EPIC-006 (apply is a
separate permission).

### Planned scope

- Role presets + custom roles
- Permission strings + per-endpoint checks
- Tenant/group scoping (`UserScope`)
- IP allow-lists
- API clients + OpenAPI 3.1
- Rate limiting

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an admin, I can assign a portal user one of the base roles. | `T-RB-01` portal users + role assignment |
| US-2 | As an admin, I can create a custom role from a set of permission patterns. | `T-RB-02` custom roles |
| US-3 | As an admin, I can scope a user to specific tenants/groups, not the whole fleet. | `T-RB-03` user scoping |
| US-4 | As an operator, my UI only shows what my role permits. | `T-RB-04` nav/action filtering |
| US-5 | As an integrator, I can register an API client and call the documented endpoints. | `T-RB-05` API clients + auth |
| US-6 | As an admin, I can restrict an API client to an IP range and a rate limit. | `T-RB-06` IP allow-list + rate limit |
| US-7 | As an integrator, I can read the OpenAPI 3.1 spec and generate a client. | `T-RB-07` OpenAPI publication |
| US-8 | As an auditor, I can see every access decision (allow/deny) with actor and tenant. | `T-RB-08` access audit |

## 3. UI design

Nav ([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §2): *CIPP → Advanced →
Authentication* (CIPP Roles, CIPP Users, SSO, SAM App Roles/Permissions), plus
*CIPP → Application Settings → Permissions*, and *Settings → Permissions*.

### 3.1 Portal users (US-1, US-3)

Page title: **Portal Users**. Table: Display name · UPN · Role · Tenant scope summary ·
Status · Last seen. Row actions: `Edit`, `Assign role`, `Edit scope`, `Disable`, `Remove`.
`Add user` opens an `ActionDialog` (UPN, role, scope).

### 3.2 Roles (US-2)

Page title: **Roles**. Base-role rows (readonly/editor/admin/superadmin) are read-only;
custom roles are editable. Columns: Name · Type (base/custom) · Permissions (include/exclude
pattern count) · Users. Row actions: `View`, `Clone`, `Edit` (custom only), `Delete` (custom
only, blocked if in use).

Role editor: two pattern lists (**Include**, **Exclude**) rendered as `.chip` groups with a
permission search; a **Preview effective permissions** panel resolves the include/exclude
result against the endpoint permission registry.

### 3.3 API clients (US-5, US-6)

Page title: **API Clients**. Columns: Name · App ID (mono) · Role(s) · IP ranges · Rate limit ·
Enabled · Last used. Row actions: `View`, `Edit`, `Rotate secret` (shows once), `Enable/Disable`,
`Delete`. `Add client` dialog: name, role(s), IP ranges (`Any` or CIDR list), rate limit.

### 3.4 Access check + audit (US-4, US-8)

- **UI filtering:** nav items and action buttons carry permission attributes; a component hides
  itself when the caller lacks the permission ([`02-ui-design.md`](../../00-guides/02-ui-design.md) §5.1).
- **Access audit:** a *Logbook* view (EPIC-037) shows allow/deny decisions: timestamp, actor,
  actor type (user/apiClient/system), role(s), permission checked, tenant, result.

### 3.5 OpenAPI (US-7)

`GET /openapi.json` serves the generated OpenAPI 3.1 document; a read-only docs page renders
it with an auth primer (client credentials against `api://<appId>/.default`).

## 4. Workflows

### 4.1 Permission evaluation (US-1, US-2, US-4)

Modelled on CIPP's endpoint-permission + role-resolution pattern:

1. Every API endpoint declares a **permission** (e.g. `Tenant.Standards.ReadWrite`,
   `Remediation.Apply`, `CIPP.Admin`). Declarations live in a machine-readable registry
   (CIPP's `Config/function-permissions.json` is the analogue) generated from endpoint
   metadata; a test asserts every endpoint has one.
2. `Test-PortalAccess` resolves the caller's effective permission:
   - actor is a portal user → their assigned role(s);
   - actor is an API client → the client's role(s).
3. Base/custom roles resolve via wildcard **include/exclude** patterns (CIPP's
   `cipp-roles.json` model): a permission is granted if it matches an include and no exclude.
4. `Public` permissions bypass the check; `anonymous`/`authenticated` are reserved defaults.
5. Deny → structured `403` with a stable `code`; the decision is audited.

**Base roles (proposed):**

| Role | Include | Exclude |
|---|---|---|
| `readonly` | `*.Read` | `CIPP.Admin.*`, `CIPP.SuperAdmin.*`, `CIPP.AppSettings.*` |
| `editor` | `*.Read`, `*.ReadWrite` | `CIPP.Admin.*`, `CIPP.SuperAdmin.*`, `CIPP.AppSettings.*`, `Remediation.Apply` |
| `admin` | `*` | `CIPP.SuperAdmin.*` |
| `superadmin` | `*` | — |

> `Remediation.Apply` is deliberately excluded from `editor` — applying tenant writes is a
> higher privilege than editing portal config (see [`06-remediation.md`](../../00-guides/06-remediation.md) §4).

### 4.2 Tenant scoping (US-3)

`Test-PortalAccess -TenantList` / `-GroupList` resolves the caller's allowed tenant set from
`UserScope` (direct tenants + expanded tenant groups). Every tenant-scoped query intersects
the requested scope with the allowed scope; a request outside scope is denied, never silently
narrowed. `superadmin` may hold `all`.

### 4.3 API client authentication (US-5)

1. Client authenticates via OAuth **client_credentials** against `api://<appId>/.default`.
2. The service identifies the client by its app ID, loads `ApiClient` (role, IP ranges, rate
   limit, enabled).
3. IP allow-list is checked (`Any` or CIDR; `Test-IpInRange` analogue).
4. Rate limit is enforced per client.
5. The request proceeds through the same `Test-PortalAccess` path as a user.

### 4.4 Rate limiting (US-6)

Per-client sliding window; CIPP uses **100 requests / 10 s** — adopt the same default and make
it per-client configurable. Exceeded → `429` with `Retry-After`.

### 4.5 Access audit (US-8)

Every allow/deny writes an `AuditEvent` with `actorType`, role(s), permission, tenant, result,
IP, correlation ID. Append-only; export to SIEM is EPIC-041.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `PortalUser` | `id`, `upn`, `displayName`, `status`, `preferences` | federated identity; no passwords |
| `Role` | `id`, `name`, `include[]`, `exclude[]`, `builtin` | base roles builtin=true |
| `UserScope` | `userId`, `targetType(tenant\|group\|all)`, `targetId` | tenant scoping |
| `ApiClient` | `id`, `name`, `secretHash`, `roles[]`, `ipRanges[]`, `rateLimit`, `enabled`, `lastUsedAt` | secret shown once, stored hashed |
| `AccessIPRange` | `id`, `cidr`, `scope` | instance-level allow-list (optional) |
| `PermissionRegistry` | `endpoint`, `permission`, `functionality` | generated; asserted complete |
| `AuditEvent` | full shape | allow/deny decisions |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/me` | caller identity, roles, effective permissions, scope |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/users` … | portal user CRUD |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/roles` … | role CRUD (base roles immutable) |
| `GET`/`POST`/`PATCH`/`DELETE` | `/v1/api-clients` … | API client CRUD |
| `POST` | `/v1/api-clients/{id}/rotate-secret` | rotate (returns secret once) |
| `POST` | `/v1/access/check` | evaluate a permission for the caller (UI preflight) |
| `GET` | `/openapi.json` | OpenAPI 3.1 document |

## 7. Permissions & scopes

- **Permission taxonomy:** `{Area}.{Resource}.{Action}` — e.g. `Tenant.Read`,
  `Tenant.Standards.ReadWrite`, `Remediation.Plan`, `Remediation.Apply`, `CIPP.Admin`,
  `CIPP.SuperAdmin`. Aligns with CIPP's `Tenant.Standards.ReadWrite` / `CIPP.Alert.ReadWrite`.
- **Endpoint registry:** one permission per endpoint; a test fails the build if an endpoint
  lacks one.
- **Admin surface:** role/user/API-client changes require `CIPP.Admin.*` (superadmin for
  `CIPP.SuperAdmin.*`).
- **Tenant auth (separate):** portal RBAC governs *portal* access; tenant Graph/EXO auth is
  EPIC-002's credential model. Do not conflate the two.

## 8. Remediation behavior

**None.** RBAC gates remediation but performs no tenant writes. It must, however, enforce the
`Remediation.Apply` permission and the tenant-scope check that EPIC-006 relies on, and audit
every remediation access decision.

## 9. Dependencies & risks

- Depends on EPIC-001 (audit, API skeleton) and EPIC-002 (tenants for scoping).
- **Risk: permission-registry drift** — an endpoint added without a permission. Mitigation:
  generated registry + build-time completeness test.
- **Risk: scope bypass** — trusting a client-supplied tenant list. Mitigation: always
  intersect with `UserScope`; deny outside scope.
- **Risk: API client secret leakage.** Mitigation: hashed at rest, returned once, never logged.
- **Risk: SSO complexity.** Mitigation: federated identity only; no local passwords; SSO
  provider choice is an open question (§11).

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Every endpoint resolves a permission; the completeness test passes.
- [ ] Base-role include/exclude resolution matches the table in §4.1.
- [ ] A user scoped to tenant A cannot read or act on tenant B (denied, audited).
- [ ] `editor` cannot call `Remediation.Apply`; `admin` can.
- [ ] An API client outside its IP range is denied; inside is allowed.
- [ ] Rate limit returns `429` with `Retry-After` past the threshold.
- [ ] `/openapi.json` validates as OpenAPI 3.1 and lists all endpoints.
- [ ] Every allow/deny writes an access `AuditEvent`.
- [ ] No client secret stored in plaintext or returned after creation.

## 11. Open questions

1. **SSO/federation provider** — **Resolved (adopted):** Entra ID first (audience parity);
   generic OIDC/SAML is a later addition (T-0744).
2. **Permission taxonomy sign-off** — **Resolved (adopted):** the `{Area}.{Resource}.{Action}`
   scheme in §7 (T-0742).
3. **MCP server in scope?** — **Deferred:** EPIC-041; RBAC is the prerequisite either way.
4. **Rate-limit default** — **Resolved (adopted):** CIPP's 100 req / 10 s, per-client
   configurable (T-0749).
5. **Custom-role ceiling** — **Resolved (adopted):** a custom role may include
   `Remediation.Apply`, but only when assigned by a superadmin and audited (T-0745).

---

## See also

- [`../../00-guides/05-programming.md`](../../00-guides/05-programming.md) — API conventions
- [`../../00-guides/04-data-modeling.md`](../../00-guides/04-data-modeling.md) — entities
- [`../../00-guides/06-remediation.md`](../../00-guides/06-remediation.md) — `Remediation.Apply`
- [`../EPIC-002-tenants-onboarding/SPEC.md`](../EPIC-002-tenants-onboarding/SPEC.md) — tenant scoping input
- [`../EPIC-037-settings-branding/SPEC.md`](../EPIC-037-settings-branding/SPEC.md) — logbook
- [`epic.md`](epic.md) — fleet rollup
