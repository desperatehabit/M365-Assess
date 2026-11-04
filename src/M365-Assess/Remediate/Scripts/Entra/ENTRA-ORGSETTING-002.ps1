<#
.SYNOPSIS
    Remediates ENTRA-ORGSETTING-002: Ensure internal phishing protection for Forms is enabled
.DESCRIPTION
    Turns on internal phishing protection in Microsoft Forms.

    Desired state: isPhishingScanEnabled = $true
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: OrgSettings-Forms.ReadWrite.All.

    Same setting as FORMS-CONFIG-004. Uses a Graph beta endpoint.

    Triage bucket: Scriptable (Tenant setting (beta API)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-ORGSETTING-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Entra/ENTRA-ORGSETTING-002.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'OrgSettings-Forms.ReadWrite.All'

$expected = @{
    'isPhishingScanEnabled' = $true
}
$body = @{
    isPhishingScanEnabled = $true
}

$step = @{
    CheckId   = 'ENTRA-ORGSETTING-002'
    Target    = 'Microsoft Forms org settings'
    Desired   = 'isPhishingScanEnabled = $true'
    GetState  = {
        Get-RemediationGraphObject -Uri '/beta/admin/forms/settings'
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected $expected
    }
    SetState  = {
        param($State)
        Set-RemediationGraphObject -Uri '/beta/admin/forms/settings' -Body $body
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
