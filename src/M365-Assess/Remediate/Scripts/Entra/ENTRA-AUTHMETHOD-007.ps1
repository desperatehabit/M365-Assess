<#
.SYNOPSIS
    Remediates ENTRA-AUTHMETHOD-007: Ensure Temporary Access Pass authentication method is enabled
.DESCRIPTION
    Turns on the Temporary Access Pass method for onboarding and recovery, single-use with a
    short lifetime, for all users or the groups you choose.

    Desired state: TemporaryAccessPass enabled, single-use, 1-8 hour lifetime
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.AuthenticationMethod.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER IncludeGroupId
    Groups allowed to use a TAP. Defaults to all users.
.PARAMETER DefaultLifetimeMinutes
    Default TAP lifetime (60-480 minutes).
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-AUTHMETHOD-007.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-AUTHMETHOD-007.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [string[]]$IncludeGroupId,

    [Parameter()]
    [ValidateRange(60, 480)]
    [int]$DefaultLifetimeMinutes = 60
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'Policy.ReadWrite.AuthenticationMethod'

$targets = if (@($IncludeGroupId | Where-Object { $_ }).Count -gt 0) {
    @($IncludeGroupId | ForEach-Object { @{ targetType = 'group'; id = $_; isRegistrationRequired = $false } })
}
else {
    @(@{ targetType = 'group'; id = 'all_users'; isRegistrationRequired = $false })
}

$step = @{
    CheckId   = 'ENTRA-AUTHMETHOD-007'
    Target    = 'Authentication method TemporaryAccessPass'
    Desired   = 'Enabled, single-use'
    GetState  = {
        Get-RemediationGraphObject -Uri '/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/TemporaryAccessPass'
    }
    TestState = {
        param($State)
        $State['state'] -eq 'enabled' -and $State['isUsableOnce'] -eq $true -and [int]$State['maximumLifetimeInMinutes'] -le 480
    }
    SetState  = {
        param($State)
        $body = @{
            '@odata.type'            = '#microsoft.graph.temporaryAccessPassAuthenticationMethodConfiguration'
            state                    = 'enabled'
            isUsableOnce             = $true
            defaultLifetimeInMinutes = $DefaultLifetimeMinutes
            minimumLifetimeInMinutes = 60
            maximumLifetimeInMinutes = 480
            includeTargets           = $targets
        }
        Set-RemediationGraphObject -Uri '/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/TemporaryAccessPass' -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
