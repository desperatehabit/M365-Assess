<#
.SYNOPSIS
    Remediates ENTRA-SSPR-002: SSPR enabled for admin accounts
.DESCRIPTION
    Turns off self-service password reset for administrator accounts. Admin password resets then
    follow your helpdesk / PIM process.

    Desired state: allowedToUseSSPR = $false
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: Policy.ReadWrite.Authorization.

    Applies to admin roles only; user SSPR is unchanged. Make sure admins have another reset path
    (another admin, or break-glass accounts) before running.

    Triage bucket: Needs decision (Limited API).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-SSPR-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-SSPR-002.ps1
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
    'allowedToUseSSPR' = $false
}
$body = @{
    allowedToUseSSPR = $false
}

$step = @{
    CheckId   = 'ENTRA-SSPR-002'
    Target    = 'Entra authorization policy'
    Desired   = 'allowedToUseSSPR = $false'
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
