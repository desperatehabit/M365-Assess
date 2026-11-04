<#
.SYNOPSIS
    Remediates FORMS-CONFIG-001: Ensure external users cannot respond to Microsoft Forms
.DESCRIPTION
    Sets isExternalSendFormEnabled on the Microsoft Forms org settings (Graph beta admin/forms/settings).
    People outside the organization can no longer respond to forms.

    Desired state: isExternalSendFormEnabled = $false
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: OrgSettings-Forms.ReadWrite.All.

    Uses a Microsoft Graph beta endpoint; behavior can change without notice.

    Triage bucket: Scriptable (Tenant setting (beta API)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Forms/FORMS-CONFIG-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Forms/FORMS-CONFIG-001.ps1
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
    'isExternalSendFormEnabled' = $false
}
$body = @{
    isExternalSendFormEnabled = $false
}

$step = @{
    CheckId   = 'FORMS-CONFIG-001'
    Target    = 'Microsoft Forms org settings'
    Desired   = 'isExternalSendFormEnabled = $false'
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
