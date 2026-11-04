<#
.SYNOPSIS
    Remediates SPO-SCRIPT-002: Ensure custom script execution is restricted on site collections
.DESCRIPTION
    Prevents users from running custom script on sites they create (self-service sites).

    Desired state: DenyAddAndCustomizePagesForSitesCreatedByUser = $true
    Requires: SharePoint Online (Connect-SPOService).

    Microsoft now resets custom script to blocked automatically; this sets the tenant default
    the assessment looks for.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SCRIPT-002.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/SharePoint/SPO-SCRIPT-002.ps1
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
    CheckId   = 'SPO-SCRIPT-002'
    Target    = 'SharePoint Online tenant settings'
    Desired   = 'DenyAddAndCustomizePagesForSitesCreatedByUser = $true'
    GetState  = {
        Get-SPOTenant
    }
    TestState = {
        param($State)
        Test-RemediationProperty -State $State -Expected @{
            DenyAddAndCustomizePagesForSitesCreatedByUser = $true
        }
    }
    SetState  = {
        param($State)
        $settings = @{
            DenyAddAndCustomizePagesForSitesCreatedByUser = $true
        }
        Set-SPOTenant @settings
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
