<#
.SYNOPSIS
    Remediates SPO-LOOP-001: Loop Components Enabled
.DESCRIPTION
    Turns off Loop components in SharePoint, OneDrive, Outlook, and Teams.

    Desired state: IsLoopEnabled = $false
    Requires: SharePoint Online (Connect-SPOService).

    A business decision: Loop components stop working for everyone. Existing .loop files
    remain as files.

    Triage bucket: Needs decision (Business preference).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-LOOP-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-LOOP-001.ps1
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
    CheckId   = 'SPO-LOOP-001'
    Target    = 'SharePoint Online tenant settings'
    Desired   = 'IsLoopEnabled = $false'
    GetState  = {
        Get-SPOTenant
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            IsLoopEnabled = $false
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            IsLoopEnabled = $false
        }
        Set-SPOTenant @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
