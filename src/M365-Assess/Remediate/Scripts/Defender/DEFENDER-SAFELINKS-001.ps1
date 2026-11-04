<#
.SYNOPSIS
    Remediates DEFENDER-SAFELINKS-001: Ensure Safe Links for Office Applications is Enabled
.DESCRIPTION
    Creates (or updates) a Safe Links policy and rule covering every accepted domain, with URL
    scanning for email, Teams, and Office apps, click tracking, internal-sender coverage, and
    delivery held until scanning completes.

    Desired state: Safe Links policy enabled for all recipients
    Requires: Exchange Online (Connect-ExchangeOnline).

    Requires Defender for Office 365. Tenants using the Standard or Strict preset already get
    Safe Links from the preset; this adds a custom policy alongside it.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER PolicyName
    Name of the policy and rule to create or update.
.PARAMETER RecipientDomain
    Recipient domains the rule covers. Defaults to every accepted domain.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-SAFELINKS-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-SAFELINKS-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$PolicyName = 'Safe Links',

    [Parameter()]
    [string[]]$RecipientDomain
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'ExchangeOnline'

$domains = if (@($RecipientDomain | Where-Object { $_ }).Count -gt 0) { @($RecipientDomain) } else { @(Get-AcceptedDomain | ForEach-Object { "$($_.DomainName)" }) }
$expected = @{
    EnableSafeLinksForEmail  = $true
    EnableSafeLinksForTeams  = $true
    EnableSafeLinksForOffice = $true
    ScanUrls                 = $true
    TrackClicks              = $true
    EnableForInternalSenders = $true
    DeliverMessageAfterScan  = $true
}

$step1 = @{
    CheckId   = 'DEFENDER-SAFELINKS-001'
    Target    = "Safe Links policy $PolicyName"
    Desired   = 'Enabled with recommended settings'
    GetState  = {
        Get-SafeLinksPolicy -Identity $PolicyName -ErrorAction SilentlyContinue
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected $expected
    }
    SetState  = {
        param($State)
        if ($null -eq $State) { New-SafeLinksPolicy -Name $PolicyName @expected | Out-Null }
        else { Set-SafeLinksPolicy -Identity $PolicyName @expected }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'DEFENDER-SAFELINKS-001'
    Target    = "Safe Links rule $PolicyName"
    Desired   = 'Enabled for all target domains'
    GetState  = {
        Get-SafeLinksRule -Identity $PolicyName -ErrorAction SilentlyContinue
    }
    TestState = {
        param($State)
        $null -ne $State -and $State.State -eq 'Enabled' -and (@($domains | Where-Object { @($State.RecipientDomainIs) -notcontains $_ }).Count -eq 0)
    }
    SetState  = {
        param($State)
        if ($null -eq $State) { New-SafeLinksRule -Name $PolicyName -SafeLinksPolicy $PolicyName -RecipientDomainIs $domains | Out-Null }
        else {
            Set-SafeLinksRule -Identity $PolicyName -RecipientDomainIs $domains
            if ($State.State -ne 'Enabled') { Enable-SafeLinksRule -Identity $PolicyName -Confirm:$false }
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
