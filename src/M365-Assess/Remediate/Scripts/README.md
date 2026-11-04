# Per-check remediation scripts

One standalone PowerShell script per registry check, at
`Remediate/Scripts/<Collector>/<CheckId>.ps1`. Every registry check either has a
script here or is listed in [`coverage.json`](coverage.json) with the reason it
has none (already covered by a typed binding, or not remediable by script).
`tests/Remediate/Scripts/RemediationScripts.Tests.ps1` enforces this.

## Status: unvalidated

These scripts are **not** wired into the gated apply path
(`Get-RemediationCommand.ps1` / `Invoke-RemediationAction.ps1`). The project rule
(EPIC-006 SPEC.md section 4.5) is that a check only gets a typed binding after it
has been hand-tested on a real tenant. These scripts are the starting point for
that validation:

1. Connect to the service the script names in its help (`Get-Help <script> -Full`).
2. Run it with `-WhatIf` and check the `Before` state and planned change.
3. Run it for real on a test tenant (you are prompted; `-Confirm:$false` skips the prompt).
4. Re-run the assessment and confirm the check passes.
5. Promote it: add the typed binding, state reader, and apply case, and move the
   script's logic there.

## Contract

Each script:

- declares `SupportsShouldProcess` with `ConfirmImpact = 'High'`, so it prompts by
  default and supports `-WhatIf`;
- checks for an existing service connection and never connects on your behalf;
- reads the current state and stops with `AlreadyCompliant` if nothing needs to change;
- applies the smallest change that makes the check pass, re-reads, and verifies;
- returns one object per step: `CheckId`, `Target`, `Status`, `Desired`, `Before`,
  `After`, `Message`. `Status` is `AlreadyCompliant`, `WhatIf`, `Applied`,
  `VerifyFailed`, or `Failed`.

Scripts for checks triaged **Needs decision** take the org-specific inputs as
mandatory parameters (break-glass accounts, target groups, approvers, and so on).
Where the service allows it, new policies are created in report-only or disabled
state so you can review impact before enforcing.

## Writing a script

Dot-source `Common/RemediationScriptHelper.ps1`, call `Assert-RemediationConnection`,
then pass `GetState` / `TestState` / `SetState` script blocks to
`Invoke-RemediationStep -Cmdlet $PSCmdlet`. The script blocks run inside the helper
function, so don't name script parameters or variables after the helper's own
locals (`Cmdlet`, `CheckId`, `Target`, `Desired`, `GetState`, `TestState`,
`SetState`, `SkipVerify`, `result`, `before`, `after`).

File names are the check id rather than `Verb-Noun` so each script maps one-to-one
to a registry entry.
