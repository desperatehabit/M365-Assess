<#
.SYNOPSIS
    Remediates TEAMS-CLIENT-001: Ensure external file sharing in Teams is enabled for only approved cloud storage services
.DESCRIPTION
    Turns off third-party cloud storage providers in the Global Teams client configuration,
    except any the organization has approved.

    Desired state: All third-party storage providers disabled except -ApprovedProvider
    Requires: Microsoft Teams (Connect-MicrosoftTeams).

    Triage bucket: Needs decision (Needs org-specific values).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ApprovedProvider
    Providers to leave as they are (not disabled). The assessment check only passes when none are enabled,
    so anything listed here is recorded as an accepted exception.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-CLIENT-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-CLIENT-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateSet('DropBox', 'Box', 'GoogleDrive', 'ShareFile', 'Egnyte')]
    [string[]]$ApprovedProvider
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Teams'

$approved = @($ApprovedProvider | Where-Object { $_ })
$settings = @{}
foreach ($provider in @('DropBox', 'Box', 'GoogleDrive', 'ShareFile', 'Egnyte')) {
    if ($approved -notcontains $provider) { $settings["Allow$provider"] = $false }
}
if ($approved.Count -gt 0) {
    Write-Warning "Leaving enabled: $($approved -join ', '). TEAMS-CLIENT-001 will still report Fail for these."
}

$step = @{
    CheckId   = 'TEAMS-CLIENT-001'
    Target    = 'Teams client configuration Global'
    Desired   = 'Third-party storage limited to approved providers'
    GetState  = {
        Get-CsTeamsClientConfiguration -Identity Global
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected $settings
    }
    SetState  = {
        param($State)
        Set-CsTeamsClientConfiguration -Identity Global @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
