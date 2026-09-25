# 0017 — GDAP is an optional tenant source; direct onboarding ships first

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

The portal must know which tenants to manage and how to authenticate to each ([`01-feature-epics/EPIC-002-tenants-onboarding/SPEC.md`](../portal-specs/01-feature-epics/EPIC-002-tenants-onboarding/SPEC.md)). There are two ways tenants arrive:

- **Direct onboarding.** An operator adds a tenant and supplies (or creates) its credential. Works for any owner of a tenant, no Microsoft Partner relationship required.
- **GDAP discovery.** Tenants are discovered from active GDAP (Granular Delegated Admin Privileges) relationships, as CIPP does. Requires a Microsoft Partner account, a Partner Center refresh token, CPV consent pushed per tenant, and GDAP role mapping — a substantial subsystem.

The owner's stated reality is **"mixed / not sure yet"**: some installs may be MSPs with GDAP, some may be organisations managing their own tenants. Committing to GDAP-first would impose Partner Center complexity on every install, including single-tenant ones.

## Decision

Tenant discovery sits behind an **`ITenantSource` abstraction**. The portal ships **`DirectTenantSource`** first; **`GdapTenantSource`** is a later implementation of the same interface. The core only knows `Tenant` records with a `source` field; GDAP-specific data (relationship end, delegated privilege status, CPV consent state) lives in a satellite record so direct-mode installs carry none of it.

Sub-parts:

- Direct onboarding is fully functional on its own and is the v1 path.
- GDAP is additive and gated behind a feature flag; enabling it never affects direct tenants.
- Partner Center, refresh-token management, CPV consent, and GDAP role mapping are scoped to the GDAP epic, not the core.

## Consequences

**Positive**

- v1 is unblocked without Partner Center, refresh tokens, or CPV consent.
- Non-MSP installs carry no GDAP code path or credentials.
- Mixed installs work: direct tenants and GDAP tenants coexist.
- The `ITenantSource` seam makes the GDAP implementation a contained addition rather than a core refactor.

**Negative**

- MSP parity with CIPP's automatic tenant discovery is deferred; MSPs must add tenants directly until GDAP lands.
- Two onboarding paths to maintain eventually.
- The abstraction is speculative until GDAP is actually built; it may need adjustment when the real implementation arrives.

**Failure modes and mitigations**

- *GDAP assumptions leak into core* → the core stores only `Tenant` + `source`; GDAP data is a satellite; a test asserts direct-mode installs create no GDAP rows.
- *Abstraction proves wrong when GDAP is built* → the interface is deliberately thin (list/resolve tenants); adjusting it is a contained change.
- *MSP users blocked on v1* → direct onboarding covers the functional need (assess/remediate) even without auto-discovery; document the gap.

## Alternatives considered

- **GDAP-first (CIPP parity).** Rejected: imposes Partner Center/CPV complexity on all installs and blocks v1 on a large subsystem the owner may not need.
- **No GDAP ever.** Rejected: MSP demand is real and the abstraction cost is low; deferring is better than forbidding.
- **A single hard-coded tenant list.** Rejected: does not scale to multi-tenant or mixed installs.

---

## See also

- [`../portal-specs/01-feature-epics/EPIC-002-tenants-onboarding/SPEC.md`](../portal-specs/01-feature-epics/EPIC-002-tenants-onboarding/SPEC.md) — onboarding paths
- [`../portal-specs/00-guides/03-database.md`](../portal-specs/00-guides/03-database.md) §3 — tenant source model
- [`../portal-specs/99-reference/cipp-features.md`](../portal-specs/99-reference/cipp-features.md) §4 — CIPP's four auth mechanisms (reference only)
- [`README.md`](README.md) — back to the ADR index
