<#
.SYNOPSIS
    Remediates ENTRA-CONSENT-001: Ensure user consent to apps accessing company data on their behalf is not allowed
.DESCRIPTION
    Turns off user consent to applications, so only admins can grant apps access to company
    data.

    Desired state: No ManagePermissionGrantsForSelf.* policy assigned to users
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.Authorization.

    Resource-specific consent entries (ManagePermissionGrantsForOwnedResource.*) are kept.
    Users then request apps through the admin consent workflow (ENTRA-CONSENT-002).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-CONSENT-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-CONSENT-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.Authorization'

$step = @{
    CheckId   = 'ENTRA-CONSENT-001'
    Target    = 'Entra authorization policy (user consent)'
    Desired   = 'User consent off'
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/policies/authorizationPolicy'
    }
    TestState = {
        param($State)
        @($State['defaultUserRolePermissions']['permissionGrantPoliciesAssigned'] | Where-Object { "$_" -like 'ManagePermissionGrantsForSelf.*' }).Count -eq 0
    }
    SetState  = {
        param($State)
        # Keep resource-specific consent entries (ManagePermissionGrantsForOwnedResource.*); only user self-consent changes.
        $keep = @($State['defaultUserRolePermissions']['permissionGrantPoliciesAssigned'] | Where-Object { $_ -and "$_" -notlike 'ManagePermissionGrantsForSelf.*' })
        Set-RemediationGraphObject -Uri '/v1.0/policies/authorizationPolicy' -Body @{ defaultUserRolePermissions = @{ permissionGrantPoliciesAssigned = $keep } }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
