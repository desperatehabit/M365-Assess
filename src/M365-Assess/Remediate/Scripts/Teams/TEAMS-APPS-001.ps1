<#
.SYNOPSIS
    Remediates TEAMS-APPS-001: Chat Resource-Specific Consent Enabled
.DESCRIPTION
    Turns off chat resource-specific consent (RSC), so users can no longer grant apps
    access to chat data.

    Desired state: isChatResourceSpecificConsentEnabled = $false
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: TeamworkAppSettings.ReadWrite.All.

    Apps that already rely on chat RSC permissions stop receiving them.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-APPS-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-APPS-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'TeamworkAppSettings.ReadWrite.All'

$expected = @{
    'isChatResourceSpecificConsentEnabled' = $false
}
$body = @{
    isChatResourceSpecificConsentEnabled = $false
}

$step = @{
    CheckId   = 'TEAMS-APPS-001'
    Target    = 'Teams app settings'
    Desired   = 'isChatResourceSpecificConsentEnabled = $false'
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/teamwork/teamsAppSettings'
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected $expected
    }
    SetState  = {
        param($State)
        Set-RemediationGraphObject -Uri '/v1.0/teamwork/teamsAppSettings' -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
