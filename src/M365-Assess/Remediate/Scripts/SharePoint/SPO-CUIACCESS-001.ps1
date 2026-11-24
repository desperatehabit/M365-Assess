<#
.SYNOPSIS
    Remediates SPO-CUIACCESS-001: Ensure SharePoint External Sharing Restricts Access to CUI on Digital Media
.DESCRIPTION
    Restricts external sharing so CUI cannot leave the organization: sets the tenant sharing level
    and, optionally, turns off external sharing on the sites that hold CUI.

    Desired state: Tenant sharing at -SharingLevel; CUI sites Disabled
    Requires: SharePoint Online (Connect-SPOService).

    Apply sensitivity labels and Conditional Access to the CUI sites as well; sharing settings
    alone are not a complete CUI control.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER SharingLevel
    Tenant-wide sharing level: existing guests only, or no external sharing.
.PARAMETER CuiSiteUrl
    URLs of sites holding CUI. Their external sharing is turned off.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-CUIACCESS-001.ps1 -SharingLevel ExistingExternalUserSharingOnly -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-CUIACCESS-001.ps1 -SharingLevel ExistingExternalUserSharingOnly
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateSet('ExistingExternalUserSharingOnly', 'Disabled')]
    [string]$SharingLevel,

    [Parameter()]
    [string[]]$CuiSiteUrl
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SharePoint'

$step1 = @{
    CheckId   = 'SPO-CUIACCESS-001'
    Target    = 'SharePoint Online tenant sharing level'
    Desired   = "$SharingLevel or stricter"
    GetState  = {
        Get-SPOTenant
    }
    TestState = {
        param($State)
        $rank = @{ Disabled = 0; ExistingExternalUserSharingOnly = 1; ExternalUserSharingOnly = 2; ExternalUserAndGuestSharing = 3 }
        $null -ne $rank["$($State.SharingCapability)"] -and $rank["$($State.SharingCapability)"] -le $rank[$SharingLevel]
    }
    SetState  = {
        param($State)
        Set-SPOTenant -SharingCapability $SharingLevel
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'SPO-CUIACCESS-001'
    Target    = 'CUI sites'
    Desired   = 'External sharing disabled'
    GetState  = {
        @(foreach ($url in @($CuiSiteUrl | Where-Object { $_ })) { Get-SPOSite -Identity $url | Where-Object { "$($_.SharingCapability)" -ne 'Disabled' } | Select-Object -Property Url, SharingCapability })
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($site in $State) { Set-SPOSite -Identity $site.Url -SharingCapability Disabled }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
