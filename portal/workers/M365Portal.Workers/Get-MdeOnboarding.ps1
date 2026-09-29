# Get-MdeOnboarding.ps1 — EPIC-019 MDE onboarding coverage (SPEC §2 US-5, §3.5, §4.4, §6; T-0370).
#
# Live reads only: coverage is computed from EPIC-018 device records
# (deviceManagement/managedDevices) plus the T-0361 Defender state (the Graph
# security EDR onboarding state). Devices with no onboarding record are gaps;
# each gap links to the onboarding deployment policy (the SPEC §6 setup-wizard
# deploy endpoint POST /v1/tenants/{id}/defender/deploy).
# The worker is read-only: only GET requests are issued.

$script:MdePlatformOrder = @('windows', 'macos', 'ios', 'android', 'linux', 'other')

function Read-MdeOnboardingJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-MdeOnboarding.
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

    $raw = Get-Content -LiteralPath $Path -Raw
    $json = $raw | ConvertFrom-Json
    if (-not $json.tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }

    return @{
        TenantId = [string]$json.tenantId
        Platform = if ($json.platform) { [string]$json.platform } else { '' }
    }
}

function ConvertTo-MdePlatform {
    <#
    .SYNOPSIS
        Normalizes a device operatingSystem value to a coverage platform key.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$OperatingSystem = ''
    )

    $value = ([string]$OperatingSystem).Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($value)) { return 'other' }
    if ($value.StartsWith('windows')) { return 'windows' }
    if ($value.StartsWith('mac') -or $value.StartsWith('osx')) { return 'macos' }
    if ($value -in @('ios', 'iphone', 'ipad', 'iphoneos', 'ipados')) { return 'ios' }
    if ($value.StartsWith('android')) { return 'android' }
    if ($value.StartsWith('linux') -or $value.StartsWith('ubuntu')) { return 'linux' }
    return 'other'
}

function Get-MdeOnboardingDeviceRecords {
    <#
    .SYNOPSIS
        Reads EPIC-018 managed device records live from Microsoft Graph.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param()

    $uri = '/v1.0/deviceManagement/managedDevices?$select=id,deviceName,operatingSystem&$top=999'
    $records = [System.Collections.Generic.List[object]]::new()
    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        if ($null -ne $response -and $null -ne $response.value) {
            foreach ($entry in @($response.value)) {
                if ($null -ne $entry) {
                    $records.Add($entry)
                }
            }
        }
        $uri = if ($response.'@odata.nextLink') { $response.'@odata.nextLink' } else { $null }
    } while ($uri)

    return @($records)
}

function Get-MdeOnboardedDeviceKeys {
    <#
    .SYNOPSIS
        Reads the T-0361 Defender onboarding state live from Graph security.
    .DESCRIPTION
        Returns a case-insensitive key set of onboarded devices. Keys are
        'id:<deviceId>' plus a 'name:<deviceName>' fallback so onboarding
        records join device records even when the id spaces differ.
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.Generic.HashSet[string]])]
    param()

    $uri = '/v1.0/security/mdeOnboardingState?$select=deviceId,deviceName,onboardingStatus,onboarded&$top=999'
    $keys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        if ($null -ne $response -and $null -ne $response.value) {
            foreach ($entry in @($response.value)) {
                if ($null -eq $entry) { continue }
                $onboarded = $false
                if ($null -ne $entry.onboarded) {
                    try { $onboarded = [System.Convert]::ToBoolean($entry.onboarded) } catch { $onboarded = $false }
                }
                elseif ($null -ne $entry.onboardingStatus) {
                    $onboarded = ([string]$entry.onboardingStatus).Trim().ToLowerInvariant() -eq 'onboarded'
                }
                if (-not $onboarded) { continue }
                $id = if ($entry.deviceId) { [string]$entry.deviceId } elseif ($entry.id) { [string]$entry.id } else { '' }
                $name = if ($entry.deviceName) { [string]$entry.deviceName } else { '' }
                if (-not [string]::IsNullOrWhiteSpace($id)) { $null = $keys.Add("id:$id") }
                if (-not [string]::IsNullOrWhiteSpace($name)) { $null = $keys.Add("name:$name") }
            }
        }
        $uri = if ($response.'@odata.nextLink') { $response.'@odata.nextLink' } else { $null }
    } while ($uri)

    return $keys
}

