<#
.SYNOPSIS
    Remediates ENTRA-AUTHMETHOD-002: Ensure the email OTP authentication method is disabled
.DESCRIPTION
    Turns off email one-time passcode as an authentication method.

    Desired state: state = 'disabled'
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.AuthenticationMethod.

    Guests who redeem invitations with an email one-time passcode (no Microsoft or Entra account)
    are also affected; check External collaboration settings before running.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-AUTHMETHOD-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-AUTHMETHOD-002.ps1
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
    'state' = 'disabled'
}
$body = @{
    '@odata.type' = '#microsoft.graph.emailAuthenticationMethodConfiguration'
    state = 'disabled'
}

$step = @{
    CheckId   = 'ENTRA-AUTHMETHOD-002'
    Target    = 'Authentication method Email'
    Desired   = 'state = ''disabled'''
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/Email'
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected $expected
    }
    SetState  = {
        param($State)
        Set-RemediationGraphObject -Uri '/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/Email' -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
