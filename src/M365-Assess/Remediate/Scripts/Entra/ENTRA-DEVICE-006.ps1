<#
.SYNOPSIS
    Remediates ENTRA-DEVICE-006: Ensure users are restricted from recovering BitLocker keys
.DESCRIPTION
    Stops users from reading the BitLocker recovery keys of devices they own; recovery goes
    through the helpdesk instead.

    Desired state: defaultUserRolePermissions.allowedToReadBitlockerKeysForOwnedDevice = $false
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.Authorization.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-DEVICE-006.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-DEVICE-006.ps1
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

$expected = @{
    'defaultUserRolePermissions.allowedToReadBitlockerKeysForOwnedDevice' = $false
}
$body = @{
    defaultUserRolePermissions = @{
        allowedToReadBitlockerKeysForOwnedDevice = $false
    }
}

$step = @{
    CheckId   = 'ENTRA-DEVICE-006'
    Target    = 'Entra authorization policy'
    Desired   = 'defaultUserRolePermissions.allowedToReadBitlockerKeysForOwnedDevice = $false'
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/policies/authorizationPolicy'
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected $expected
    }
    SetState  = {
        param($State)
        Set-RemediationGraphObject -Uri '/v1.0/policies/authorizationPolicy' -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
