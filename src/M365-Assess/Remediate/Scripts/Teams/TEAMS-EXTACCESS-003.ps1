<#
.SYNOPSIS
    Remediates TEAMS-EXTACCESS-003: Ensure external domains are restricted in the Teams admin center
.DESCRIPTION
    Restricts Teams federation (external access) to an allow-list of domains, or turns it off.

    Desired state: Federation limited to -AllowedDomain, or disabled with -DisableFederation
    Requires: Microsoft Teams (Connect-MicrosoftTeams).

    The allow-list replaces any existing list; include every partner domain you need.
    Blocked-domain lists are cleared when switching to an allow-list.

    Triage bucket: Needs decision (Needs org-specific values).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER AllowedDomain
    External domains users may communicate with. Replaces the current allow-list.
.PARAMETER DisableFederation
    Turn off communication with all external Teams organizations.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-EXTACCESS-003.ps1 -AllowedDomain 'partner.example' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Teams/TEAMS-EXTACCESS-003.ps1 -AllowedDomain 'partner.example'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory, ParameterSetName = 'AllowList')]
    [ValidateNotNullOrEmpty()]
    [string[]]$AllowedDomain,

    [Parameter(Mandatory, ParameterSetName = 'Disable')]
    [switch]$DisableFederation
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Teams'

$step = @{
    CheckId   = 'TEAMS-EXTACCESS-003'
    Target    = 'Teams tenant federation configuration'
    Desired   = 'Federation restricted'
    GetState  = {
        Get-CsTenantFederationConfiguration -Identity Global
    }
    TestState = {
        param($State)
        if ($DisableFederation.IsPresent) {
            $State.AllowFederatedUsers -eq $false
        }
        else {
            $current = @($State.AllowedDomains.AllowedDomain | ForEach-Object { if ($_.Domain) { $_.Domain } else { "$_" } } | Sort-Object)
            $State.AllowFederatedUsers -eq $true -and ($current -join ',') -eq (@($AllowedDomain | Sort-Object) -join ',')
        }
    }
    SetState  = {
        param($State)
        if ($DisableFederation.IsPresent) {
            Set-CsTenantFederationConfiguration -Identity Global -AllowFederatedUsers $false
        }
        else {
            Set-CsTenantFederationConfiguration -Identity Global -AllowFederatedUsers $true -AllowedDomainsAsAList @($AllowedDomain)
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
