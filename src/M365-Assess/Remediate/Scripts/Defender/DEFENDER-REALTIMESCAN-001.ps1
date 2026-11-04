<#
.SYNOPSIS
    Remediates DEFENDER-REALTIMESCAN-001: Ensure Defender Antivirus real-time protection is enabled
.DESCRIPTION
    Creates an Intune device restriction profile (Windows 10/11) that turns on Microsoft Defender
    Antivirus real-time protection and scanning of all files, and assigns it.

    Desired state: Intune profile with real-time monitoring of all files, assigned
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DeviceManagementConfiguration.ReadWrite.All.

    Uses the device restrictions (windows10GeneralConfiguration) profile type that the
    assessment reads. If you already manage antivirus with an Endpoint security policy, assign
    that instead; the collector also accepts it.

    Triage bucket: Needs decision (Policy template (Intune)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ProfileName
    Display name of the profile to create or update.
.PARAMETER AssignToGroupId
    Entra group object IDs to assign the profile to.
.PARAMETER AssignToAllDevices
    Assign the profile to all devices.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-REALTIMESCAN-001.ps1 -AssignToAllDevices -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Defender/DEFENDER-REALTIMESCAN-001.ps1 -AssignToAllDevices
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$ProfileName = 'Defender Antivirus - Real-time protection',

    [Parameter(Mandatory, ParameterSetName = 'Group')]
    [string[]]$AssignToGroupId,

    [Parameter(Mandatory, ParameterSetName = 'AllDevices')]
    [switch]$AssignToAllDevices
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'DeviceManagementConfiguration.ReadWrite.All'

$profileBody = @{
    '@odata.type'                     = '#microsoft.graph.windows10GeneralConfiguration'
    displayName                       = $ProfileName
    description                       = 'Created by M365-Assess remediation DEFENDER-REALTIMESCAN-001'
    defenderRequireRealTimeMonitoring = $true
    defenderMonitorFileActivity       = 'monitorAllFiles'
    defenderRealtimeScanDirection     = 'monitorAllFiles'
}
$targets = if ($AssignToAllDevices.IsPresent) {
    @(@{ target = @{ '@odata.type' = '#microsoft.graph.allDevicesAssignmentTarget' } })
}
else {
    @($AssignToGroupId | ForEach-Object { @{ target = @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = $_ } } })
}
$filterName = $ProfileName.Replace("'", "''")

$step = @{
    CheckId   = 'DEFENDER-REALTIMESCAN-001'
    Target    = "Intune profile $ProfileName"
    Desired   = 'Exists with real-time monitoring and is assigned'
    GetState  = {
        $found = (Invoke-MgGraphRequest -Method GET -Uri "/beta/deviceManagement/deviceConfigurations?`$filter=displayName eq '$filterName'&`$expand=assignments" -OutputType HashTable)['value'] | Select-Object -First 1
        $found
    }
    TestState = {
        param($State)
        $null -ne $State -and $State['defenderMonitorFileActivity'] -eq 'monitorAllFiles' -and @($State['assignments']).Count -gt 0
    }
    SetState  = {
        param($State)
        $id = if ($null -eq $State) {
            (Invoke-MgGraphRequest -Method POST -Uri '/beta/deviceManagement/deviceConfigurations' -Body ($profileBody | ConvertTo-Json -Depth 10) -ContentType 'application/json' -OutputType HashTable)['id']
        }
        else {
            $patch = $profileBody.Clone()
            $patch.Remove('displayName')
            Invoke-MgGraphRequest -Method PATCH -Uri "/beta/deviceManagement/deviceConfigurations/$($State['id'])" -Body ($patch | ConvertTo-Json -Depth 10) -ContentType 'application/json'
            $State['id']
        }
        Invoke-MgGraphRequest -Method POST -Uri "/beta/deviceManagement/deviceConfigurations/$id/assign" -Body (@{ assignments = $targets } | ConvertTo-Json -Depth 10) -ContentType 'application/json'
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
