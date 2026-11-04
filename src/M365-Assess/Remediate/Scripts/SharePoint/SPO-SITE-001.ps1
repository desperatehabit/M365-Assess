<#
.SYNOPSIS
    Remediates SPO-SITE-001: Site sharing level within tenant policy
.DESCRIPTION
    Lowers the sharing level of any site that is more permissive than the tenant sharing level.

    Desired state: No site more permissive than the tenant
    Requires: SharePoint Online (Connect-SPOService).

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ExcludeSiteUrl
    Sites to leave as they are.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SITE-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SITE-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$ExcludeSiteUrl
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SharePoint'

$rank = @{ Disabled = 0; ExistingExternalUserSharingOnly = 1; ExternalUserSharingOnly = 2; ExternalUserAndGuestSharing = 3 }
$tenantLevel = "$((Get-SPOTenant).SharingCapability)"

$step = @{
    CheckId   = 'SPO-SITE-001'
    Target    = 'Sites above the tenant sharing level'
    Desired   = 'None'
    GetState  = {
        @(Get-SPOSite -Limit All | Where-Object {
            @($ExcludeSiteUrl) -notcontains $_.Url -and $null -ne $rank["$($_.SharingCapability)"] -and $rank["$($_.SharingCapability)"] -gt $rank[$tenantLevel]
        } | Select-Object -Property Url, Title, SharingCapability)
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($site in $State) { Set-SPOSite -Identity $site.Url -SharingCapability $tenantLevel }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
