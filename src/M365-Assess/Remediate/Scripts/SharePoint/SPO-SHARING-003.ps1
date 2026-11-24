<#
.SYNOPSIS
    Remediates SPO-SHARING-003: Ensure SharePoint external sharing is managed through domain whitelist/blacklists
.DESCRIPTION
    Limits SharePoint and OneDrive external sharing to an allow-list of domains, or blocks a
    list of domains.

    Desired state: SharingDomainRestrictionMode set with the given list
    Requires: SharePoint Online (Connect-SPOService).

    Triage bucket: Needs decision (Needs org-specific values).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER AllowedDomain
    Only these external domains can be shared with. Replaces the current list.
.PARAMETER BlockedDomain
    These external domains can never be shared with. Replaces the current list.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SHARING-003.ps1 -AllowedDomain 'partner.example' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SHARING-003.ps1 -AllowedDomain 'partner.example'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory, ParameterSetName = 'Allow')]
    [ValidateNotNullOrEmpty()]
    [string[]]$AllowedDomain,

    [Parameter(Mandatory, ParameterSetName = 'Block')]
    [ValidateNotNullOrEmpty()]
    [string[]]$BlockedDomain
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SharePoint'

$parameterSet = $PSCmdlet.ParameterSetName

$step = @{
    CheckId   = 'SPO-SHARING-003'
    Target    = 'SharePoint Online sharing domain restriction'
    Desired   = 'Allow or block list configured'
    GetState  = {
        Get-SPOTenant
    }
    TestState = {
        param($State)
        if ($parameterSet -eq 'Allow') {
            "$($State.SharingDomainRestrictionMode)" -eq 'AllowList' -and ((@("$($State.SharingAllowedDomainList)" -split ' ' | Where-Object { $_ } | Sort-Object) -join ' ') -eq (@($AllowedDomain | Sort-Object) -join ' '))
        }
        else {
            "$($State.SharingDomainRestrictionMode)" -eq 'BlockList' -and ((@("$($State.SharingBlockedDomainList)" -split ' ' | Where-Object { $_ } | Sort-Object) -join ' ') -eq (@($BlockedDomain | Sort-Object) -join ' '))
        }
    }
    SetState  = {
        param($State)
        if ($parameterSet -eq 'Allow') {
            Set-SPOTenant -SharingDomainRestrictionMode AllowList -SharingAllowedDomainList (@($AllowedDomain) -join ' ')
        }
        else {
            Set-SPOTenant -SharingDomainRestrictionMode BlockList -SharingBlockedDomainList (@($BlockedDomain) -join ' ')
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
