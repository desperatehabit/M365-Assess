<#
.SYNOPSIS
    Remediates ENTRA-APPS-003: Ensure legacy MSOL and Azure AD PowerShell module access is blocked
.DESCRIPTION
    Blocks the legacy MSOnline and AzureAD PowerShell modules for non-admin users.

    Desired state: blockMsolPowerShell = $true
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.Authorization.

    Scripts still using those modules must move to the Microsoft Graph PowerShell SDK.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-APPS-003.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-APPS-003.ps1
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
    'blockMsolPowerShell' = $true
}
$body = @{
    blockMsolPowerShell = $true
}

$step = @{
    CheckId   = 'ENTRA-APPS-003'
    Target    = 'Entra authorization policy'
    Desired   = 'blockMsolPowerShell = $true'
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
