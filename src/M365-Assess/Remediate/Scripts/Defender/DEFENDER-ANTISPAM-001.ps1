<#
.SYNOPSIS
    Remediates DEFENDER-ANTISPAM-001: Ensure Exchange Online Spam Policies are set to notify administrators
.DESCRIPTION
    Applies the settings the anti-spam check looks for to the default inbound policy: BCL
    threshold 6 or lower, spam to Junk or Quarantine, high-confidence spam / phish / phishing to
    Quarantine, and spam and phish ZAP on.

    Desired state: Default anti-spam policy meets the check
    Requires: Exchange Online (Connect-ExchangeOnline).

    Existing stricter values (a lower BCL threshold, spam to Quarantine) are kept.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyIdentity
    Policy to change. Defaults to the built-in default policy ('Default').
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-ANTISPAM-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-ANTISPAM-001.ps1
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

$expected = @{
    HighConfidenceSpamAction  = 'Quarantine'
    HighConfidencePhishAction = 'Quarantine'
    PhishSpamAction           = 'Quarantine'
    SpamZapEnabled            = $true
    PhishZapEnabled           = $true
}

$step = @{
    CheckId   = 'DEFENDER-ANTISPAM-001'
    Target    = "Anti-spam policy $PolicyIdentity"
    Desired   = 'Meets anti-spam check'
    GetState  = {
        Get-HostedContentFilterPolicy -Identity $PolicyIdentity
    }
    TestState = {
        param($State)
        (Test-RemediationProperty -State $State -Expected $expected) -and
        @('MoveToJmf', 'Quarantine') -contains "$($State.SpamAction)" -and
        $null -ne $State.BulkThreshold -and [int]$State.BulkThreshold -le 6
    }
    SetState  = {
        param($State)
        $settings = $expected.Clone()
        if (@('MoveToJmf', 'Quarantine') -notcontains "$($State.SpamAction)") { $settings['SpamAction'] = 'MoveToJmf' }
        if ($null -eq $State.BulkThreshold -or [int]$State.BulkThreshold -gt 6) { $settings['BulkThreshold'] = 6 }
        Set-HostedContentFilterPolicy -Identity $PolicyIdentity @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
