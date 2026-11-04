<#
.SYNOPSIS
    Remediates SPO-LOOP-002: OneDrive Loop Sharing
.DESCRIPTION
    Limits sharing of Loop workspaces and components stored in OneDrive to existing guests.
    A stricter existing value (Disabled) is kept.

    Desired state: OneDriveLoopSharingCapability = 'ExistingExternalUserSharingOnly'
    Requires: SharePoint Online (Connect-SPOService).

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-LOOP-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-LOOP-002.ps1
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
    CheckId   = 'SPO-LOOP-002'
    Target    = 'SharePoint Online tenant settings'
    Desired   = 'OneDriveLoopSharingCapability = ''ExistingExternalUserSharingOnly'''
    GetState  = {
        Get-SPOTenant
    }
    TestState = {
        param($State)
        @('Disabled', 'ExistingExternalUserSharingOnly') -contains "$($State.OneDriveLoopSharingCapability)"
    }
    SetState  = {
        param($State)
        $settings = @{
            OneDriveLoopSharingCapability = 'ExistingExternalUserSharingOnly'
        }
        Set-SPOTenant @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
