<#
.SYNOPSIS
    Remediates DEFENDER-ANTIPHISH-001: Ensure that an anti-phishing policy has been created
.DESCRIPTION
    Applies the settings the anti-phishing check looks for to the default policy: phishing
    threshold 2 (aggressive) or higher, mailbox intelligence and its protection, spoof intelligence,
    honor DMARC, first-contact safety tips, organization-domain protection, and optionally
    user impersonation protection.

    Desired state: Default anti-phishing policy meets the check
    Requires: Exchange Online (Connect-ExchangeOnline).

    Policies managed by a preset security policy are already compliant and are not changed.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyIdentity
    Policy to change. Defaults to the built-in default policy ('Office365 AntiPhish Default').
.PARAMETER ProtectedUser
    Users to protect from impersonation, in 'Display Name;address@domain' form.
    Omit to leave targeted user protection unchanged.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-ANTIPHISH-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-ANTIPHISH-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyIdentity = 'Office365 AntiPhish Default',

    [Parameter()]
    [string[]]$ProtectedUser
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$expected = @{
    EnableMailboxIntelligence           = $true
    EnableMailboxIntelligenceProtection = $true
    EnableSpoofIntelligence             = $true
    HonorDmarcPolicy                    = $true
    EnableFirstContactSafetyTips        = $true
    EnableOrganizationDomainsProtection = $true
}
if (@($ProtectedUser | Where-Object { $_ }).Count -gt 0) {
    $expected['EnableTargetedUserProtection'] = $true
    $expected['TargetedUsersToProtect'] = @($ProtectedUser)
}

$step = @{
    CheckId   = 'DEFENDER-ANTIPHISH-001'
    Target    = "Anti-phishing policy $PolicyIdentity"
    Desired   = 'Meets anti-phishing check'
    GetState  = {
        Get-AntiPhishPolicy -Identity $PolicyIdentity
    }
    TestState = {
        param($State)
        (Test-RemediationProperty -State $State -Expected $expected) -and $null -ne $State.PhishThresholdLevel -and [int]$State.PhishThresholdLevel -ge 2
    }
    SetState  = {
        param($State)
        $settings = $expected.Clone()
        if ($null -eq $State.PhishThresholdLevel -or [int]$State.PhishThresholdLevel -lt 2) { $settings['PhishThresholdLevel'] = 2 }
        Set-AntiPhishPolicy -Identity $PolicyIdentity @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
