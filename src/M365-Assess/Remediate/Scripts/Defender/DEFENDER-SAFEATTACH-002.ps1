<#
.SYNOPSIS
    Remediates DEFENDER-SAFEATTACH-002: Ensure Safe Attachments for SharePoint OneDrive and Microsoft Teams is Enabled
.DESCRIPTION
    Turns on Safe Attachments for SharePoint, OneDrive, and Microsoft Teams.

    Desired state: EnableATPForSPOTeamsODB = $true
    Requires: Exchange Online (Connect-ExchangeOnline).

    Requires Defender for Office 365 Plan 1 or 2.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-SAFEATTACH-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-SAFEATTACH-002.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$step = @{
    CheckId   = 'DEFENDER-SAFEATTACH-002'
    Target    = 'Defender for Office 365 global settings'
    Desired   = 'EnableATPForSPOTeamsODB = $true'
    GetState  = {
        Get-AtpPolicyForO365
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            EnableATPForSPOTeamsODB = $true
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            EnableATPForSPOTeamsODB = $true
        }
        Set-AtpPolicyForO365 @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
