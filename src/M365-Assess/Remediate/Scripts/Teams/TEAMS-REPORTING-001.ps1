<#
.SYNOPSIS
    Remediates TEAMS-REPORTING-001: Ensure users can report security concerns in Teams
.DESCRIPTION
    Lets users report messages as security concerns from Teams (Global messaging policy).

    Desired state: AllowSecurityEndUserReporting = $true
    Requires: Microsoft Teams (Connect-MicrosoftTeams).

    Reported messages go to the destination set in the Defender user-reported settings
    (Set-ReportSubmissionPolicy -ReportChatMessageEnabled $true). Configure that separately.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-REPORTING-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-REPORTING-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Teams'

$step = @{
    CheckId   = 'TEAMS-REPORTING-001'
    Target    = 'Teams messaging policy Global'
    Desired   = 'AllowSecurityEndUserReporting = $true'
    GetState  = {
        Get-CsTeamsMessagingPolicy -Identity Global
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            AllowSecurityEndUserReporting = $true
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            AllowSecurityEndUserReporting = $true
        }
        Set-CsTeamsMessagingPolicy -Identity Global @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
