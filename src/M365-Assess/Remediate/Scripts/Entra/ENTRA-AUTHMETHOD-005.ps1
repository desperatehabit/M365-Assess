<#
.SYNOPSIS
    Remediates ENTRA-AUTHMETHOD-005: Ensure authentication methods policy is fully migrated to the converged policy
.DESCRIPTION
    Marks the authentication methods migration complete, so methods are managed only in the
    Authentication methods policy.

    Desired state: policyMigrationState = 'migrationComplete'
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.AuthenticationMethod.

    After this, the legacy per-user MFA and SSPR method settings stop applying. Check that every
    method you rely on is enabled in the Authentication methods policy first.

    Triage bucket: Needs decision (User-impacting setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-AUTHMETHOD-005.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-AUTHMETHOD-005.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.AuthenticationMethod'

$expected = @{
    'policyMigrationState' = 'migrationComplete'
}
$body = @{
    policyMigrationState = 'migrationComplete'
}

$step = @{
    CheckId   = 'ENTRA-AUTHMETHOD-005'
    Target    = 'Authentication methods policy (migration state)'
    Desired   = 'policyMigrationState = ''migrationComplete'''
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/policies/authenticationMethodsPolicy'
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected $expected
    }
    SetState  = {
        param($State)
        Set-RemediationGraphObject -Uri '/v1.0/policies/authenticationMethodsPolicy' -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
