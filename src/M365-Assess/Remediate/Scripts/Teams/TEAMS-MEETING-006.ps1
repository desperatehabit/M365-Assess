<#
.SYNOPSIS
    Remediates TEAMS-MEETING-006: Ensure meeting chat does not allow anonymous users
.DESCRIPTION
    Updates the Global Teams meeting policy.
    Meeting chat stays on for everyone except anonymous users. An existing Disabled value is kept.

    Desired state: MeetingChatEnabledType = 'EnabledExceptAnonymous'
    Requires: Microsoft Teams (Connect-MicrosoftTeams).

    Changes the Global (org-wide default) policy only. Users assigned a custom policy keep
    that policy; review custom policies with Get-CsTeamsMeetingPolicy.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-MEETING-006.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-MEETING-006.ps1
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
    CheckId   = 'TEAMS-MEETING-006'
    Target    = 'Teams meeting policy Global'
    Desired   = 'MeetingChatEnabledType = ''EnabledExceptAnonymous'''
    GetState  = {
        Get-CsTeamsMeetingPolicy -Identity Global
    }
    TestState = {
        param($State)
        -not [string]::IsNullOrEmpty($State.MeetingChatEnabledType) -and $State.MeetingChatEnabledType -ne 'Enabled'
    }
    SetState  = {
        param($State)
        $settings = @{
            MeetingChatEnabledType = 'EnabledExceptAnonymous'
        }
        Set-CsTeamsMeetingPolicy -Identity Global @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
