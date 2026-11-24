<#
.SYNOPSIS
    Remediates ENTRA-AUTHMETHOD-001: Ensure weak authentication methods are disabled
.DESCRIPTION
    Turns off SMS and voice call as authentication methods (vulnerable to SIM swapping).

    Desired state: Sms and Voice methods disabled
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.AuthenticationMethod.

    Users who only have SMS or voice registered lose their MFA method and are prompted to
    register another one. Run a registration campaign (ENTRA-MFA-001) first, and check the
    authentication methods activity report for SMS-only users.

    Triage bucket: Needs decision (User-impacting setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER KeepVoice
    Only disable SMS; leave voice call as it is.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-AUTHMETHOD-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-AUTHMETHOD-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [switch]$KeepVoice
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.AuthenticationMethod'

$step1 = @{
    CheckId   = 'ENTRA-AUTHMETHOD-001'
    Target    = 'Authentication method Sms'
    Desired   = 'state = ''disabled'''
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/Sms'
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            'state' = 'disabled'
        }
    }
    SetState  = {
        param($State)
        $body = @{
            '@odata.type' = '#microsoft.graph.smsAuthenticationMethodConfiguration'
            state = 'disabled'
        }
        Set-RemediationGraphObject -Uri '/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/Sms' -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step1

$step2 = @{
    CheckId   = 'ENTRA-AUTHMETHOD-001'
    Target    = 'Authentication method Voice'
    Desired   = 'state = ''disabled'''
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/Voice'
    }
    TestState = {
        param($State)
        $KeepVoice.IsPresent -or $State['state'] -eq 'disabled'
    }
    SetState  = {
        param($State)
        $body = @{
            '@odata.type' = '#microsoft.graph.voiceAuthenticationMethodConfiguration'
            state = 'disabled'
        }
        Set-RemediationGraphObject -Uri '/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/Voice' -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step2
