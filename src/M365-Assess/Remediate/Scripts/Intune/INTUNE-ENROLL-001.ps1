<#
.SYNOPSIS
    Remediates INTUNE-ENROLL-001: Ensure device enrollment for personally owned devices is blocked by default
.DESCRIPTION
    Blocks enrollment of personally owned devices in the default device platform restriction.

    Desired state: personalDeviceEnrollmentBlocked = true for each platform
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DeviceManagementServiceConfig.ReadWrite.All.

    Corporate devices must be identified (Autopilot, Apple ADE, Android Enterprise corporate, or
    corporate identifiers) or they will also be blocked. Tenants using per-platform restriction
    policies need those edited instead.

    Triage bucket: Needs decision (Policy template (Intune)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER Platform
    Platforms to block personal enrollment for. Defaults to all.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-ENROLL-001.ps1 -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-ENROLL-001.ps1
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateSet('iosRestriction', 'androidRestriction', 'androidForWorkRestriction', 'windowsRestriction', 'macOSRestriction')]
    [string[]]$Platform = @('iosRestriction', 'androidRestriction', 'androidForWorkRestriction', 'windowsRestriction', 'macOSRestriction')
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'DeviceManagementServiceConfig.ReadWrite.All'

$step = @{
    CheckId   = 'INTUNE-ENROLL-001'
    Target    = 'Default device platform restriction'
    Desired   = 'Personal enrollment blocked'
    GetState  = {
        @((Invoke-MgGraphRequest -Method GET -Uri '/beta/deviceManagement/deviceEnrollmentConfigurations' -OutputType HashTable)['value']) |
            Where-Object { $null -ne $_ -and $_['@odata.type'] -eq '#microsoft.graph.deviceEnrollmentPlatformRestrictionsConfiguration' } | Select-Object -First 1
    }
    TestState = {
        param($State)
        $null -ne $State -and @($Platform | Where-Object { $State[$_] -and $State[$_]['personalDeviceEnrollmentBlocked'] -ne $true }).Count -eq 0
    }
    SetState  = {
        param($State)
        $patch = @{ '@odata.type' = '#microsoft.graph.deviceEnrollmentPlatformRestrictionsConfiguration' }
        foreach ($p in $Platform) {
            if ($State[$p]) {
                $r = @{}
                foreach ($k in $State[$p].Keys) { $r[$k] = $State[$p][$k] }
                $r['personalDeviceEnrollmentBlocked'] = $true
                $patch[$p] = $r
            }
        }
        Set-RemediationGraphObject -Uri "/beta/deviceManagement/deviceEnrollmentConfigurations/$($State['id'])" -Body $patch
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
