<#
.SYNOPSIS
    Remediates EXO-AUTH-001: Ensure modern authentication for Exchange Online is enabled
.DESCRIPTION
    Turns on modern authentication for Exchange Online clients.

    Desired state: OAuth2ClientProfileEnabled = $true
    Requires: Exchange Online (Connect-ExchangeOnline).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-AUTH-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-AUTH-001.ps1
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
    CheckId   = 'EXO-AUTH-001'
    Target    = 'Exchange organization config'
    Desired   = 'OAuth2ClientProfileEnabled = $true'
    GetState  = {
        Get-OrganizationConfig
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            OAuth2ClientProfileEnabled = $true
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            OAuth2ClientProfileEnabled = $true
        }
        Set-OrganizationConfig @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
