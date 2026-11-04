<#
.SYNOPSIS
    Remediates ENTRA-MFA-001: Ensure all member users are 'MFA capable'
.DESCRIPTION
    Turns on the Microsoft Authenticator registration campaign for all users so every member user becomes MFA capable.

    Desired state: registrationEnforcement.authenticationMethodsRegistrationCampaign.state = 'enabled'
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.AuthenticationMethod.

    Users can snooze the prompt once a day, up to three times, before registration is required.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-MFA-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-MFA-001.ps1
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
    'registrationEnforcement.authenticationMethodsRegistrationCampaign.state' = 'enabled'
}
$body = @{
    registrationEnforcement = @{
        authenticationMethodsRegistrationCampaign = @{
            state = 'enabled'
            snoozeDurationInDays = 1
            enforceRegistrationAfterAllowedSnoozes = $true
            includeTargets = @(@{
    id = 'all_users'
    targetType = 'group'
    targetedAuthenticationMethod = 'microsoftAuthenticator'
})
            excludeTargets = @()
        }
    }
}

$step = @{
    CheckId   = 'ENTRA-MFA-001'
    Target    = 'Authentication methods registration campaign'
    Desired   = 'registrationEnforcement.authenticationMethodsRegistrationCampaign.state = ''enabled'''
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
