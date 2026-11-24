<#
.SYNOPSIS
    Remediates EXO-CONNFILTER-002: Ensure the connection filter safe list is off
.DESCRIPTION
    Turns off the Microsoft-maintained connection filter safe list, so mail from those IPs
    is still spam-filtered.

    Desired state: EnableSafeList = $false
    Requires: Exchange Online (Connect-ExchangeOnline).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyIdentity
    Policy to harden. Defaults to the built-in default policy ('Default').
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-CONNFILTER-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-CONNFILTER-002.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyIdentity = 'Default'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$step = @{
    CheckId   = 'EXO-CONNFILTER-002'
    Target    = "Connection filter policy $PolicyIdentity"
    Desired   = 'EnableSafeList = $false'
    GetState  = {
        Get-HostedConnectionFilterPolicy -Identity $PolicyIdentity
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            EnableSafeList = $false
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            EnableSafeList = $false
        }
        Set-HostedConnectionFilterPolicy -Identity $PolicyIdentity @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
