<#
.SYNOPSIS
    Remediates SPO-SCRIPT-001: Ensure custom script execution is restricted on personal sites
.DESCRIPTION
    Blocks custom script (DenyAddAndCustomizePages) on every OneDrive personal site that allows it.

    Desired state: DenyAddAndCustomizePages = Enabled on all personal sites
    Requires: SharePoint Online (Connect-SPOService).

    Enumerates every OneDrive site, which can take a while in large tenants.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SCRIPT-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SCRIPT-001.ps1
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
    CheckId   = 'SPO-SCRIPT-001'
    Target    = 'OneDrive personal sites allowing custom script'
    Desired   = 'None'
    GetState  = {
        @(Get-SPOSite -IncludePersonalSite $true -Limit All -Filter "Url -like '-my.sharepoint.com/personal/'" |
            Where-Object { @('Enabled', 'True') -notcontains "$($_.DenyAddAndCustomizePages)" } |
            Select-Object -Property Url, DenyAddAndCustomizePages)
    }
    TestState = {
        param($State)
        $null -eq $State -or @($State).Count -eq 0
    }
    SetState  = {
        param($State)
        foreach ($site in $State) {
            Set-SPOSite -Identity $site.Url -DenyAddAndCustomizePages $true
        }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
