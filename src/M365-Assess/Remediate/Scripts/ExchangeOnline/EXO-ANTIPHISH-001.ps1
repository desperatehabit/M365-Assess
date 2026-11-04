<#
.SYNOPSIS
    Remediates EXO-ANTIPHISH-001: Anti-Phishing Policy Configuration
.DESCRIPTION
    Hardens the default anti-phishing policy: mailbox intelligence and its protection, spoof
    intelligence, organization-domain impersonation protection, first-contact safety tips, and
    Quarantine for impersonation and spoof detections. Optionally protects named users.

    Desired state: Default anti-phishing policy hardened
    Requires: Exchange Online (Connect-ExchangeOnline).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyIdentity
    Policy to harden. Defaults to the built-in default policy ('Office365 AntiPhish Default').
.PARAMETER ProtectedUser
    Users to protect from impersonation, in 'Display Name;address@domain' form (executives,
    finance). Omit to leave targeted user protection unchanged.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-ANTIPHISH-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/ExchangeOnline/EXO-ANTIPHISH-001.ps1
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
    MailboxIntelligenceProtectionAction = 'Quarantine'
    EnableSpoofIntelligence             = $true
    AuthenticationFailAction            = 'Quarantine'
    EnableOrganizationDomainsProtection = $true
    TargetedDomainProtectionAction      = 'Quarantine'
    EnableFirstContactSafetyTips        = $true
}
if (@($ProtectedUser | Where-Object { $_ }).Count -gt 0) {
    $expected['EnableTargetedUserProtection'] = $true
    $expected['TargetedUsersToProtect'] = @($ProtectedUser)
    $expected['TargetedUserProtectionAction'] = 'Quarantine'
}

$step = @{
    CheckId   = 'EXO-ANTIPHISH-001'
    Target    = "Anti-phishing policy $PolicyIdentity"
    Desired   = 'Hardened settings'
    GetState  = {
        Get-AntiPhishPolicy -Identity $PolicyIdentity
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected $expected
    }
    SetState  = {
        param($State)
        Set-AntiPhishPolicy -Identity $PolicyIdentity @expected
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
