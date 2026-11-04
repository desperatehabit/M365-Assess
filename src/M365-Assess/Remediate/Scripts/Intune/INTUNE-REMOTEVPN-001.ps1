<#
.SYNOPSIS
    Remediates INTUNE-REMOTEVPN-001: Ensure Always-On VPN Is Configured for Managed Remote Devices
.DESCRIPTION
    Creates and assigns an always-on, full-tunnel Windows VPN profile for remote devices.

    Desired state: Intune policy "M365-Assess - Always-on VPN" exists with the required settings and is assigned
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DeviceManagementConfiguration.ReadWrite.All.

    Certificate authentication also needs a SCEP/PKCS certificate profile on the devices. The
    assessment check reads alwaysOn; Graph names the property enableAlwaysOn, so confirm the check
    recognizes the profile.
    Matched by display name: an existing policy with -ProfileName is updated and re-assigned.

    Triage bucket: Needs decision (Policy template (Intune)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ProfileName
    Display name of the Intune policy to create or update.
.PARAMETER ServerAddress
    VPN server FQDN or IP.
.PARAMETER ConnectionType
    VPN client / protocol.
.PARAMETER AuthenticationMethod
    How devices authenticate to the VPN.
.PARAMETER AssignToGroupId
    Entra group object IDs to assign the policy to.
.PARAMETER AssignToAll
    Assign to all devices (configuration profiles) or all users (compliance policies).
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-REMOTEVPN-001.ps1 -ServerAddress 'vpn.contoso.com' -ConnectionType ikEv2 -AssignToGroupId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-REMOTEVPN-001.ps1 -ServerAddress 'vpn.contoso.com' -ConnectionType ikEv2 -AssignToGroupId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$ProfileName = 'M365-Assess - Always-on VPN',

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ServerAddress,

    [Parameter(Mandatory)]
    [ValidateSet('ikEv2', 'ciscoAnyConnect', 'paloAltoGlobalProtect', 'f5EdgeClient', 'pulseSecure', 'checkPointCapsuleVpn', 'citrix', 'microsoftTunnel', 'automatic')]
    [string]$ConnectionType,

    [Parameter()]
    [ValidateSet('certificate', 'usernameAndPassword', 'azureAD', 'derivedCredential')]
    [string]$AuthenticationMethod = 'certificate',

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
    @(@{ target = @{ '@odata.type' = '#microsoft.graph.allDevicesAssignmentTarget' } })
}
else {
    @($AssignToGroupId | ForEach-Object { @{ target = @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = $_ } } })
}
$profileBody = @{
    connectionName        = $ProfileName
    connectionType        = $ConnectionType
    servers               = @(@{ address = $ServerAddress; description = $ServerAddress; isDefaultServer = $true })
    authenticationMethod  = $AuthenticationMethod
    enableSplitTunneling  = $false
    enableAlwaysOn        = $true
    rememberUserCredentials = $true
}
$profileBody['@odata.type'] = '#microsoft.graph.windows10VpnConfiguration'
$profileBody['displayName'] = $ProfileName
$profileBody['description'] = 'Created by M365-Assess remediation INTUNE-REMOTEVPN-001'

$step = @{
    CheckId   = 'INTUNE-REMOTEVPN-001'
    Target    = "Intune policy $ProfileName"
    Desired   = 'Exists, configured, assigned'
    GetState  = {
        $escaped = $ProfileName.Replace("'", "''")
        @((Invoke-MgGraphRequest -Method GET -Uri "/beta/deviceManagement/deviceConfigurations?`$filter=displayName eq '$escaped'&`$expand=assignments" -OutputType HashTable)['value']) | Where-Object { $_ } | Select-Object -First 1
    }
    TestState = {
        param($State)
        $null -ne $State -and @($State['assignments']).Count -gt 0 -and ($State['enableSplitTunneling'] -eq $false -and $State['enableAlwaysOn'] -eq $true)
    }
    SetState  = {
        param($State)
        $id = if ($null -eq $State) {
            (Invoke-MgGraphRequest -Method POST -Uri '/beta/deviceManagement/deviceConfigurations' -Body ($profileBody | ConvertTo-Json -Depth 20) -ContentType 'application/json' -OutputType HashTable)['id']
        }
        else {
            $patch = $profileBody.Clone()
            $patch.Remove('scheduledActionsForRule')
            Invoke-MgGraphRequest -Method PATCH -Uri "/beta/deviceManagement/deviceConfigurations/$($State['id'])" -Body ($patch | ConvertTo-Json -Depth 20) -ContentType 'application/json' | Out-Null
            $State['id']
        }
        Invoke-MgGraphRequest -Method POST -Uri "/beta/deviceManagement/deviceConfigurations/$id/assign" -Body (@{ assignments = $targets } | ConvertTo-Json -Depth 10) -ContentType 'application/json' | Out-Null
    }
}
Invoke-RemediationStep -Cmdlet $PSCmdlet @step
