<#
.SYNOPSIS
    Remediates POWERBI-INFOPROT-001: Ensure 'Allow users to apply sensitivity labels for content' is 'Enabled' in Power BI
.DESCRIPTION
    Updates the Fabric tenant setting 'UseSensitivityLabels' through the Fabric admin API.
    Users can apply sensitivity labels to Power BI content.

    Desired state: UseSensitivityLabels enabled = True
    Requires: Power BI (Connect-PowerBIServiceAccount) as a Fabric administrator.

    Labels must also be published to Power BI users from the Microsoft Purview portal.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER SettingName
    Fabric tenant setting name. Defaults to 'UseSensitivityLabels', the name the Power BI collector reads.
    Override if your tenant lists the setting under a different name.
.EXAMPLE
    PS> ./Remediate/Scripts/PowerBI/POWERBI-INFOPROT-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/PowerBI/POWERBI-INFOPROT-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$SettingName = 'UseSensitivityLabels'
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'PowerBI'

$step = @{
    CheckId   = 'POWERBI-INFOPROT-001'
    Target    = "Fabric tenant setting $SettingName"
    Desired   = 'UseSensitivityLabels enabled = True'
    GetState  = {
        Get-PowerBITenantSettingState -SettingName $SettingName
    }
    TestState = {
        param($State)
        $State.enabled -eq $true
    }
    SetState  = {
        param($State)
        Set-PowerBITenantSettingState -SettingName $SettingName -Enabled $true
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
