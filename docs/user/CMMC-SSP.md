# CMMC Level 2 questionnaire and System Security Plan

The portal turns an M365-Assess run into a CMMC 2.0 Level 2 System Security Plan (SSP).
It covers all 110 NIST SP 800-171 Rev. 2 practices, including the ones no Microsoft 365
API can check (physical security, personnel, training, maintenance, and paperwork), by
pairing the automated results with a questionnaire you complete with the customer.

Open it from **Assessments > CMMC SSP** with a tenant selected.

## How each practice gets its status

| Source | When it applies | Status shown |
|---|---|---|
| Questionnaire answer | You saved an answer for the practice | The status you recorded |
| Automated result | No answer yet, and the latest run has findings for the practice's mapped checks | All pass: Implemented. Any fail with no pass: Not implemented. Mixed or Warning: Partially implemented |
| Neither | No answer and no automated result (or only Review results) | Not yet assessed |

A recorded answer always wins over the automated result, because you have seen both the
evidence and the customer's context. Clear the answer to fall back to the automated result.

Automated evidence is read live from the tenant's latest run each time the page or the
SSP is opened, so re-running the assessment updates it. Answers are stored per tenant,
and every change is written to the audit log.

## SPRS score

The questionnaire header and section 3.1 of the SSP show the score from the NIST SP 800-171
DoD Assessment Methodology, the number submitted to SPRS and used by CMMC Level 2:

- Start at 110 and subtract each unmet practice's value (1, 3, or 5). The range is -203 to 110.
- Partially implemented and planned practices earn no credit, except 3.5.3 (MFA) and 3.13.11
  (FIPS-validated cryptography), which deduct 3 instead of 5 when partially implemented.
- Not-applicable practices deduct nothing.
- Practices not yet assessed are deducted, so the score is never overstated. The SSP says how
  many points those account for.
- 3.12.4 (the SSP itself) has no value, but an assessment cannot be completed until it is
  implemented. The SSP flags it until you record it as implemented.

For CMMC Level 2 Conditional status the score must be at least 88, and only 1-point practices
that are not also Level 1 practices (plus 3.13.11 at partial credit) may be on the POA&M. The
POA&M table marks each gap as eligible or not, and the SSP lists the practices that must be
implemented first.

The point values are transcribed from the methodology's Annex A and checked to total 313
(110 - 313 = -203). Confirm the score with your assessor before submitting it.

## Responsibility

Each answer records who carries the practice:

- **Customer**: the organization implements it.
- **Shared**: Microsoft covers part (for example its datacenters for 3.10.1) and the customer the rest.
- **Inherited**: Microsoft implements it (for example 3.5.11, password masking in Entra ID sign-in).

Practices Microsoft fully or partly covers are pre-set to Shared or Inherited, with the
reason shown. Confirm or change it for each customer.

## The questionnaire

The 24 practices no automated check covers carry a specific question and a note on the
evidence an assessor will ask for. For every practice you record:

- implementation status and responsibility
- how the practice is implemented (the SSP narrative)
- evidence references, one per line (document names, links, ticket numbers)
- an owner and, for planned or partial practices, a planned completion date

Filter the list by family, or by **Needs an answer** and **Gaps (POA&M)** to work through
what is left.

## The SSP deliverable

**Download SSP (Word)** produces an editable `.docx`; **Open SSP (HTML)** opens a
printable page (use the browser's Print to PDF). Both contain:

1. System identification (organization, system, owner, contacts, CUI categories)
2. System description, authorization boundary, operating environment, and interconnections
3. Implementation summary, including Level 1 practices implemented and the SPRS score
4. Every practice by family: status, responsibility, source, owner, narrative, inheritance
   note, automated evidence, and evidence references
5. Plan of action and milestones: every practice not fully implemented or not yet
   assessed, with owner, planned date, and the gap
6. An approval block

The document is a draft for the system owner to review, complete, and approve. The Word
file uses the built-in Heading styles, so you can restyle it with your own template and
add a table of contents.

## API

| Method | Path | Permission |
|---|---|---|
| GET | `/v1/tenants/{tenantId}/ssp` | `Compliance.Ssp.Read` |
| PUT | `/v1/tenants/{tenantId}/ssp/profile` | `Compliance.Ssp.ReadWrite` |
| PUT | `/v1/tenants/{tenantId}/ssp/practices/{practiceId}` | `Compliance.Ssp.ReadWrite` |
| DELETE | `/v1/tenants/{tenantId}/ssp/practices/{practiceId}` | `Compliance.Ssp.ReadWrite` |
| GET | `/v1/tenants/{tenantId}/ssp/document?format=docx\|html` | `Compliance.Ssp.Read` |

The readonly base role can view and download; editor and above can answer.
