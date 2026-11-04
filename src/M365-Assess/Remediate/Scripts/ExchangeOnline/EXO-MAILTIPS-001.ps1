<#
.SYNOPSIS
    Remediates EXO-MAILTIPS-001: Ensure MailTips are enabled for end users
.DESCRIPTION
    Turns on MailTips, including the external-recipient tip and group metrics.

    Desired state: MailTipsAllTipsEnabled = $true, MailTipsExternalRecipientsTipsEnabled = $true, MailTipsGroupMetricsEnabled = $true
    Requires: Exchange Online (Connect-ExchangeOnline).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-MAILTIPS-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-MAILTIPS-001.ps1
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
    CheckId   = 'EXO-MAILTIPS-001'
    Target    = 'Exchange organization config'
    Desired   = 'MailTipsAllTipsEnabled = $true, MailTipsExternalRecipientsTipsEnabled = $true, MailTipsGroupMetricsEnabled = $true'
    GetState  = {
        Get-OrganizationConfig
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            MailTipsAllTipsEnabled = $true
            MailTipsExternalRecipientsTipsEnabled = $true
            MailTipsGroupMetricsEnabled = $true
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            MailTipsAllTipsEnabled = $true
            MailTipsExternalRecipientsTipsEnabled = $true
            MailTipsGroupMetricsEnabled = $true
        }
        Set-OrganizationConfig @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
