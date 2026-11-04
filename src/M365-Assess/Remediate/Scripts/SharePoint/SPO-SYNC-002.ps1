<#
.SYNOPSIS
    Remediates SPO-SYNC-002: Mac Sync App Enabled
.DESCRIPTION
    Turns off the OneDrive sync app on Mac.

    Desired state: BlockMacSync = True
    Requires: SharePoint Online (Connect-SPOService).

    Mac users can still use OneDrive and SharePoint on the web. Only run this if Macs are not
    used, or are not allowed to hold synced copies of company data.

    Triage bucket: Needs decision (Business preference).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SYNC-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SYNC-002.ps1
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
    CheckId   = 'SPO-SYNC-002'
    Target    = 'OneDrive sync client restriction (Mac)'
    Desired   = 'Mac sync blocked'
    GetState  = {
        Get-SPOTenantSyncClientRestriction
    }
    TestState = {
        param($State)
        $State.BlockMacSync -eq $true
    }
    SetState  = {
        param($State)
        Set-SPOTenantSyncClientRestriction -BlockMacSync:$true
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
