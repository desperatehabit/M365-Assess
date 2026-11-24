<#
.SYNOPSIS
    Remediates SPO-SHARING-002: Ensure that SharePoint guest users cannot share items they don't own
.DESCRIPTION
    Stops guests from re-sharing items they do not own.

    Desired state: PreventExternalUsersFromResharing = $true
    Requires: SharePoint Online (Connect-SPOService).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SHARING-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SHARING-002.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'SharePoint'

$step = @{
    CheckId   = 'SPO-SHARING-002'
    Target    = 'SharePoint Online tenant settings'
    Desired   = 'PreventExternalUsersFromResharing = $true'
    GetState  = {
        Get-SPOTenant
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            PreventExternalUsersFromResharing = $true
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            PreventExternalUsersFromResharing = $true
        }
        Set-SPOTenant @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
