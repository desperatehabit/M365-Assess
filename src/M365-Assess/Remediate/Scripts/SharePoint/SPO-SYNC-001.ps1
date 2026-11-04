<#
.SYNOPSIS
    Remediates SPO-SYNC-001: Ensure OneDrive sync is restricted for unmanaged devices
.DESCRIPTION
    Restricts the OneDrive sync app to computers joined to the domains you list.

    Desired state: Sync client restriction enabled for -DomainGuid
    Requires: SharePoint Online (Connect-SPOService).

    Users on personal or Entra-only-joined devices can no longer sync. For Entra-joined fleets,
    use a Conditional Access app-enforced restriction instead.

    Triage bucket: Needs decision (Needs org-specific values).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER DomainGuid
    GUIDs of the on-premises AD domains whose joined computers may sync
    ((Get-ADDomain).ObjectGUID). Hybrid-joined devices only.
.PARAMETER BlockMacSync
    Also block the OneDrive sync app on Mac, which cannot be domain-restricted.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SYNC-001.ps1 -DomainGuid '11111111-2222-3333-4444-555555555555' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SYNC-001.ps1 -DomainGuid '11111111-2222-3333-4444-555555555555'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [guid[]]$DomainGuid,

    [Parameter()]
    [switch]$BlockMacSync
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SharePoint'

$step = @{
    CheckId   = 'SPO-SYNC-001'
    Target    = 'OneDrive sync client restriction'
    Desired   = 'Enabled for listed domains'
    GetState  = {
        Get-SPOTenantSyncClientRestriction
    }
    TestState = {
        param($State)
        $allowed = @("$($State.AllowedDomainList)" -split '[ ,;]' | Where-Object { $_ })
        $State.TenantRestrictionEnabled -eq $true -and @($DomainGuid | Where-Object { $allowed -notcontains "$_" }).Count -eq 0 -and (-not $BlockMacSync.IsPresent -or $State.BlockMacSync -eq $true)
    }
    SetState  = {
        param($State)
        Set-SPOTenantSyncClientRestriction -Enable -DomainGuids (@($DomainGuid) -join ';')
        if ($BlockMacSync.IsPresent) { Set-SPOTenantSyncClientRestriction -BlockMacSync:$true }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
