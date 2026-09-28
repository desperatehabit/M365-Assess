# Get-ManagedDevices.ps1 — EPIC-018 managed device list (SPEC §2 US-1, §3.1, §6; T-0341).
#
# Live Graph reads only: devices are never mirrored to disk.
# Emits device rows with the §3.1 columns (device name, owner/UPN, platform,
# compliance, ownership, last check-in, enrolled, serial) plus encrypted and
# OS version, with server-side filtering and cursor pagination so large fleets
# do not stream fully into the browser.
# The worker is read-only: only GET requests are issued.

function Read-ManagedDevicesJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-ManagedDevices.
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

    $result = @{
        TenantId    = [string]$json.tenantId
        Platform    = if ($json.platform) { [string]$json.platform } else { '' }
        Compliance  = if ($json.compliance) { [string]$json.compliance } else { '' }
        Ownership   = if ($json.ownership) { [string]$json.ownership } else { '' }
        LastCheckIn = if ($json.lastCheckIn) { [string]$json.lastCheckIn } else { '' }
        Encrypted   = if ($null -ne $json.encrypted) { [string]$json.encrypted } else { '' }
        Search      = if ($json.search) { [string]$json.search } else { '' }
        Top         = if ($json.top) { [int]$json.top } else { 100 }
        Cursor      = if ($json.cursor) { [string]$json.cursor } else { '' }
    }
    return $result
}

function ConvertTo-DevicesCursor {
    param([int]$Offset)
    if ($Offset -le 0) { return '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("offset:$Offset")
    return [System.Convert]::ToBase64String($bytes)
}

function ConvertFrom-DevicesCursor {
    param([string]$Cursor)
    if ([string]::IsNullOrWhiteSpace($Cursor)) { return 0 }
    try {
        $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Cursor))
        if ($decoded -match '^offset:(\d+)$') {
            return [int]$Matches[1]
        }
        return 0
    }
    catch {
        return 0
    }
}

function ConvertTo-DeviceRow {
    param(
        [object]$Entry
    )

    $deviceName = if ($Entry.deviceName) { [string]$Entry.deviceName } else { '' }
    $id = if ($Entry.id) { [string]$Entry.id } else { '' }
    $ownerUpn = if ($Entry.userPrincipalName) { [string]$Entry.userPrincipalName } else { '' }
    $platform = if ($Entry.operatingSystem) { [string]$Entry.operatingSystem } else { '' }
    $compliance = if ($Entry.complianceState) { [string]$Entry.complianceState } else { '' }
    $ownership = if ($Entry.managedDeviceOwnerType) { [string]$Entry.managedDeviceOwnerType } else { '' }
    $lastCheckIn = if ($Entry.lastSyncDateTime) { [string]$Entry.lastSyncDateTime } else { '' }
    $enrolled = if ($Entry.enrolledDateTime) { [string]$Entry.enrolledDateTime } else { '' }
    $serial = if ($Entry.serialNumber) { [string]$Entry.serialNumber } else { '' }
    $osVersion = if ($Entry.osVersion) { [string]$Entry.osVersion } else { '' }

    $encrypted = $false
    if ($null -ne $Entry.isEncrypted) {
        try {
            $encrypted = [System.Convert]::ToBoolean($Entry.isEncrypted)
        }
        catch {
            $encrypted = $false
        }
    }

    return [pscustomobject]@{
        id          = $id
        deviceName  = $deviceName
        name        = $deviceName
        ownerUpn    = $ownerUpn
        platform    = $platform
        compliance  = $compliance
        ownership   = $ownership
        lastCheckIn = $lastCheckIn
        enrolled    = $enrolled
        serial      = $serial
        encrypted   = $encrypted
        osVersion   = $osVersion
    }
}

