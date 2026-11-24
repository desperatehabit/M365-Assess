<#
.SYNOPSIS
    Remediates INTUNE-COMPLIANCE-001: Ensure devices without a compliance policy are marked 'not compliant'
.DESCRIPTION
    Marks devices with no compliance policy assigned as Not compliant, and sets the compliance
    validity period to 30 days or fewer.

    Desired state: secureByDefault = true; deviceComplianceCheckinThresholdDays <= 30
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DeviceManagementServiceConfig.ReadWrite.All.

    Devices that have no compliance policy become non-compliant and are blocked by any CA policy
    requiring compliant devices. Assign compliance policies to every platform first.

    Triage bucket: Scriptable (Tenant setting).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-COMPLIANCE-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-COMPLIANCE-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'DeviceManagementServiceConfig.ReadWrite.All'

$step = @{
    CheckId   = 'INTUNE-COMPLIANCE-001'
    Target    = 'Intune compliance policy settings'
    Desired   = 'No-policy devices non-compliant, threshold <= 30 days'
    GetState  = {
        Get-RemediationGraphObject -Uri '/beta/deviceManagement/settings'
    }
    TestState = {
        param($State)
        $State['secureByDefault'] -eq $true -and $null -ne $State['deviceComplianceCheckinThresholdDays'] -and [int]$State['deviceComplianceCheckinThresholdDays'] -le 30
    }
    SetState  = {
        param($State)
        $days = if ($null -ne $State['deviceComplianceCheckinThresholdDays'] -and [int]$State['deviceComplianceCheckinThresholdDays'] -le 30 -and [int]$State['deviceComplianceCheckinThresholdDays'] -ge 1) { [int]$State['deviceComplianceCheckinThresholdDays'] } else { 30 }
        Set-RemediationGraphObject -Uri '/beta/deviceManagement' -Body @{ settings = @{ secureByDefault = $true; deviceComplianceCheckinThresholdDays = $days } }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
