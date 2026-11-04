<#
.SYNOPSIS
    Remediates ENTRA-AUTHMETHOD-004: Ensure system-preferred multifactor authentication is enabled
.DESCRIPTION
    Turns on system-preferred MFA, so users are prompted for their strongest registered method.

    Desired state: systemCredentialPreferences.state = 'enabled'
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.AuthenticationMethod.

    Uses the Graph beta authentication methods policy.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-AUTHMETHOD-004.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-AUTHMETHOD-004.ps1
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
    'systemCredentialPreferences.state' = 'enabled'
}
$body = @{
    systemCredentialPreferences = @{
        state = 'enabled'
        includeTargets = @(@{
    targetType = 'group'
    id = 'all_users'
})
        excludeTargets = @()
    }
}

$step = @{
    CheckId   = 'ENTRA-AUTHMETHOD-004'
    Target    = 'Authentication methods policy (system-preferred MFA)'
    Desired   = 'systemCredentialPreferences.state = ''enabled'''
    GetState  = {
        Get-RemediationGraphObject -Uri '/beta/policies/authenticationMethodsPolicy'
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected $expected
    }
    SetState  = {
        param($State)
        Set-RemediationGraphObject -Uri '/beta/policies/authenticationMethodsPolicy' -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
