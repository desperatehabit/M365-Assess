# Get-DomainInventory.ps1 — EPIC-034 Domain inventory read (SPEC §3.1, §4.1, §6; T-0662).
#
# Live Graph reads only: domains are never mirrored to disk.
# Emits domain rows with type, verification state, MX target, and the latest
# stored DNS health/last-checked from DomainCheck history.
# The worker is read-only: only GET requests are issued.

function Read-DomainInventoryJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-DomainInventory.
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
        TenantId     = [string]$json.tenantId
        Top          = if ($json.top) { [int]$json.top } else { 100 }
        Cursor       = if ($json.cursor) { [string]$json.cursor } else { '' }
        LatestChecks = if ($null -ne $json.latestChecks) { @($json.latestChecks) } else { @() }
    }
    return $result
}

function ConvertTo-DomainCursor {
    param([int]$Offset)
    if ($Offset -le 0) { return '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("offset:$Offset")
    return [System.Convert]::ToBase64String($bytes)
}

function ConvertFrom-DomainCursor {
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

function ConvertTo-DomainRow {
    param(
        [object]$Domain,
        [object]$LatestCheck
    )

    $id = if ($Domain.id) { [string]$Domain.id } else { '' }
    $name = if ($Domain.name) { [string]$Domain.name } else { '' }
    $isInitial = if ($Domain.isInitial -eq $true) { $true } else { $false }
    $isVerified = if ($Domain.isVerified -eq $true) { $true } else { $false }
    $isManaged = if ($Domain.isManaged -eq $true) { $true } else { $false }

    # Type: initial / verified / managed
    $type = if ($isInitial) { 'initial' }
    elseif ($isManaged) { 'managed' }
    elseif ($isVerified) { 'verified' }
    else { 'unknown' }

    # Verification state
    $verification = if ($isVerified) { 'verified' } else { 'unverified' }

    # Services (MX target) from serviceConfigurationRecords or MX record
    $mxTarget = ''
    $serviceRecords = if ($Domain.serviceConfigurationRecords) { @($Domain.serviceConfigurationRecords) } else { @() }
    foreach ($record in $serviceRecords) {
        if ($record.recordType -eq 'MX' -and $record.recordValue) {
            $mxTarget = [string]$record.recordValue
            break
        }
    }

    # Latest DNS health from DomainCheck history
    $dnsHealth = $null
    $lastChecked = $null
    if ($LatestCheck) {
        $healthObj = if ($LatestCheck.health) { $LatestCheck.health | ConvertFrom-Json } else { $null }
        if ($healthObj) {
            $overall = if ($healthObj.overall) { [string]$healthObj.overall } else { '' }
            $dnsHealth = $overall
        }
        # ConvertFrom-Json parses ISO 'at' strings into [datetime]; render them back as
        # ISO 8601 UTC so the API contract does not depend on the host locale.
        $atValue = $LatestCheck.at
        if ($atValue -is [datetime]) {
            $utc = $atValue.ToUniversalTime()
            $lastChecked = if ($utc.Millisecond -gt 0) {
                $utc.ToString("yyyy-MM-dd'T'HH:mm:ss'.'fff'Z'")
            } else {
                $utc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
            }
        }
        elseif ($null -ne $atValue) {
            $lastChecked = [string]$atValue
        }
    }

    return [pscustomobject]@{
        domain         = $name
        type           = $type
        verification   = $verification
        dnsHealth      = $dnsHealth
        services       = $mxTarget
        lastChecked    = $lastChecked
    }
}

function Get-DomainInventory {
    <#
    .SYNOPSIS
        Queries domains live from Graph and joins latest DNS health from DomainCheck history.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = '',

        [Parameter()]
        [object[]]$LatestChecks = @()
    )

    # Get domains from Graph
    $graphParams = @{
        Method      = 'GET'
        Uri         = '/v1.0/domains'
        ErrorAction = 'Stop'
    }

    $response = Invoke-MgGraphRequest @graphParams
    $rawList = @()
    if ($response -and $response['value']) {
        $rawList = @($response['value'])
    }
    elseif ($response -and $response.value) {
        $rawList = @($response.value)
    }

    # Get latest DomainCheck per domain from the portal database
    # The worker receives the latest checks via the job envelope (passed by BFF)
    # For now, we accept an optional -LatestChecks parameter that the BFF populates
    # This will be populated by the BFF from the database before calling the worker
    $latestChecksMap = @{}
    if ($PSBoundParameters.ContainsKey('LatestChecks') -and $LatestChecks) {
        foreach ($check in $LatestChecks) {
            $domainName = [string]$check.domain
            if (-not $latestChecksMap.ContainsKey($domainName)) {
                $latestChecksMap[$domainName] = $check
            }
        }
    }

    $allRows = @()
    foreach ($item in $rawList) {
        $latest = $null
        $domainName = if ($item.name) { [string]$item.name } else { '' }
        if ($domainName -and $latestChecksMap.ContainsKey($domainName)) {
            $latest = $latestChecksMap[$domainName]
        }
        $allRows += ConvertTo-DomainRow -Domain $item -LatestCheck $latest
    }

    $totalCount = $allRows.Count
    $offset = ConvertFrom-DomainCursor -Cursor $Cursor
    if ($offset -lt 0) { $offset = 0 }
    if ($offset -gt $totalCount) { $offset = $totalCount }

    $page = @()
    if ($offset -lt $totalCount) {
        $count = [Math]::Min($Top, ($totalCount - $offset))
        $page = $allRows[$offset..($offset + $count - 1)]
    }

    $nextOffset = $offset + $page.Count
    $nextCursor = $null
    if ($nextOffset -lt $totalCount) {
        $nextCursor = ConvertTo-DomainCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId   = $TenantId
        totalCount = $totalCount
        items      = @($page)
        nextCursor = $nextCursor
    }
}