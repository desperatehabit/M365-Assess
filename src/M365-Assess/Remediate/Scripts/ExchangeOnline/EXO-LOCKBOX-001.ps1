<#
.SYNOPSIS
    Remediates EXO-LOCKBOX-001: Ensure the customer lockbox feature is enabled
.DESCRIPTION
    Turns on Customer Lockbox, so Microsoft engineers need your approval to access content.

    Desired state: CustomerLockBoxEnabled = $true
    Requires: Exchange Online (Connect-ExchangeOnline).

    Requires Microsoft 365 E5, E5 Compliance, or the Customer Lockbox add-on. Without the
    license the change is rejected and the script reports Failed.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-LOCKBOX-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-LOCKBOX-001.ps1
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
    CheckId   = 'EXO-LOCKBOX-001'
    Target    = 'Exchange organization config'
    Desired   = 'CustomerLockBoxEnabled = $true'
    GetState  = {
        Get-OrganizationConfig
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            CustomerLockBoxEnabled = $true
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            CustomerLockBoxEnabled = $true
        }
        Set-OrganizationConfig @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
