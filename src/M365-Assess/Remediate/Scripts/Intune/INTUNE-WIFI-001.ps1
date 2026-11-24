<#
.SYNOPSIS
    Remediates INTUNE-WIFI-001: Ensure WiFi Enterprise Authentication and Encryption on Managed Devices
.DESCRIPTION
    Creates and assigns a Windows Wi-Fi profile using WPA2-Enterprise with EAP-TLS certificate
    authentication.

    Desired state: Intune policy "M365-Assess - Corporate Wi-Fi (EAP-TLS)" exists with the required settings and is assigned
    Requires: Microsoft Graph (Connect-MgGraph); Graph scopes: DeviceManagementConfiguration.ReadWrite.All.

    Matched by display name: an existing policy with -ProfileName is updated and re-assigned.

    Triage bucket: Needs decision (Policy template (Intune)).
    Validation status: UNVALIDATED. Not yet hand-tested against a live tenant
    and not registered in Remediate/Get-RemediationCommand.ps1. Run with
    -WhatIf first, then re-run the assessment to confirm the check passes.
.PARAMETER ProfileName
    Display name of the Intune policy to create or update.
.PARAMETER Ssid
    Network SSID.
.PARAMETER RadiusServerName
    RADIUS server certificate names devices should trust.
.PARAMETER RootCertificateProfileId
    IDs of Intune trusted certificate profiles holding the RADIUS root CA.
.PARAMETER ClientCertificateProfileId
    ID of the SCEP or PKCS certificate profile devices authenticate with.
.PARAMETER AssignToGroupId
    Entra group object IDs to assign the policy to.
.PARAMETER AssignToAll
    Assign to all devices (configuration profiles) or all users (compliance policies).
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-WIFI-001.ps1 -Ssid 'CORP' -RadiusServerName 'radius.contoso.com' -RootCertificateProfileId '<id>' -ClientCertificateProfileId '<id>' -AssignToGroupId '00000000-0000-0000-0000-000000000001' -WhatIf
    Shows what would change without changing anything.
.EXAMPLE
    PS> ./Remediate/Scripts/Intune/INTUNE-WIFI-001.ps1 -Ssid 'CORP' -RadiusServerName 'radius.contoso.com' -RootCertificateProfileId '<id>' -ClientCertificateProfileId '<id>' -AssignToGroupId '00000000-0000-0000-0000-000000000001'
    Applies the change after a confirmation prompt and verifies it.
.OUTPUTS
    PSCustomObject per step: CheckId, Target, Status, Desired, Before, After, Message.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$ProfileName = 'M365-Assess - Corporate Wi-Fi (EAP-TLS)',

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Ssid,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$RadiusServerName,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$RootCertificateProfileId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ClientCertificateProfileId,

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
    networkName                         = $Ssid
    ssid                                = $Ssid
    connectAutomatically                = $true
    connectWhenNetworkNameIsHidden      = $false
    wifiSecurityType                    = 'wpa2Enterprise'
    eapType                             = 'eapTls'
    trustedServerCertificateNames       = @($RadiusServerName)
    authenticationMethod                = 'certificate'
    'rootCertificatesForServerValidation@odata.bind' = @($RootCertificateProfileId | ForEach-Object { "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations('$_')" })
    'identityCertificateForClientAuthentication@odata.bind' = "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations('$ClientCertificateProfileId')"
}
$profileBody['@odata.type'] = '#microsoft.graph.windowsWifiEnterpriseEAPConfiguration'
$profileBody['displayName'] = $ProfileName
$profileBody['description'] = 'Created by M365-Assess remediation INTUNE-WIFI-001'

$step = @{
    CheckId   = 'INTUNE-WIFI-001'
    Target    = "Intune policy $ProfileName"
    Desired   = 'Exists, configured, assigned'
    GetState  = {
        $escaped = $ProfileName.Replace("'", "''")
        @((Invoke-MgGraphRequest -Method GET -Uri "/beta/deviceManagement/deviceConfigurations?`$filter=displayName eq '$escaped'&`$expand=assignments" -OutputType HashTable)['value']) | Where-Object { $_ } | Select-Object -First 1
    }
    TestState = {
        param($State)
        $null -ne $State -and @($State['assignments']).Count -gt 0 -and ($State['wifiSecurityType'] -eq 'wpa2Enterprise' -and $State['eapType'] -eq 'eapTls')
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
