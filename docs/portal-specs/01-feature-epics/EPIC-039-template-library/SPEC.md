# EPIC-039 — Template Library & Catalog

- **Status:** Drafted
- **Cluster:** Platform Admin
- **Severity:** medium
- **Depends on:** EPIC-015, EPIC-016, EPIC-008
- **CIPP provenance:** [`cipp-features.md`](../../99-reference/cipp-features.md) #52; CIPP `Tools/GitHub/`, `Config/CommunityRepos.json`, `tools/templatelib/`
- **Epic ticket:** [`epic.md`](epic.md)

## 1. Purpose

A shared library for every template type (CA, Intune, standards, baselines, policy, group, PIM role
settings, report builder, custom test): browse a local library and a community catalog, clone
templates into a tenant, and manage packages. This is what makes the other epics' templates
discoverable and shareable.

### Planned scope

- Template library (local)
- Community catalog (repos)
- Package manager
- Save-to-GitHub flow

## 2. User stories

| # | Story | Candidate child ticket |
|---|---|---|
| US-1 | As an operator, I can browse the local template library by type. | `T-TL-01` local library |
| US-2 | As an operator, I can add a community repository and browse its templates. | `T-TL-02` community catalog |
| US-3 | As an operator, I can clone a template into a tenant. | `T-TL-03` clone/deploy |
| US-4 | As an operator, I can save a template to GitHub. | `T-TL-04` save to GitHub |
| US-5 | As an operator, I can manage template packages. | `T-TL-05` package manager |

## 3. UI design

Nav: *Tools → Template Library, Catalog, Template Package Manager*
([`cipp-ui-inventory.md`](../../99-reference/cipp-ui-inventory.md) §3). Theme per
[`02-ui-design.md`](../../00-guides/02-ui-design.md).

### 3.1 Template Library (US-1)

Page title: **Template Library**. Source picker: **Local** or **Community Repository** (with branch
selector). Checkbox groups by type (Conditional Access, Intune Configuration, Intune Compliance,
Intune Protection, Template Standards, Group, Policy, CA Templates). A **Configured Template
Libraries** table lists imported sets. Row actions: `View`, `Clone to tenant`, `Export`, `Delete`.

### 3.2 Catalog (US-2)

Page title: **Catalog**. Type chips (Intune Policy, Conditional Access, Standards, Baseline, Report
Builder, Group, PIM Role Settings, Custom Test). Repo cards show **Built-in** / **Write Access**
chips and a `+N more` count. `Add repo` dialog (URL or owner/repo, template types, user/org).

### 3.3 Clone/deploy (US-3)

From any library/catalog item, clone into a tenant using the target epic's deploy flow (CA deploy
drawer, Intune policy deploy, standards template, etc.). Clone shows a plan.

### 3.4 Save to GitHub (US-4)

From a template (standards/CA/Intune/custom test), `Save to GitHub` opens a dialog: repository pick
(from configured repos), commit message; writes via the GitHub integration (only when enabled).

### 3.5 Package manager (US-5)

Page title: **Template Package Manager**. Import/export template packages; version and dependency
handling.

## 4. Workflows

### 4.1 Browse & clone (US-1, US-2, US-3)

1. Operator picks a source (local/community), type, and template.
2. `Clone` resolves target tenant(s) and opens the relevant deploy flow with a plan.
3. Apply routes through **EPIC-006**.

### 4.2 Save to GitHub (US-4)

1. Requires a configured GitHub integration (EPIC-041) with write access.
2. The portal commits the template file with the given message and records the commit.
3. Failures (auth, conflict) are surfaced clearly.

### 4.3 Packages (US-5)

Import a package (bundle of templates) → validate → register in the local library; export produces a
shareable package.

## 5. Data model

| Entity | Fields | Notes |
|---|---|---|
| `TemplateRepo` | `id`, `url`, `name`, `types[]`, `writeAccess`, `builtin` | community repo |
| `TemplatePackage` | `id`, `name`, `version`, `contents[]`, `source` | |
| `TemplateLibraryItem` | `id`, `type`, `name`, `body`, `source(local\|community)`, `repoId?` | index of local+community |
| `AuditEvent` | full shape | clone/save/import |

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/template-library` | local library (by type) |
| `GET`/`POST`/`DELETE` | `/v1/template-repos` … | community repos |
| `GET` | `/v1/template-repos/{id}/templates` | repo templates |
| `POST` | `/v1/template-library/{id}/clone` | clone to tenant |
| `POST` | `/v1/template-library/{id}/save-to-github` | commit |
| `GET`/`POST` | `/v1/template-packages` … | packages |

## 7. Permissions & scopes

- **RBAC:** `templates.read`, `templates.clone`, `templates.write`; save-to-GitHub requires
  `CIPP.Admin.*` + the GitHub integration. Tenant-scoped for clone (EPIC-038).

## 8. Remediation behavior

Cloning/deploying a template routes through the target epic and **EPIC-006** for any tenant write.
Library/catalog browsing is read-only.

## 9. Dependencies & risks

- Depends on EPIC-015 (CA templates), EPIC-016 (Intune templates), EPIC-008 (standards).
  EPIC-041 (GitHub integration) is deferred — v1 is a local-only catalog.
- **Risk: untrusted community templates.** Mitigation: review before clone; show source/author;
  never auto-apply.
- **Risk: GitHub write access / token handling.** Mitigation: store token by reference; least
  privilege; audit commits.
- **Risk: template type proliferation.** Mitigation: a type registry; each type owned by its epic.

## 10. Acceptance criteria

- [ ] SPEC.md sections 2-9 complete and approved.
- [ ] Child tickets authored in `tickets/` with non-empty `scope:`.
- [ ] Local library browses by type.
- [ ] Community repos add and browse; Built-in/Write-Access chips render.
- [ ] Clone into a tenant opens the correct deploy flow with a plan.
- [ ] Save-to-GitHub commits when integration is enabled.
- [ ] Packages import/export.

## 11. Open questions

1. **GitHub integration dependency** — **Resolved (adopted):** local-only catalog ships first;
   the GitHub install/save flow is a later opt-in (T-0767) and reuses the GitHub integration
   authored in EPIC-041 (T-0802), which is un-parked specifically for this need.
2. **Community repo trust model** — **Resolved (adopted):** signed/reviewed bundles with an
   admin opt-in; a repo is browsable/cloneable only after an admin opts it in, and clone
   refuses an unverified bundle (T-0764).
3. **Package format** — **Resolved (adopted):** a versioned JSON bundle (T-0766); a zip
   container is deferred to a later change.

---

## See also

- [`../EPIC-015-conditional-access/SPEC.md`](../EPIC-015-conditional-access/SPEC.md) — CA templates
- [`../EPIC-016-intune-policies/SPEC.md`](../EPIC-016-intune-policies/SPEC.md) — Intune templates
- [`../EPIC-041-integrations-copilot/SPEC.md`](../EPIC-041-integrations-copilot/SPEC.md) — GitHub integration
- [`epic.md`](epic.md) — fleet rollup
