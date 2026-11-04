<#
.SYNOPSIS
    Remediates SPO-SHARING-008: Ensure external sharing is restricted by security group
.DESCRIPTION
    Allows only members of the security groups you list to share SharePoint and OneDrive content
    externally.

    Desired state: External sharing limited to -SecurityGroupId
    Requires: SharePoint Online (Connect-SPOService).

    Uses GuestSharingGroupAllowListInTenantByPrincipalIdentity, which takes claims in the form
    c:0t.c|tenant|<group id>. Everyone outside the groups loses the ability to share externally.

    Triage bucket: Needs decision (Needs org-specific values).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER SecurityGroupId
    Object IDs of the Entra security groups allowed to share externally.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SHARING-008.ps1 -SecurityGroupId '11111111-2222-3333-4444-555555555555' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SHARING-008.ps1 -SecurityGroupId '11111111-2222-3333-4444-555555555555'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [guid[]]$SecurityGroupId
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SharePoint'

$claims = @($SecurityGroupId | ForEach-Object { "c:0t.c|tenant|$_" })

$step = @{
    CheckId   = 'SPO-SHARING-008'
    Target    = 'SharePoint Online external sharing group allow-list'
    Desired   = 'Limited to the given groups'
    GetState  = {
        Get-SPOTenant
    }
    TestState = {
        param($State)
        $current = @($State.GuestSharingGroupAllowListInTenantByPrincipalIdentity | Where-Object { $_ })
        $current.Count -gt 0 -and @($claims | Where-Object { $current -notcontains $_ }).Count -eq 0
    }
    SetState  = {
        param($State)
        Set-SPOTenant -GuestSharingGroupAllowListInTenantByPrincipalIdentity $claims
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
