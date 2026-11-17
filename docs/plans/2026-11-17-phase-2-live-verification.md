# Phase 2 — live-tenant verification runbook

_Written 2026-11-17 for MASTER_PLAN Phase 2. The agent has no tenant credentials; a human runs
every step marked **Live**. Record each result in the ticket file (a `## Verification` section
with the date, what was done, and what was seen), then update `TICKETS.md`._

## 0. Gates before the live run

Run the live test against **committed** code that CI has passed, so that a result can be
reproduced and attributed.

- [ ] PRs #14 and #15 merged (Phase 0 exit).
- [ ] Phase 1 work committed, opened as a PR, CI green. On 2026-11-17 it was still uncommitted
      in the working tree of `chore/retire-fleet-tool`.
- [ ] Full suites green on that commit: `npm test` in `portal/`, and
      `pwsh -NoProfile -Command "Invoke-Pester -Path './tests'"`.
- [ ] A **test** tenant, not a client tenant. Several checks below write to the tenant.

## 1. Pre-flight already done without a tenant (2026-11-17)

Against the working tree, using `npm run dev` (BFF on :8080, web on :3000):

- All 120 nav routes compile and return 200. The dev log shows no render or build errors.
- Every `/v1` path the web client calls was probed against the BFF. The unmounted ones are
  filed: **T-0909** (backup restore preview), **T-0910** (tenant detail variables and history),
  **T-0911** (GDAP relationships), and **T-0912** (parked EPIC-041 pages in the nav). Expect
  these pages to fail during the walk; they don't need refiling.
- **T-0899** checked: with `M365_BFF_DEV_IDENTITY=operator`, API-client create, update,
  delete and rotate-secret return `403 auth.forbidden`; as `admin` they pass. This is
  independent of the tenant, so the check stands. Close it once the code is committed and the
  check is repeated on that commit.
- The system timers (standards, drift, webhooks, cleanup, credential-expiry) are all
  enabled; none is marked unavailable. `webhooks` ran once at startup and succeeded with no
  tenants.
- Minor, not filed: drift refresh and the domain DNS check return 500 (a SQLite foreign-key
  error) for a tenant ID that does not exist, instead of 404. This is unreachable from the UI.

## 2. Stand up against the test tenant

