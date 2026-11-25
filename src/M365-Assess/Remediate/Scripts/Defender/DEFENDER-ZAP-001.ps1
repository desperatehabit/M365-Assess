<#
.SYNOPSIS
    Remediates DEFENDER-ZAP-001: Ensure Zero-hour auto purge for Microsoft Teams is on
.DESCRIPTION
    Turns on zero-hour auto purge (ZAP) for Microsoft Teams messages on the Teams protection
    policy (Set-TeamsProtectionPolicy). Get-AtpPolicyForO365 has no ZapEnabled setting.

    Desired state: ZapEnabled = $true
    Requires: Exchange Online (Connect-ExchangeOnline).

    Requires Defender for Office 365 Plan 2 (or E5).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-ZAP-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-ZAP-001.ps1
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
    CheckId   = 'DEFENDER-ZAP-001'
    Target    = 'Teams protection policy'
    Desired   = 'ZapEnabled = $true'
    GetState  = {
        Get-TeamsProtectionPolicy | Select-Object -First 1
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            ZapEnabled = $true
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            ZapEnabled = $true
        }
        Set-TeamsProtectionPolicy -Identity $State.Identity @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