function Get-MdeOnboardingCoveragePercent {
    param(
        [int]$Onboarded,
        [int]$Total
    )

    if ($Total -le 0) { return 0 }
    return [math]::Round(([double]$Onboarded / [double]$Total) * 100.0, 1)
}

function Get-MdeOnboarding {
    <#
    .SYNOPSIS
        Computes MDE onboarding coverage per platform from device records plus Defender state.
    .DESCRIPTION
        Read-only. Totals come from EPIC-018 managed device records grouped by
        normalized platform; onboarded membership comes from the T-0361
        Defender onboarding state. Devices without an onboarding record are
        reported as gaps with the deployment policy link.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [ValidateSet('', 'windows', 'macos', 'ios', 'android', 'linux', 'other')]
        [string]$Platform = ''
    )

    $records = @(Get-MdeOnboardingDeviceRecords)
    $onboardedKeys = Get-MdeOnboardedDeviceKeys

    $devices = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $records) {
        $id = if ($entry.id) { [string]$entry.id } else { '' }
        $name = if ($entry.deviceName) { [string]$entry.deviceName } else { '' }
        $devicePlatform = ConvertTo-MdePlatform -OperatingSystem $(if ($entry.operatingSystem) { [string]$entry.operatingSystem } else { '' })
        if (-not [string]::IsNullOrWhiteSpace($Platform) -and $devicePlatform -ne $Platform.ToLowerInvariant()) { continue }
        $isOnboarded = $onboardedKeys.Contains("id:$id") -or ((-not [string]::IsNullOrWhiteSpace($name)) -and $onboardedKeys.Contains("name:$name"))
        $devices.Add([pscustomobject]@{
            id         = $id
            deviceName = $name
            platform   = $devicePlatform
            onboarded  = [bool]$isOnboarded
        })
    }

    $deploymentPolicyUrl = "/v1/tenants/$TenantId/defender/deploy"

    $platformRows = [System.Collections.Generic.List[object]]::new()
    foreach ($key in $script:MdePlatformOrder) {
        $rows = @($devices | Where-Object { $_.platform -eq $key })
        if ($rows.Count -eq 0) { continue }
        $onboarded = @($rows | Where-Object { $_.onboarded }).Count
        $gaps = @($rows | Where-Object { -not $_.onboarded } | ForEach-Object {
            [pscustomobject]@{
                id          = $_.id
                deviceName  = $_.deviceName
                platform    = $_.platform
                policyUrl   = $deploymentPolicyUrl
            }
        })
        $platformRows.Add([pscustomobject]@{
            platform       = $key
            total          = $rows.Count
            onboarded      = $onboarded
            notOnboarded   = ($rows.Count - $onboarded)
            coveragePct    = (Get-MdeOnboardingCoveragePercent -Onboarded $onboarded -Total $rows.Count)
            gaps           = @($gaps)
        })
    }

    $totalCount = $devices.Count
    $onboardedCount = @($devices | Where-Object { $_.onboarded }).Count

    return [pscustomobject]@{
        tenantId            = $TenantId
        deploymentPolicyUrl = $deploymentPolicyUrl
        platforms           = @($platformRows)
        totals              = [pscustomobject]@{
            total          = $totalCount
            onboarded      = $onboardedCount
            notOnboarded   = ($totalCount - $onboardedCount)
            coveragePct    = (Get-MdeOnboardingCoveragePercent -Onboarded $onboardedCount -Total $totalCount)
        }
    }
}
