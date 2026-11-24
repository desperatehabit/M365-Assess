<#
.SYNOPSIS
    Remediates EXO-ANTISPAM-001: Anti-Spam Policy Configuration
.DESCRIPTION
    Hardens the default inbound anti-spam policy: spam to Junk, high-confidence spam and
    phishing to Quarantine, and a bulk complaint level (BCL) threshold of 6 or lower.

    Desired state: SpamAction MoveToJmf, HighConfidenceSpamAction/PhishSpamAction/HighConfidencePhishAction Quarantine, BulkThreshold <= 6
    Requires: Exchange Online (Connect-ExchangeOnline).

    A BulkThreshold already at 6 or lower is left as is.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyIdentity
    Policy to harden. Defaults to the built-in default policy ('Default').
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-ANTISPAM-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-ANTISPAM-001.ps1
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
    SpamAction                = 'MoveToJmf'
    HighConfidenceSpamAction  = 'Quarantine'
    PhishSpamAction           = 'Quarantine'
    HighConfidencePhishAction = 'Quarantine'
}

$step = @{
    CheckId   = 'EXO-ANTISPAM-001'
    Target    = "Anti-spam policy $PolicyIdentity"
    Desired   = 'Hardened settings'
    GetState  = {
        Get-HostedContentFilterPolicy -Identity $PolicyIdentity
    }
    TestState = {
        param($State)
        (Test-RemediationProperty -State $State -Expected $expected) -and $null -ne $State.BulkThreshold -and [int]$State.BulkThreshold -le 6
    }
    SetState  = {
        param($State)
        $settings = $expected.Clone()
        if ($null -eq $State.BulkThreshold -or [int]$State.BulkThreshold -gt 6) { $settings['BulkThreshold'] = 6 }
        Set-HostedContentFilterPolicy -Identity $PolicyIdentity @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
