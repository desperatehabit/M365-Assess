<#
.SYNOPSIS
    Remediates PURVIEW-RETENTION-005: Ensure all retention policies are in Enforce mode
.DESCRIPTION
    Switches enabled retention policies that are still in simulation (Mode other than Enforce)
    to enforced.

    Desired state: Every enabled retention policy is in Enforce mode
    Requires: Security & Compliance PowerShell (Connect-IPPSSession).

    Enforcing a simulated policy starts retaining (and, for delete actions, deleting) content.
    Review each policy's simulation results first. The mode change is distributed
    asynchronously, so the step does not wait for Mode to read Enforce; re-run the assessment later.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyName
    Limit to these policies. Defaults to every enabled policy not in Enforce mode.
.EXAMPLE
    PS> ./Remediate/Scripts/PurviewRetention/PURVIEW-RETENTION-005.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/PurviewRetention/PURVIEW-RETENTION-005.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$PolicyName
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SecurityCompliance'

$step = @{
    CheckId   = 'PURVIEW-RETENTION-005'
    Target    = 'Retention policies not in Enforce mode'
    Desired   = 'None'
    GetState  = {
        @(Get-RetentionCompliancePolicy | Where-Object {
            $_.Enabled -ne $false -and $_.Mode -ne 'Enforce' -and
            (@($PolicyName | Where-Object { $_ }).Count -eq 0 -or @($PolicyName) -contains $_.Name)
        } | Select-Object -Property Name, Identity, Mode)
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($policy in $State) {
            Set-RetentionCompliancePolicy -Identity $policy.Identity -EnforceSimulationPolicy $true
        }
    }
    SkipVerify = $true
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
