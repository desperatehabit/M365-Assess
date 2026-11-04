<#
.SYNOPSIS
    Remediates INTUNE-SECURITY-001: Device Compliance Policy Baseline
.DESCRIPTION
    Creates and assigns a Windows compliance policy requiring BitLocker, Secure Boot, code
    integrity, Defender with real-time protection, and a minimum OS version.

    Desired state: Intune policy "M365-Assess - Windows compliance baseline" exists with the required settings and is assigned
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DeviceManagementConfiguration.ReadWrite.All.

    Pair with a Conditional Access policy requiring compliant devices (CA-DEVICE-001). Devices that
    fail are marked non-compliant immediately.
    Matched by display name: an existing policy with -ProfileName is updated and re-assigned.

    Triage bucket: Needs decision (Policy template (Intune)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ProfileName
    Display name of the Intune policy to create or update.
.PARAMETER MinimumOsVersion
    Minimum Windows build allowed.
.PARAMETER AssignToGroupId
    Entra group object IDs to assign the policy to.
.PARAMETER AssignToAll
    Assign to all devices (configuration profiles) or all users (compliance policies).
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-SECURITY-001.ps1 -AssignToGroupId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-SECURITY-001.ps1 -AssignToGroupId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$ProfileName = 'M365-Assess - Windows compliance baseline',

    [Parameter()]
    [ValidatePattern('^\d+\.\d+\.\d+(\.\d+)?$')]
    [string]$MinimumOsVersion = '10.0.19045',

    [Parameter(Mandatory, ParameterSetName = 'Group')]
    [ValidateNotNullOrEmpty()]
    [string[]]$AssignToGroupId,

    [Parameter(Mandatory, ParameterSetName = 'All')]
    [switch]$AssignToAll
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath '../Common/RemediationScriptHelper.ps1')
Assert-RemediationConnection -Service 'Graph' -GraphScope 'DeviceManagementConfiguration.ReadWrite.All'

$targets = if ($AssignToAll.IsPresent) {
    @(@{ target = @{ '@odata.type' = '#microsoft.graph.allLicensedUsersAssignmentTarget' } })
}
else {
    @($AssignToGroupId | ForEach-Object { @{ target = @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = $_ } } })
}
$profileBody = @{
    bitLockerEnabled         = $true
    secureBootEnabled        = $true
    codeIntegrityEnabled     = $true
    storageRequireEncryption = $true
    osMinimumVersion         = $MinimumOsVersion
    defenderEnabled          = $true
    rtpEnabled               = $true
}
$profileBody['@odata.type'] = '#microsoft.graph.windows10CompliancePolicy'
$profileBody['displayName'] = $ProfileName
$profileBody['description'] = 'Created by M365-Assess remediation INTUNE-SECURITY-001'
$profileBody['scheduledActionsForRule'] = @(@{ ruleName = 'PasswordRequired'; scheduledActionConfigurations = @(@{ actionType = 'block'; gracePeriodHours = 0; notificationTemplateId = ''; notificationMessageCCList = @() }) })

$step = @{
    CheckId   = 'INTUNE-SECURITY-001'
    Target    = "Intune policy $ProfileName"
    Desired   = 'Exists, configured, assigned'
    GetState  = {
        $escaped = $ProfileName.Replace("'", "''")
        @((Invoke-MgGraphRequest -Method GET -Uri "/beta/deviceManagement/deviceCompliancePolicies?`$filter=displayName eq '$escaped'&`$expand=assignments" -OutputType HashTable)['value']) | Where-Object { $_ } | Select-Object -First 1
    }
    TestState = {
        param($State)
        $null -ne $State -and @($State['assignments']).Count -gt 0 -and ($State['bitLockerEnabled'] -eq $true -and $State['secureBootEnabled'] -eq $true)
    }
    SetState  = {
        param($State)
        $id = if ($null -eq $State) {
            (Invoke-MgGraphRequest -Method POST -Uri '/beta/deviceManagement/deviceCompliancePolicies' -Body ($profileBody | ConvertTo-Json -Depth 20) -ContentType 'application/json' -OutputType HashTable)['id']
        }
        else {
            $patch = $profileBody.Clone()
            $patch.Remove('scheduledActionsForRule')
            Invoke-MgGraphRequest -Method PATCH -Uri "/beta/deviceManagement/deviceCompliancePolicies/$($State['id'])" -Body ($patch | ConvertTo-Json -Depth 20) -ContentType 'application/json' | Out-Null
            $State['id']
        }
        Invoke-MgGraphRequest -Method POST -Uri "/beta/deviceManagement/deviceCompliancePolicies/$id/assign" -Body (@{ assignments = $targets } | ConvertTo-Json -Depth 10) -ContentType 'application/json' | Out-Null
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
