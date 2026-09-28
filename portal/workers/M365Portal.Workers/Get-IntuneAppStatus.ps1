# Get-IntuneAppStatus.ps1 - EPIC-017 per-device deployment and enrollment status (SPEC section 3.6; T-0844).
#
# Read-only provider behind routes/intune-app-status.ts (T-0330). Two actions:
#   apps       - install status per device for each Win32 and Store app
#                (mobileApps/{id}/deviceStatuses), capped at -MaxApps apps.
#   enrollment - per-device enrollment state from three sources:
#                Autopilot device identities, Apple ADE imported device identities (per ADE
#                token), and Android Enterprise managed devices.
# States are returned as Graph reports them; the route maps them onto its canonical set.

$script:StatusAppTypes = @('#microsoft.graph.win32LobApp', '#microsoft.graph.winGetApp', '#microsoft.graph.microsoftStoreForBusinessApp')

function Read-IntuneAppStatusJob {
    <#
    .SYNOPSIS
        Parses a job document for Get-IntuneAppStatus.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "job envelope not found at '$Path'"
    }
    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    if (-not $json['tenantId']) { throw "job envelope '$Path' is missing mandatory 'tenantId'" }
    if (@('apps', 'enrollment') -notcontains [string]$json['action']) {
        throw "job envelope '$Path' has unknown action '$($json['action'])'"
    }
    return $json
}

function Get-StatusValue {
    # Reads a property from a hashtable or a PSCustomObject; empty strings become $null.
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $value = if ($Object -is [System.Collections.IDictionary]) { $Object[$Name] } else { $Object.$Name }
    if ($value -is [string] -and $value -eq '') { return $null }
    return $value
}

function Get-StatusCollection {
    <#
    .SYNOPSIS
        GETs a Graph collection and follows @odata.nextLink to the end.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param([Parameter(Mandatory)][string]$Uri)

    $items = [System.Collections.Generic.List[object]]::new()
    $next = $Uri
    while ($next) {
        $response = Invoke-MgGraphRequest -Method GET -Uri $next
        foreach ($item in @(Get-StatusValue -Object $response -Name 'value')) { if ($null -ne $item) { $items.Add($item) } }
        $next = Get-StatusValue -Object $response -Name '@odata.nextLink'
    }
    return , $items.ToArray()
}

function Get-AppDeviceStatuses {
    <#
    .SYNOPSIS
        Per-device install status for the tenant's Win32 and Store apps.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param([int]$MaxApps = 100)

    # The collection comes back as one array object; assign it so the pipeline unrolls it.
    $all = Get-StatusCollection -Uri '/beta/deviceAppManagement/mobileApps?$select=id,displayName'
    $apps = @($all |
            Where-Object { $script:StatusAppTypes -contains [string](Get-StatusValue -Object $_ -Name '@odata.type') } |
            Select-Object -First $MaxApps)
    $rows = foreach ($app in $apps) {
        $appId = [string](Get-StatusValue -Object $app -Name 'id')
        foreach ($s in (Get-StatusCollection -Uri "/beta/deviceAppManagement/mobileApps/$appId/deviceStatuses")) {
            @{
                deviceId          = [string](Get-StatusValue -Object $s -Name 'deviceId')
                deviceName        = Get-StatusValue -Object $s -Name 'deviceName'
                userPrincipalName = Get-StatusValue -Object $s -Name 'userPrincipalName'
                platform          = 'windows'
                appId             = $appId
                appName           = [string](Get-StatusValue -Object $app -Name 'displayName')
                installState      = Get-StatusValue -Object $s -Name 'installState'
                errorCode         = if ($null -ne (Get-StatusValue -Object $s -Name 'errorCode') -and [int](Get-StatusValue -Object $s -Name 'errorCode') -ne 0) { '0x{0:X8}' -f [int](Get-StatusValue -Object $s -Name 'errorCode') } else { $null }
                lastSyncDateTime  = Get-StatusValue -Object $s -Name 'lastSyncDateTime'
            }
        }
    }
    return , @($rows)
}

function Get-EnrollmentDeviceStatuses {
    <#
    .SYNOPSIS
        Per-device enrollment state from Autopilot, Apple ADE, and Android Enterprise.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param()

    $rows = [System.Collections.Generic.List[hashtable]]::new()
    foreach ($d in (Get-StatusCollection -Uri '/v1.0/deviceManagement/windowsAutopilotDeviceIdentities')) {
        $rows.Add(@{
                deviceId              = [string](Get-StatusValue -Object $d -Name 'id')
                serialNumber          = Get-StatusValue -Object $d -Name 'serialNumber'
                deviceName            = Get-StatusValue -Object $d -Name 'displayName'
                source                = 'autopilot'
                platform              = 'windows'
                profileName           = $null
                enrollmentState       = Get-StatusValue -Object $d -Name 'enrollmentState'
                lastContactedDateTime = Get-StatusValue -Object $d -Name 'lastContactedDateTime'
            })
    }
    foreach ($dep in (Get-StatusCollection -Uri '/beta/deviceManagement/depOnboardingSettings')) {
        $depId = [string](Get-StatusValue -Object $dep -Name 'id')
        foreach ($d in (Get-StatusCollection -Uri "/beta/deviceManagement/depOnboardingSettings/$depId/importedAppleDeviceIdentities")) {
            $rows.Add(@{
                    deviceId              = [string](Get-StatusValue -Object $d -Name 'id')
                    serialNumber          = Get-StatusValue -Object $d -Name 'serialNumber'
                    deviceName            = $null
                    source                = 'apple-ade'
                    platform              = ([string](Get-StatusValue -Object $d -Name 'platform')).ToLowerInvariant()
                    profileName           = $null
                    enrollmentState       = Get-StatusValue -Object $d -Name 'enrollmentState'
                    lastContactedDateTime = Get-StatusValue -Object $d -Name 'lastContactedDateTime'
                })
        }
    }
    $filter = [uri]::EscapeDataString("operatingSystem eq 'Android'")
    foreach ($d in (Get-StatusCollection -Uri "/v1.0/deviceManagement/managedDevices?`$filter=$filter&`$select=id,deviceName,serialNumber,deviceEnrollmentType,managementState,lastSyncDateTime")) {
        if (-not ([string](Get-StatusValue -Object $d -Name 'deviceEnrollmentType')).StartsWith('androidEnterprise')) { continue }
        $state = [string](Get-StatusValue -Object $d -Name 'managementState')
        $rows.Add(@{
                deviceId              = [string](Get-StatusValue -Object $d -Name 'id')
                serialNumber          = Get-StatusValue -Object $d -Name 'serialNumber'
                deviceName            = Get-StatusValue -Object $d -Name 'deviceName'
                source                = 'android-enterprise'
                platform              = 'android'
                profileName           = $null
                enrollmentState       = if ($state -eq 'managed') { 'enrolled' } elseif ($state) { $state } else { $null }
                lastContactedDateTime = Get-StatusValue -Object $d -Name 'lastSyncDateTime'
            })
    }
    return , $rows.ToArray()
}
