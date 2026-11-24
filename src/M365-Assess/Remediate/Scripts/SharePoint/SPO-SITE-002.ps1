<#
.SYNOPSIS
    Remediates SPO-SITE-002: Sensitive sites have restricted external sharing
.DESCRIPTION
    Restricts external sharing on sensitive sites (named with HR, Finance, Legal, Payroll, and
    similar keywords, or listed explicitly) to existing guests, or turns it off.

    Desired state: Sensitive sites at -SharingLevel or stricter
    Requires: SharePoint Online (Connect-SPOService).

    Keyword matching is broad ("Board" also matches "Dashboard"); run with -WhatIf and review
    Before, then use -ExcludeSiteUrl for false positives.

    Triage bucket: Needs decision (Per-object review).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER SharingLevel
    Sharing level for sensitive sites.
.PARAMETER SiteUrl
    Sites to treat as sensitive in addition to the keyword match.
.PARAMETER Keyword
    Title keywords that mark a site as sensitive. Defaults to the assessment's list.
.PARAMETER ExcludeSiteUrl
    Sites to leave as they are even if they match.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SITE-002.ps1 -SharingLevel ExistingExternalUserSharingOnly -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SITE-002.ps1 -SharingLevel ExistingExternalUserSharingOnly
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
    [string[]]$SiteUrl,

    [Parameter()]
    [string[]]$Keyword = @('HR', 'Human Resources', 'Finance', 'Legal', 'Payroll', 'Executive', 'Board', 'Confidential', 'Compliance'),

    [Parameter()]
    [string[]]$ExcludeSiteUrl
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SharePoint'

$rank = @{ Disabled = 0; ExistingExternalUserSharingOnly = 1; ExternalUserSharingOnly = 2; ExternalUserAndGuestSharing = 3 }

$step = @{
    CheckId   = 'SPO-SITE-002'
    Target    = 'Sensitive sites with external sharing'
    Desired   = "$SharingLevel or stricter"
    GetState  = {
        @(Get-SPOSite -Limit All | Where-Object {
            $title = "$($_.Title)"
            $isSensitive = @($SiteUrl) -contains $_.Url -or @($Keyword | Where-Object { $title -match [regex]::Escape($_) }).Count -gt 0
            $isSensitive -and @($ExcludeSiteUrl) -notcontains $_.Url -and $rank["$($_.SharingCapability)"] -gt $rank[$SharingLevel]
        } | Select-Object -Property Url, Title, SharingCapability)
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($site in $State) { Set-SPOSite -Identity $site.Url -SharingCapability $SharingLevel }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
