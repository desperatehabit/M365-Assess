<#
.SYNOPSIS
    Remediates EXO-EXTTAG-001: Ensure email from external senders is identified
.DESCRIPTION
    Turns on the native "External" tag that Outlook shows on mail from outside the organization.

    Desired state: Enabled = $true
    Requires: Exchange Online (Connect-ExchangeOnline).

    Tags can take up to 48 hours to appear in clients.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-EXTTAG-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-EXTTAG-001.ps1
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
    CheckId   = 'EXO-EXTTAG-001'
    Target    = 'External sender tagging (External in Outlook)'
    Desired   = 'Enabled = $true'
    GetState  = {
        Get-ExternalInOutlook
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            Enabled = $true
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            Enabled = $true
        }
        Set-ExternalInOutlook @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
