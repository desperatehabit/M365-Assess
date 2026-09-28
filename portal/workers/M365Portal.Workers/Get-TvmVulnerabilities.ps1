# Get-TvmVulnerabilities.ps1 — EPIC-019 TVM vulnerabilities (SPEC §2 US-3, §3.3, §6; T-0366).
#
# Live Graph security API reads only: vulnerabilities are never mirrored to disk.
# Emits CVE rows with the §3.3 columns (CVE, severity, CVSS, exposed devices,
# affected software, recommendation) with server-side filtering and cursor
# pagination so large TVM inventories (§9) do not stream fully into the browser.
# Each row carries affectedDeviceIds as the drill-through reference; the
# device drill-through itself is Get-TvmVulnerabilityDevices.
# The worker is read-only: only GET requests are issued.

function Read-TvmVulnerabilitiesJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-TvmVulnerabilities.
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
        TenantId = [string]$json.tenantId
        Severity = if ($json.severity) { [string]$json.severity } else { '' }
        Software = if ($json.software) { [string]$json.software } else { '' }
        Device   = if ($json.device) { [string]$json.device } else { '' }
        Search   = if ($json.search) { [string]$json.search } else { '' }
        CveId    = if ($json.cveId) { [string]$json.cveId } else { '' }
        Top      = if ($json.top) { [int]$json.top } else { 100 }
        Cursor   = if ($json.cursor) { [string]$json.cursor } else { '' }
    }
    return $result
}

function ConvertTo-TvmCursor {
    param([int]$Offset)
    if ($Offset -le 0) { return '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("offset:$Offset")
    return [System.Convert]::ToBase64String($bytes)
}

function ConvertFrom-TvmCursor {
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

function ConvertTo-TvmVulnerabilityRow {
    param(
        [object]$Entry
    )

    $cve = if ($Entry.cveId) { [string]$Entry.cveId }
           elseif ($Entry.cve) { [string]$Entry.cve }
           elseif ($Entry.id) { [string]$Entry.id }
           else { '' }
    $severity = if ($Entry.severity) { [string]$Entry.severity } else { '' }

    $cvss = 0.0
    $cvssRaw = $null
    if ($null -ne $Entry.cvssScore) { $cvssRaw = $Entry.cvssScore }
    elseif ($null -ne $Entry.cvss) { $cvssRaw = $Entry.cvss }
    elseif ($null -ne $Entry.cvss3) { $cvssRaw = $Entry.cvss3 }
    if ($null -ne $cvssRaw) {
        try { $cvss = [double]$cvssRaw } catch { $cvss = 0.0 }
    }

    $exposedCount = 0
    if ($null -ne $Entry.exposedDeviceCount) {
        try { $exposedCount = [int]$Entry.exposedDeviceCount } catch { $exposedCount = 0 }
    }

    $software = @()
    $softwareRaw = $null
    if ($null -ne $Entry.affectedSoftware) { $softwareRaw = $Entry.affectedSoftware }
    elseif ($null -ne $Entry.affectedProducts) { $softwareRaw = $Entry.affectedProducts }
    foreach ($s in @($softwareRaw)) {
        if ($null -eq $s) { continue }
        if ($s -is [string]) {
            if (-not [string]::IsNullOrWhiteSpace($s)) { $software += $s }
        }
        elseif ($s.name) { $software += [string]$s.name }
        elseif ($s.product) { $software += [string]$s.product }
        else { $software += [string]$s }
    }

    $recommendation = if ($Entry.remediation) { [string]$Entry.remediation }
                      elseif ($Entry.recommendation) { [string]$Entry.recommendation }
                      else { '' }

    $deviceIds = @()
    foreach ($d in @($Entry.vulnerableDevices)) {
        if ($null -eq $d) { continue }
        if ($d -is [string]) {
            if (-not [string]::IsNullOrWhiteSpace($d)) { $deviceIds += $d }
        }
        elseif ($d.id) { $deviceIds += [string]$d.id }
        elseif ($d.deviceId) { $deviceIds += [string]$d.deviceId }
    }
    foreach ($d in @($Entry.exposedDevices)) {
        if ($null -eq $d) { continue }
        if ($d -is [string]) {
            if ((-not [string]::IsNullOrWhiteSpace($d)) -and ($deviceIds -notcontains $d)) { $deviceIds += $d }
        }
        elseif ($d.id) {
            $id = [string]$d.id
            if ($deviceIds -notcontains $id) { $deviceIds += $id }
        }
        elseif ($d.deviceId) {
            $id = [string]$d.deviceId
            if ($deviceIds -notcontains $id) { $deviceIds += $id }
        }
    }
    if ($exposedCount -eq 0) { $exposedCount = $deviceIds.Count }

    return [pscustomobject]@{
        cve                = $cve
        severity           = $severity
        cvss               = $cvss
        exposedDeviceCount = $exposedCount
        affectedSoftware   = @($software)
        recommendation     = $recommendation
        affectedDeviceIds  = @($deviceIds)
    }
}

function Test-TvmVulnerabilityFilter {
    param(
        [object]$Row,
        [string]$Severity = '',
        [string]$Software = '',
        [string]$Device = '',
        [string]$Search = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($Severity)) {
        if ($Row.severity.ToLowerInvariant() -ne $Severity.ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Software)) {
        $term = $Software.ToLowerInvariant()
        $matched = $false
        foreach ($s in @($Row.affectedSoftware)) {
            if ($s -and ([string]$s).ToLowerInvariant().Contains($term)) { $matched = $true; break }
        }
        if (-not $matched) { return $false }
    }

    if (-not [string]::IsNullOrWhiteSpace($Device)) {
        $term = $Device.ToLowerInvariant()
        $matched = $false
        foreach ($d in @($Row.affectedDeviceIds)) {
            if ($d -and ([string]$d).ToLowerInvariant().Contains($term)) { $matched = $true; break }
        }
        if (-not $matched) { return $false }
    }

    if (-not [string]::IsNullOrWhiteSpace($Search)) {
        $term = $Search.ToLowerInvariant()
        if (-not $Row.cve -or -not ([string]$Row.cve).ToLowerInvariant().Contains($term)) {
            return $false
        }
    }

    return $true
}

function ConvertTo-TvmDeviceRow {
    param(
        [object]$Entry
    )

    $id = if ($Entry.id) { [string]$Entry.id }
          elseif ($Entry.deviceId) { [string]$Entry.deviceId }
          elseif ($Entry -is [string]) { [string]$Entry }
          else { '' }
    $deviceName = if ($Entry.deviceName) { [string]$Entry.deviceName }
                  elseif ($Entry.computerName) { [string]$Entry.computerName }
                  else { $id }

    return [pscustomobject]@{
        id         = $id
        deviceName = $deviceName
    }
}

function Get-TvmVulnerabilities {
    <#
    .SYNOPSIS
        Lists tenant TVM vulnerabilities live from the Graph security API with filters.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$Severity = '',

        [Parameter()]
        [string]$Software = '',

        [Parameter()]
        [string]$Device = '',

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $select = 'cveId,severity,cvssScore,exposedDeviceCount,affectedSoftware,remediation'
    $query = "`$select=$select&`$top=999"
    if (-not [string]::IsNullOrWhiteSpace($Severity)) {
        $escaped = $Severity.Replace("'", "''")
        $query += "&`$filter=severity eq '$escaped'"
    }
    $uri = "/v1.0/security/vulnerabilities?$query"

    $allRaw = [System.Collections.Generic.List[object]]::new()
    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        if ($null -ne $response -and $null -ne $response.value) {
            foreach ($entry in @($response.value)) {
                if ($null -ne $entry) {
                    $allRaw.Add($entry)
                }
            }
        }
        $uri = if ($response.'@odata.nextLink') { $response.'@odata.nextLink' } else { $null }
    } while ($uri)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $allRaw) {
        $row = ConvertTo-TvmVulnerabilityRow -Entry $entry
        if (Test-TvmVulnerabilityFilter -Row $row -Severity $Severity -Software $Software -Device $Device -Search $Search) {
            $rows.Add($row)
        }
    }

    $offset = ConvertFrom-TvmCursor -Cursor $Cursor
    if ($offset -lt 0) { $offset = 0 }

    $paged = [System.Collections.Generic.List[object]]::new()
    $end = [System.Math]::Min($offset + $Top, $rows.Count)
    for ($i = $offset; $i -lt $end; $i++) {
        $paged.Add($rows[$i])
    }

    $nextCursor = $null
    if ($end -lt $rows.Count) {
        $nextCursor = ConvertTo-TvmCursor -Offset $end
    }

    return [pscustomobject]@{
        tenantId   = $TenantId
        totalCount = $rows.Count
        items      = @($paged)
        nextCursor = $nextCursor
    }
}