function Test-DeviceFilter {
    param(
        [object]$Row,
        [string]$Platform = '',
        [string]$Compliance = '',
        [string]$Ownership = '',
        [string]$LastCheckIn = '',
        [string]$Encrypted = '',
        [string]$Search = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($Platform)) {
        if ($Row.platform.ToLowerInvariant() -ne $Platform.ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Compliance)) {
        if ($Row.compliance.ToLowerInvariant() -ne $Compliance.ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Ownership)) {
        if ($Row.ownership.ToLowerInvariant() -ne $Ownership.ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Encrypted)) {
        $e = $Encrypted.ToLowerInvariant()
        if ($e -in @('true', '1')) {
            if (-not $Row.encrypted) { return $false }
        }
        elseif ($e -in @('false', '0')) {
            if ($Row.encrypted) { return $false }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($LastCheckIn)) {
        $window = $LastCheckIn.ToLowerInvariant()
        $days = 0
        switch ($window) {
            '7d' { $days = 7 }
            '30d' { $days = 30 }
            '90d' { $days = 90 }
            default { $days = 0 }
        }
        if ($days -gt 0) {
            if ([string]::IsNullOrWhiteSpace($Row.lastCheckIn)) {
                return $false
            }
            try {
                $seen = [datetime]$Row.lastCheckIn
                if ($seen.ToUniversalTime() -gt (Get-Date).ToUniversalTime().AddDays(-$days)) {
                    return $false
                }
            }
            catch {
                return $false
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Search)) {
        $term = $Search.ToLowerInvariant()
        $matched = ($Row.deviceName -and $Row.deviceName.ToLowerInvariant().Contains($term)) -or
                   ($Row.ownerUpn -and $Row.ownerUpn.ToLowerInvariant().Contains($term)) -or
                   ($Row.serial -and $Row.serial.ToLowerInvariant().Contains($term))
        if (-not $matched) { return $false }
    }

    return $true
}

function Get-ManagedDevices {
    <#
    .SYNOPSIS
        Lists tenant managed devices live from Microsoft Graph with filters.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$Platform = '',

        [Parameter()]
        [string]$Compliance = '',

        [Parameter()]
        [string]$Ownership = '',

        [Parameter()]
        [string]$LastCheckIn = '',

        [Parameter()]
        [string]$Encrypted = '',

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $allRawDevices = [System.Collections.Generic.List[object]]::new()
    $uri = "/v1.0/deviceManagement/managedDevices?`$select=id,deviceName,userPrincipalName,operatingSystem,osVersion,complianceState,managementState,deviceType,managedDeviceOwnerType,lastSyncDateTime,enrolledDateTime,serialNumber,isEncrypted&`$top=999"

    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        if ($null -ne $response -and $null -ne $response.value) {
            foreach ($entry in @($response.value)) {
                if ($null -ne $entry) {
                    $allRawDevices.Add($entry)
                }
            }
        }
        $uri = if ($response.'@odata.nextLink') { $response.'@odata.nextLink' } else { $null }
    } while ($uri)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $allRawDevices) {
        $row = ConvertTo-DeviceRow -Entry $entry
        if (Test-DeviceFilter -Row $row -Platform $Platform -Compliance $Compliance -Ownership $Ownership -LastCheckIn $LastCheckIn -Encrypted $Encrypted -Search $Search) {
            $rows.Add($row)
        }
    }

    $offset = ConvertFrom-DevicesCursor -Cursor $Cursor
    if ($offset -lt 0) { $offset = 0 }

    $paged = [System.Collections.Generic.List[object]]::new()
    $end = [System.Math]::Min($offset + $Top, $rows.Count)
    for ($i = $offset; $i -lt $end; $i++) {
        $paged.Add($rows[$i])
    }

    $nextCursor = $null
    if ($end -lt $rows.Count) {
        $nextCursor = ConvertTo-DevicesCursor -Offset $end
    }

    return [pscustomobject]@{
        tenantId   = $TenantId
        totalCount = $rows.Count
        items      = @($paged)
        nextCursor = $nextCursor
    }
}
