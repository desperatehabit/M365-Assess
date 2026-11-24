<#
.SYNOPSIS
    Remediates TEAMS-MEETING-001: Ensure anonymous users can't join a meeting
.DESCRIPTION
    Updates the Global Teams meeting policy.
    Anonymous users can no longer join meetings.

    Desired state: AllowAnonymousUsersToJoinMeeting = $false
    Requires: Microsoft Teams (Connect-MicrosoftTeams).

    Changes the Global (org-wide default) policy only. Users assigned a custom policy keep
    that policy; review custom policies with Get-CsTeamsMeetingPolicy.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-MEETING-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-MEETING-001.ps1
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
    CheckId   = 'TEAMS-MEETING-001'
    Target    = 'Teams meeting policy Global'
    Desired   = 'AllowAnonymousUsersToJoinMeeting = $false'
    GetState  = {
        Get-CsTeamsMeetingPolicy -Identity Global
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            AllowAnonymousUsersToJoinMeeting = $false
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            AllowAnonymousUsersToJoinMeeting = $false
        }
        Set-CsTeamsMeetingPolicy -Identity Global @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
