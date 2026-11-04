<#
.SYNOPSIS
    Remediates INTUNE-ENROLLMENT-001: Device Enrollment Restrictions
.DESCRIPTION
    Sets the default device limit restriction (maximum devices each user can enroll).

    Desired state: Default enrollment limit <= -Limit
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DeviceManagementServiceConfig.ReadWrite.All.

    Triage bucket: Needs decision (Policy template (Intune)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Limit
    Maximum devices per user. An existing lower limit is kept.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-ENROLLMENT-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-ENROLLMENT-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateRange(1, 15)]
    [int]$Limit = 5
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'DeviceManagementServiceConfig.ReadWrite.All'

$step = @{
    CheckId   = 'INTUNE-ENROLLMENT-001'
    Target    = 'Default device limit restriction'
    Desired   = "$Limit devices or fewer"
    GetState  = {
        @((Invoke-MgGraphRequest -Method GET -Uri '/beta/deviceManagement/deviceEnrollmentConfigurations' -OutputType HashTable)['value']) |
            Where-Object { $null -ne $_ -and $_['@odata.type'] -eq '#microsoft.graph.deviceEnrollmentLimitConfiguration' } | Sort-Object -Property { [int]$_['priority'] } -Descending | Select-Object -First 1
    }
    TestState = {
        param($State)
        $null -ne $State -and [int]$State['limit'] -le $Limit
    }
    SetState  = {
        param($State)
        Set-RemediationGraphObject -Uri "/beta/deviceManagement/deviceEnrollmentConfigurations/$($State['id'])" -Body @{ '@odata.type' = '#microsoft.graph.deviceEnrollmentLimitConfiguration'; limit = $Limit }
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
