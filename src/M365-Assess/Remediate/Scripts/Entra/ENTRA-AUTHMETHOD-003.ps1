<#
.SYNOPSIS
    Remediates ENTRA-AUTHMETHOD-003: Ensure Microsoft Authenticator is configured to protect against MFA fatigue
.DESCRIPTION
    Shows the application name and sign-in location in Microsoft Authenticator push requests
    (number matching is always on), to protect against MFA fatigue.

    Desired state: featureSettings.displayAppInformationRequiredState.state = 'enabled', featureSettings.displayLocationInformationRequiredState.state = 'enabled'
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.AuthenticationMethod.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-AUTHMETHOD-003.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-AUTHMETHOD-003.ps1
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
    'featureSettings.displayAppInformationRequiredState.state' = 'enabled'
    'featureSettings.displayLocationInformationRequiredState.state' = 'enabled'
}
$body = @{
    '@odata.type' = '#microsoft.graph.microsoftAuthenticatorAuthenticationMethodConfiguration'
    featureSettings = @{
        displayAppInformationRequiredState = @{
            state = 'enabled'
            includeTarget = @{
                targetType = 'group'
                id = 'all_users'
            }
        }
        displayLocationInformationRequiredState = @{
            state = 'enabled'
            includeTarget = @{
                targetType = 'group'
                id = 'all_users'
            }
        }
    }
}

$step = @{
    CheckId   = 'ENTRA-AUTHMETHOD-003'
    Target    = 'Authentication method MicrosoftAuthenticator'
    Desired   = 'featureSettings.displayAppInformationRequiredState.state = ''enabled'', featureSettings.displayLocationInformationRequiredState.state = ''enabled'''
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/MicrosoftAuthenticator'
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected $expected
    }
    SetState  = {
        param($State)
        Set-RemediationGraphObject -Uri '/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/MicrosoftAuthenticator' -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