function Get-TvmVulnerabilityDevices {
    <#
    .SYNOPSIS
        Lists the affected devices for one CVE live from the Graph security API.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$CveId,

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $encoded = [System.Uri]::EscapeDataString($CveId)
    $uri = "/v1.0/security/vulnerabilities/$encoded/vulnerableDevices?`$select=id,deviceName&`$top=999"

    $allRaw = [System.Collections.Generic.List[object]]::new()
    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        if ($null -ne $response -and $null -ne $response.value) {
            foreach ($entry in @($response.value)) {
                if ($null -ne $entry) {
                    $allRaw.Add($entry)
                }
            }
        }
        $uri = if ($response.'@odata.nextLink') { $response.'@odata.nextLink' } else { $null }
    } while ($uri)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $allRaw) {
        $rows.Add((ConvertTo-TvmDeviceRow -Entry $entry))
    }

    $offset = ConvertFrom-TvmCursor -Cursor $Cursor
    if ($offset -lt 0) { $offset = 0 }

    $paged = [System.Collections.Generic.List[object]]::new()
    $end = [System.Math]::Min($offset + $Top, $rows.Count)
    for ($i = $offset; $i -lt $end; $i++) {
        $paged.Add($rows[$i])
    }

    $nextCursor = $null
    if ($end -lt $rows.Count) {
        $nextCursor = ConvertTo-TvmCursor -Offset $end
    }

    return [pscustomobject]@{
        tenantId   = $TenantId
        cve        = $CveId
        totalCount = $rows.Count
        items      = @($paged)
        nextCursor = $nextCursor
    }
}
