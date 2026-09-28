# Get-ManagedDevice.ps1 — EPIC-018 device detail (SPEC §2 US-2, §3.2, §6; T-0342).
#
# Live Graph reads only: assembles the device detail tab payloads (Overview,
# Hardware, Software, Policies, Encryption) from Graph. The worker is read-only:
# only GET requests are issued. Key retrieval is T-0346; this worker reports
# BitLocker status only.

function Get-ManagedDevice {
    <#
    .SYNOPSIS
        Gets a single managed device's detail tabs live from Microsoft Graph.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$DeviceId
    )

    $deviceUri = "/v1.0/deviceManagement/managedDevices/$DeviceId`?`$select=id,deviceName,userPrincipalName,operatingSystem,osVersion,complianceState,managementState,deviceType,managedDeviceOwnerType,lastSyncDateTime,enrolledDateTime,serialNumber,isEncrypted,model,manufacturer,storageSpace,totalStorageSpace,phoneNumber,imei"
    $device = Invoke-MgGraphRequest -Method GET -Uri $deviceUri

    $appsUri = "/v1.0/deviceManagement/managedDevices/$DeviceId/detectedApps?`$select=id,displayName,version,publisher"
    $appsResponse = Invoke-MgGraphRequest -Method GET -Uri $appsUri

    $complianceUri = "/v1.0/deviceManagement/managedDevices/$DeviceId/deviceCompliancePolicyStates?`$select=id,displayName,state,lastReportedDateTime"
    $complianceResponse = Invoke-MgGraphRequest -Method GET -Uri $complianceUri

    $configUri = "/v1.0/deviceManagement/managedDevices/$DeviceId/deviceConfigurationStates?`$select=id,displayName,state,lastReportedDateTime"
    $configResponse = Invoke-MgGraphRequest -Method GET -Uri $configUri

    $encrypted = $false
    if ($null -ne $device.isEncrypted) {
        try { $encrypted = [System.Convert]::ToBoolean($device.isEncrypted) } catch { $encrypted = $false }
    }

    $hardware = [pscustomobject]@{
        model           = if ($device.model) { [string]$device.model } else { '' }
        manufacturer    = if ($device.manufacturer) { [string]$device.manufacturer } else { '' }
        serialNumber    = if ($device.serialNumber) { [string]$device.serialNumber } else { '' }
        storageSpace    = if ($null -ne $device.storageSpace) { [int64]$device.storageSpace } else { 0 }
        totalStorage    = if ($null -ne $device.totalStorageSpace) { [int64]$device.totalStorageSpace } else { 0 }
        phoneNumber     = if ($device.phoneNumber) { [string]$device.phoneNumber } else { '' }
        imei            = if ($device.imei) { [string]$device.imei } else { '' }
    }

    $software = @()
    foreach ($app in @($appsResponse.value)) {
        $software += [pscustomobject]@{
            id          = if ($app.id) { [string]$app.id } else { '' }
            displayName = if ($app.displayName) { [string]$app.displayName } else { '' }
            version     = if ($app.version) { [string]$app.version } else { '' }
            publisher   = if ($app.publisher) { [string]$app.publisher } else { '' }
        }
    }

    $policies = @()
    foreach ($c in @($complianceResponse.value)) {
        $policies += [pscustomobject]@{
            id              = if ($c.id) { [string]$c.id } else { '' }
            displayName     = if ($c.displayName) { [string]$c.displayName } else { '' }
            state           = if ($c.state) { [string]$c.state } else { '' }
            lastReported    = if ($c.lastReportedDateTime) { [string]$c.lastReportedDateTime } else { '' }
            type            = 'compliance'
        }
    }
    foreach ($c in @($configResponse.value)) {
        $policies += [pscustomobject]@{
            id              = if ($c.id) { [string]$c.id } else { '' }
            displayName     = if ($c.displayName) { [string]$c.displayName } else { '' }
            state           = if ($c.state) { [string]$c.state } else { '' }
            lastReported    = if ($c.lastReportedDateTime) { [string]$c.lastReportedDateTime } else { '' }
            type            = 'configuration'
        }
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        deviceId    = $DeviceId
        overview    = [pscustomobject]@{
            deviceName      = if ($device.deviceName) { [string]$device.deviceName } else { '' }
            ownerUpn        = if ($device.userPrincipalName) { [string]$device.userPrincipalName } else { '' }
            platform        = if ($device.operatingSystem) { [string]$device.operatingSystem } else { '' }
            osVersion       = if ($device.osVersion) { [string]$device.osVersion } else { '' }
            compliance      = if ($device.complianceState) { [string]$device.complianceState } else { '' }
            ownership       = if ($device.managedDeviceOwnerType) { [string]$device.managedDeviceOwnerType } else { '' }
            lastCheckIn     = if ($device.lastSyncDateTime) { [string]$device.lastSyncDateTime } else { '' }
            enrolled        = if ($device.enrolledDateTime) { [string]$device.enrolledDateTime } else { '' }
            serial          = if ($device.serialNumber) { [string]$device.serialNumber } else { '' }
            encrypted       = $encrypted
            deviceType      = if ($device.deviceType) { [string]$device.deviceType } else { '' }
            managementState = if ($device.managementState) { [string]$device.managementState } else { '' }
        }
        hardware    = $hardware
        software    = $software
        policies    = $policies
        encryption  = [pscustomobject]@{
            encrypted   = $encrypted
            keyType     = 'bitlocker'
        }
        retrievedAt = (Get-Date -Format 'o')
    }
}