1. App registration and consent: run `src/M365-Assess/Setup/Grant-M365AssessConsent.ps1`
   (or use the wizard's *Create app registration* path). Use a **certificate**, because
   Exchange Online and Purview reject client secrets (`worker.credential_*`).
2. `cd portal && npm run dev`. Open http://localhost:3000.
3. **Tenants → Add tenant**. Enter the client ID and certificate thumbprint, then run *Test
   connection* in step 5.
4. Pick the tenant in the tenant bar. Run one assessment from **Runs** and confirm it
   completes. This proves that the worker launch, the credential, and the Graph, EXO and
   SharePoint connections all work, and every other check depends on it.

Keep a terminal on the dev output: a failing worker shows up there before the UI shows it.

## 3. Nav walk (read-only)

Open every nav section once with the test tenant selected. For each page:

- **Pass** — data or a correct empty state, and no red error banner.
- **Fail** — error banner, spinner that never ends, blank page (open dev tools; a blank page
  is a React render error), or data that is plainly wrong.

File each failure as a new ticket (next free ID: **T-0913**), with the page, the request that
failed (Network tab), the response `code` and `correlationId`, and the matching dev-log lines.
No tenant names, domains or UPNs in tickets.

## 4. Ticket checks

**R** = read-only. **W** = writes to the tenant; use test objects you create and remove
afterwards.

### Security and auth
| Ticket | Mode | Live check |
|---|---|---|
| T-0899 | — | Done locally (section 1); repeat on the committed build. |
| T-0876 | W | **Scheduler** → create a `custom-script` schedule for a harmless script → *Run now* → the history shows `succeeded`. |
| T-0902 | W | Create a webhook subscription (**Audit logs → Webhooks**). Let the 15-minute `webhooks` timer run; the subscription's expiry moves forward. |
| T-0903 | R | **Scheduler → System** → *Run now* on `cleanup` → `succeeded`; nothing inside the retention window is removed. |
| T-0904 | R | The `token-refresh` timer is either gone or runs green (the ticket's decision). It must not throw on the tick. |
| T-0874 | R | *Run now* on `credential-expiry` → `succeeded`. The tenant's credential state on **Tenants** matches the certificate expiry. |

### Incidents and alerting
| Ticket | Mode | Live check |
|---|---|---|
| T-0858 | R then W | **Incidents** lists real incidents; detail opens. Triage one test alert; bulk triage shows a confirmation first. |
| T-0859 | W | **Alerts**: create a rule, trigger it, see the event in the queue and history; restart the BFF and it persists. |

### Defender and devices
| Ticket | Mode | Live check |
|---|---|---|
| T-0849 | R | **Security → Defender**, **CVE** and **Onboarding** render live data. Add and remove a CVE exception. |
| T-0885 | W | **Intune → Reusable settings**: list, create one, sync. |

### Email
| Ticket | Mode | Live check |
|---|---|---|
| T-0851 | R then W | **Transport → Rules and Connectors** list. Edit a test transport rule. |
| T-0852 | R then W | **Quarantine**, **Spam filter**, **Allow/Block** list. Release one test message; add and remove one allow/block entry; *Submit for review*. |
| T-0854 | R | **Tools → Message trace** returns results. Open the Message Viewer on one message. Historical search starts. |
| T-0894 | W | **Mailboxes → Vacation**: schedule a test mailbox to start in 5 minutes and end 5 minutes later. It turns on and then back off by itself, and the earlier forwarding and out-of-office settings come back. |
| T-0901 | W | Create a rule on a test mailbox that forwards to two recipients. Open edit; both are pre-filled; saving keeps both. |
| T-0853 | W | **Contacts** and **Resources**: list, create a test contact, run one resource action. |

### Collaboration
| Ticket | Mode | Live check |
|---|---|---|
| T-0856 | R then W | **Teams**, **Activity**, **Voice** and **LIS** render. Create a test team and open its detail and members. |
| T-0857 | R then W | **Sharing** reports render. Remove one sharing link from a test file (bulk removal must not return 501). |
| T-0896 | W | **SharePoint → Templates** lists. Edit one property on a test site from the site detail page. |

### Tenant operations
| Ticket | Mode | Live check |
|---|---|---|
| T-0861 | R | **Secure score** shows the score and improvement actions mapped to checks. A snapshot point appears on the next daily run. |
| T-0862 | R | **Audit logs**: run a search, save it, check coverage. Webhooks CRUD as in T-0902. |
| T-0863 | R then W | **License report** and optimization render. Assign and remove a licence on a test user (dry run first). |
| T-0864 | R | **Domains**: DNS check on a verified domain shows records. Do not add or remove domains on a shared tenant. |
| T-0865 | W | **Backup**: create, download and delete. Restore is **blocked by T-0909** (preview). |

### Standards and compliance
| Ticket | Mode | Live check |
|---|---|---|
| T-0866 | R | **Test packs** and **Custom tests** run against the tenant; results persist after a BFF restart. |
| T-0879 | W | **Baselines**: advance the test tenant one stage; the UI shows the new stage. |
| T-0877 | R | **Standards** picker shows `license missing` for checks the tenant's licences cannot run. |
| T-0878 | W | **Drift**: open a deviation → *Remediate* → the job queues and runs. |

### Identity
| Ticket | Mode | Live check |
|---|---|---|
| T-0880 | W | **Users**: edit one field on a test user; it saves and appears in Entra. |
| T-0881 | W | **User templates**: create and edit a template. |
| T-0884 | W | **Conditional Access → Named locations**: create, edit, delete a test location. |
| T-0900 | W | **Groups**: create with GAL and delivery options set; *Convert* a test group. |

### Platform
| Ticket | Mode | Live check |
|---|---|---|
| T-0867 | R | **Settings**, **Branding**, **Preferences**, **Logbook**, **Diagnostics** render; a branding change persists. |
| T-0869 | R | **Templates** library and package manager render; clone one template. |
| T-0870 | R | **Tools → Graph explorer**: run `GET /organization`. This exercises the renamed `Invoke-PortalGraphRequest`. |
| T-0887 | R | Covered by the nav walk. Note **T-0912** for the three parked pages. |
| T-0891, T-0892 | R | Toggle demo mode: a banner appears and pages fill. Toggle off: live data only, no demo values. |
| T-0875 | R | **Reports**: generate the executive report (Secure Score and action buckets populated); download the bundle and check it contains every selected artifact. |

## 5. One remediation end to end (W)

On the test tenant only. Pick a low-impact failing check (for example a mailbox audit setting
on a test mailbox).

1. **Remediation** → plan → review the planned change.
2. Apply → the job succeeds.
3. Verify → the check now passes, and a rerun of the assessment agrees.
4. Roll back → the original value is back, and the check fails again.

Record the run IDs in the ticket for EPIC-006 / the plan.

## 6. Exit

Zero `fixed-unverified` in `TICKETS.md`, the T-0913+ tickets from the walk triaged, and the
remediation round trip recorded.
