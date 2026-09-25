# 0014 — The portal HTTP layer is a thin BFF; all domain work runs in PowerShell workers

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

The portal (see [`docs/portal-specs/`](../portal-specs/README.md)) needs a service layer — an HTTP API, a job/worker pool, storage access, and scheduling — to sit between the web UI and the existing M365-Assess module. The module is ~36,000 lines of PowerShell 7 and is the entire domain layer: every collector, every remediation command, every report builder.

The non-negotiable constraint is stated in [`00-guides/01-architecture.md`](../portal-specs/00-guides/01-architecture.md) §1: **the portal does not reimplement collectors or remediation logic.** A backend that ports the domain forks the module and abandons the 166 Pester suites that guard it.

Given that, the real decision is **where the HTTP/web layer lives**. The options:

- **All-PowerShell service.** One runtime; PowerShell handles HTTP, queue, and workers.
- **A thin backend-for-frontend (BFF) over PowerShell workers.** A small Node/TypeScript (or .NET) service owns HTTP concerns only; every domain operation is dispatched to PowerShell worker processes.
- **A full non-PowerShell backend.** The domain is ported to another language.

PowerShell is not a first-class web language: HTTP hosting, middleware, async request handling, request validation, and OpenAPI tooling are all less ergonomic, and throughput per instance is lower. Those costs land entirely in the web layer — not in the domain work, which is process-bound anyway.

## Decision

The portal uses a **thin backend-for-frontend** for the HTTP/web layer, with **all domain work executed by PowerShell 7 worker processes**.

Sub-parts:

- The **BFF** (implementation language to be finalized — TypeScript/Node recommended to match the Next.js frontend) owns web concerns only: routing, authentication/sessions, request validation, OpenAPI, rate limiting, and the SSE/WebSocket channel for progress. **It contains no tenant or domain logic.**
- **PowerShell workers** own every domain operation — assessment, remediation, standards, drift, baselines, reports. Each loads the M365-Assess module and runs tenant work in **child `pwsh` processes** (the per-tenant execution model in [`01-architecture.md`](../portal-specs/00-guides/01-architecture.md) §3.1).
- The BFF and workers communicate over a **versioned job envelope** (plain JSON) and a matching **result envelope**. The external contract is the OpenAPI document (EPIC-038).
- The CLI (`Invoke-M365Assessment`) remains a first-class interface; workers call the same code paths.
- A **guard test/lint** asserts the BFF contains no M365 SDK calls and no check/remediation logic.

## Consequences

**Positive**

- A mature web stack for the layer that needs one: proven routing, auth middleware, validation, and OpenAPI tooling.
- Clean separation of concerns: web concerns in the BFF, domain concerns in PowerShell. Each can evolve independently.
- The domain layer and its test suite are untouched; no fork.
- One language for the web tier (BFF + Next.js frontend) if TypeScript is chosen.
- Workers scale independently of the API process.

**Negative**

- **Two runtimes** and an IPC boundary to build and operate; two deployment artifacts.
- The "BFF stays thin" rule is load-bearing. If domain logic leaks into the BFF, the project has effectively started a second implementation — the exact failure this decision exists to prevent.
- Serialization at the boundary: domain objects must cross as plain data, not live objects.
- Two languages for contributors, and a versioned envelope contract to maintain.

**Failure modes and mitigations**

- *Domain logic creeps into the BFF* → guard test/lint forbidding M365 SDK usage and check logic in the BFF; code review; the rule is stated in the ADR and architecture guide.
- *IPC schema drift between BFF and workers* → versioned job/result envelopes; contract tests on both sides.
- *Orphaned or hung worker processes* → a supervisor with timeouts and process-tree kill; the same pattern the module already uses for PowerBI.
- *Boundary latency/overhead* → keep envelopes small (IDs, not blobs); artifacts stay on the artifact tier and are referenced, not passed.
- *Secret handling across the boundary* → credential material is materialized only inside the worker process; envelopes carry references, never secrets.

## Alternatives considered

- **All-PowerShell service (the earlier proposal).** Rejected by the owner: the web layer's ergonomics and throughput were judged not worth the simplicity gain.
- **Full non-PowerShell backend.** Rejected: forks the domain layer and abandons the regression net. Any non-PowerShell domain code is a non-starter.
- **BFF with in-process PowerShell.** Rejected: loading the M365 SDKs into the BFF process reintroduces the process-global session conflicts that forced per-tenant child processes in the first place.
- **BFF that shells out ad hoc per request.** Rejected: no queue, no isolation, no progress channel; the worker/job model is required for multi-tenant runs and scheduling.

---

## See also

- [`../portal-specs/00-guides/01-architecture.md`](../portal-specs/00-guides/01-architecture.md) — system shape, the one rule, and the per-tenant process model
- [`../portal-specs/01-feature-epics/EPIC-001-platform-foundation/SPEC.md`](../portal-specs/01-feature-epics/EPIC-001-platform-foundation/SPEC.md) — the service skeleton
- [`0015-sqlite-storage-behind-repository-interface.md`](0015-sqlite-storage-behind-repository-interface.md) — storage decision
- [`README.md`](README.md) — back to the ADR index
