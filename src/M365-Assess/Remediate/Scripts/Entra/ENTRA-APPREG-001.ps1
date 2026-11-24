<#
.SYNOPSIS
    Remediates ENTRA-APPREG-001: Users Can Register Applications
.DESCRIPTION
    Stops non-admin users from registering applications.

    Desired state: defaultUserRolePermissions.allowedToCreateApps = $false
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.Authorization.

    Developers then need the Application Developer role (or an admin) to register apps.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-APPREG-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-APPREG-001.ps1
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
    'defaultUserRolePermissions.allowedToCreateApps' = $false
}
$body = @{
    defaultUserRolePermissions = @{
        allowedToCreateApps = $false
    }
}

$step = @{
    CheckId   = 'ENTRA-APPREG-001'
    Target    = 'Entra authorization policy'
    Desired   = 'defaultUserRolePermissions.allowedToCreateApps = $false'
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
