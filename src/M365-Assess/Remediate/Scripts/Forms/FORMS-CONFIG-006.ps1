<#
.SYNOPSIS
    Remediates FORMS-CONFIG-006: Ensure Bing image and video search is disabled in Forms
.DESCRIPTION
    Sets isBingImageVideoSearchEnabled on the Microsoft Forms org settings (Graph beta admin/forms/settings).
    Form authors can no longer insert Bing images or YouTube videos.

    Desired state: isBingImageVideoSearchEnabled = $false
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: OrgSettings-Forms.ReadWrite.All.

    Uses a Microsoft Graph beta endpoint; behavior can change without notice.

    Triage bucket: Scriptable (Tenant setting (beta API)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Forms/FORMS-CONFIG-006.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Forms/FORMS-CONFIG-006.ps1
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
    'isBingImageVideoSearchEnabled' = $false
}
$body = @{
    isBingImageVideoSearchEnabled = $false
}

$step = @{
    CheckId   = 'FORMS-CONFIG-006'
    Target    = 'Microsoft Forms org settings'
    Desired   = 'isBingImageVideoSearchEnabled = $false'
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
