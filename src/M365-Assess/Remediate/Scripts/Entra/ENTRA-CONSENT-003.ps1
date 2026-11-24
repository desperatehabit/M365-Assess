<#
.SYNOPSIS
    Remediates ENTRA-CONSENT-003: User consent restricted to verified publishers only
.DESCRIPTION
    Limits user consent to apps from verified publishers requesting low-impact permissions, or
    turns user consent off entirely.

    Desired state: User consent off, or only microsoft-user-default-low
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.Authorization.

    The assessment check compares the policy list to the short name "microsoft-user-default-low"
    while Graph returns "ManagePermissionGrantsForSelf.microsoft-user-default-low", so only Block
    is currently recognized as passing; VerifiedPublishersLowRisk is still the CIS-acceptable option.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Mode
    Block (default): no user consent. VerifiedPublishersLowRisk: users may consent to
    verified-publisher apps asking for low-impact permissions.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-CONSENT-003.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-CONSENT-003.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateSet('Block', 'VerifiedPublishersLowRisk')]
    [string]$Mode = 'Block'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.Authorization'

$wanted = if ($Mode -eq 'Block') { @() } else { @('ManagePermissionGrantsForSelf.microsoft-user-default-low') }

$step = @{
    CheckId   = 'ENTRA-CONSENT-003'
    Target    = 'Entra authorization policy (user consent)'
    Desired   = "User consent: $Mode"
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/policies/authorizationPolicy'
    }
    TestState = {
        param($State)
        $self = @($State['defaultUserRolePermissions']['permissionGrantPoliciesAssigned'] | Where-Object { "$_" -like 'ManagePermissionGrantsForSelf.*' } | Sort-Object)
        ($self -join ',') -eq (@($wanted | Sort-Object) -join ',')
    }
    SetState  = {
        param($State)
        # Keep resource-specific consent entries (ManagePermissionGrantsForOwnedResource.*); only user self-consent changes.
        $keep = @($State['defaultUserRolePermissions']['permissionGrantPoliciesAssigned'] | Where-Object { $_ -and "$_" -notlike 'ManagePermissionGrantsForSelf.*' })
        Set-RemediationGraphObject -Uri '/v1.0/policies/authorizationPolicy' -Body @{ defaultUserRolePermissions = @{ permissionGrantPoliciesAssigned = @($keep + $wanted) } }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
