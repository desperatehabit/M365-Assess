<#
.SYNOPSIS
    Remediates TEAMS-GUEST-001: Guest Access to Teams
.DESCRIPTION
    Either turns off guest access in Teams, or keeps it on and restricts guest calling,
    meeting, and messaging capabilities to a minimal set.

    Desired state: Guest access disabled (-Mode Disable) or restricted (-Mode Restrict)
    Requires: Microsoft Teams (Connect-MicrosoftTeams).

    Triage bucket: Needs decision (Business preference).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Mode
    Disable: turn off guest access entirely (existing guests lose Teams access).
    Restrict: keep guest access, but block private calling, video, screen sharing,
    Meet Now, and message edit/delete for guests.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-GUEST-001.ps1 -Mode Restrict -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-GUEST-001.ps1 -Mode Restrict
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Disable', 'Restrict')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Teams'

$allowGuest = $Mode -eq 'Restrict'

$step1 = @{
    CheckId   = 'TEAMS-GUEST-001'
    Target    = 'Teams client configuration (guest access)'
    Desired   = 'AllowGuestUser per -Mode'
    GetState  = {
        Get-CsTeamsClientConfiguration -Identity Global
    }
    TestState = {
        param($State)
        $State.AllowGuestUser -eq $allowGuest
    }
    SetState  = {
        param($State)
        $settings = @{
            AllowGuestUser = $allowGuest
        }
        Set-CsTeamsClientConfiguration -Identity Global @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'TEAMS-GUEST-001'
    Target    = 'Teams guest calling configuration'
    Desired   = 'AllowPrivateCalling = $false'
    GetState  = {
        Get-CsTeamsGuestCallingConfiguration -Identity Global
    }
    TestState = {
        param($State)
        $Mode -eq 'Disable' -or $State.AllowPrivateCalling -eq $false
    }
    SetState  = {
        param($State)
        $settings = @{
            AllowPrivateCalling = $false
        }
        Set-CsTeamsGuestCallingConfiguration -Identity Global @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2

$step3 = @{
    CheckId   = 'TEAMS-GUEST-001'
    Target    = 'Teams guest meeting configuration'
    Desired   = 'AllowIPVideo = $false, ScreenSharingMode = ''Disabled'', AllowMeetNow = $false'
    GetState  = {
        Get-CsTeamsGuestMeetingConfiguration -Identity Global
    }
    TestState = {
        param($State)
        $Mode -eq 'Disable' -or (Test-RemediationProperty -State $State -Expected @{ AllowIPVideo = $false; ScreenSharingMode = 'Disabled'; AllowMeetNow = $false })
    }
    SetState  = {
        param($State)
        $settings = @{
            AllowIPVideo = $false
            ScreenSharingMode = 'Disabled'
            AllowMeetNow = $false
        }
        Set-CsTeamsGuestMeetingConfiguration -Identity Global @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step3

$step4 = @{
    CheckId   = 'TEAMS-GUEST-001'
    Target    = 'Teams guest messaging configuration'
    Desired   = 'AllowUserEditMessage = $false, AllowUserDeleteMessage = $false, AllowUserChat = $true'
    GetState  = {
        Get-CsTeamsGuestMessagingConfiguration -Identity Global
    }
    TestState = {
        param($State)
        $Mode -eq 'Disable' -or (Test-RemediationProperty -State $State -Expected @{ AllowUserEditMessage = $false; AllowUserDeleteMessage = $false; AllowUserChat = $true })
    }
    SetState  = {
        param($State)
        $settings = @{
            AllowUserEditMessage = $false
            AllowUserDeleteMessage = $false
            AllowUserChat = $true
        }
        Set-CsTeamsGuestMessagingConfiguration -Identity Global @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step4
