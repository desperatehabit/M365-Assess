# Get-Incidents.ps1 — EPIC-028 incident list worker (SPEC §2 US-1, §3.1, §4.2, §5, §6, §7; T-0543).
#
# Live Graph reads only: incidents are never mirrored to disk (SPEC §5).
# Each Graph security incident is normalized onto the §3.1 columns (Title,
# Severity, Status, Classification, Assigned to, Alerts, Last updated, Tenant)
# following the T-0542 normalized-model pattern: severity/status values are
# mapped case-insensitively and unmappable values fall back to 'unknown'
# rather than silently coercing to an empty row.
# The worker is read-only: only GET requests are issued.

function Read-IncidentsJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-Incidents.
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
        TenantId       = [string]$json.tenantId
        Severity       = if ($json.severity) { [string]$json.severity } else { '' }
        Status         = if ($json.status) { [string]$json.status } else { '' }
        Classification = if ($json.classification) { [string]$json.classification } else { '' }
        Assigned       = if ($json.assigned) { [string]$json.assigned } else { '' }
        From           = if ($json.from) { [string]$json.from } else { '' }
        To             = if ($json.to) { [string]$json.to } else { '' }
        Top            = if ($json.top) { [int]$json.top } else { 100 }
        Cursor         = if ($json.cursor) { [string]$json.cursor } else { '' }
    }
    return $result
}

function ConvertTo-IncidentsCursor {
    param([int]$Offset)
    if ($Offset -le 0) { return '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("offset:$Offset")
    return [System.Convert]::ToBase64String($bytes)
}

function ConvertFrom-IncidentsCursor {
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

$script:IncidentSeverityByKey = @{
    'unknown'       = 'unknown'
    'informational' = 'informational'
    'low'           = 'low'
    'medium'        = 'medium'
    'high'          = 'high'
}

$script:IncidentStatusByKey = @{
    'active'    = 'active'
    'resolved'  = 'resolved'
    'redirected' = 'redirected'
    'unknown'   = 'unknown'
}

$script:IncidentClassificationByKey = @{
    'unknown'                      = 'unknown'
    'falsepositive'                = 'falsePositive'
    'truepositive'                 = 'truePositive'
    'informationalexpectedactivity' = 'informationalExpectedActivity'
    'benignpositive'               = 'benignPositive'
}

function ConvertTo-IncidentSeverity {
    param($Value)
    if ($Value -is [string] -and -not [string]::IsNullOrWhiteSpace($Value)) {
        $key = $Value.Trim().ToLowerInvariant()
        if ($script:IncidentSeverityByKey.ContainsKey($key)) {
            return $script:IncidentSeverityByKey[$key]
        }
    }
    return 'unknown'
}

function ConvertTo-IncidentStatus {
    param($Value)
    if ($Value -is [string] -and -not [string]::IsNullOrWhiteSpace($Value)) {
        $key = $Value.Trim().ToLowerInvariant()
        if ($script:IncidentStatusByKey.ContainsKey($key)) {
            return $script:IncidentStatusByKey[$key]
        }
    }
    return 'unknown'
}

function ConvertTo-IncidentClassification {
    param($Value)
    if ($Value -is [string] -and -not [string]::IsNullOrWhiteSpace($Value)) {
        $key = $Value.Trim().ToLowerInvariant()
        if ($script:IncidentClassificationByKey.ContainsKey($key)) {
            return $script:IncidentClassificationByKey[$key]
        }
    }
    return 'unknown'
}

function ConvertTo-IncidentRow {
    param(
        [object]$Entry,
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId
    )

    $id = if ($Entry.id) { [string]$Entry.id } else { '' }
    $title = if ($Entry.displayName) { [string]$Entry.displayName } elseif ($Entry.title) { [string]$Entry.title } else { '' }

    $assignedTo = ''
    if ($Entry.assignedTo -is [string] -and -not [string]::IsNullOrWhiteSpace($Entry.assignedTo)) {
        $assignedTo = [string]$Entry.assignedTo
    }
    elseif ($null -ne $Entry.assignedTo -and $Entry.assignedTo.upn) {
        $assignedTo = [string]$Entry.assignedTo.upn
    }
    elseif ($null -ne $Entry.assignedTo -and $Entry.assignedTo.displayName) {
        $assignedTo = [string]$Entry.assignedTo.displayName
    }

    $alertCount = 0
    if ($null -ne $Entry.'alerts@odata.count') {
        $alertCount = [int]$Entry.'alerts@odata.count'
    }
    elseif ($null -ne $Entry.alertCount) {
        $alertCount = [int]$Entry.alertCount
    }
    elseif ($Entry.alerts -is [System.Collections.IEnumerable] -and $Entry.alerts -isnot [string]) {
        $alertCount = @($Entry.alerts).Count
    }

    $lastUpdated = ''
    if ($Entry.lastUpdateDateTime) { $lastUpdated = [string]$Entry.lastUpdateDateTime }
    elseif ($Entry.lastUpdatedDateTime) { $lastUpdated = [string]$Entry.lastUpdatedDateTime }

    return [pscustomobject]@{
        id             = $id
        title          = $title
        severity       = (ConvertTo-IncidentSeverity -Value $Entry.severity)
        status         = (ConvertTo-IncidentStatus -Value $Entry.status)
        classification = (ConvertTo-IncidentClassification -Value $Entry.classification)
        assignedTo     = $assignedTo
        alertCount     = $alertCount
        lastUpdated    = $lastUpdated
        tenantId       = $TenantId
    }
}

function Test-IncidentFilter {
    param(
        [object]$Row,
        [string]$Severity = '',
        [string]$Status = '',
        [string]$Classification = '',
        [string]$Assigned = '',
        [string]$From = '',
        [string]$To = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($Severity)) {
        if ($Row.severity.ToLowerInvariant() -ne $Severity.Trim().ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Status)) {
        if ($Row.status.ToLowerInvariant() -ne $Status.Trim().ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Classification)) {
        if ($Row.classification.ToLowerInvariant() -ne $Classification.Trim().ToLowerInvariant()) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Assigned)) {
        $term = $Assigned.Trim().ToLowerInvariant()
        if ($term -in @('unassigned', 'none', '')) {
            if (-not [string]::IsNullOrWhiteSpace($Row.assignedTo)) { return $false }
        }
        elseif ([string]::IsNullOrWhiteSpace($Row.assignedTo) -or -not $Row.assignedTo.ToLowerInvariant().Contains($term)) {
            return $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($From) -or -not [string]::IsNullOrWhiteSpace($To)) {
        $rowTime = [datetime]::MinValue
        try { $rowTime = [datetime]$Row.lastUpdated } catch { return $false }
        if (-not [string]::IsNullOrWhiteSpace($From)) {
            try {
                if ($rowTime -lt [datetime]$From) { return $false }
            }
            catch { return $false }
        }
        if (-not [string]::IsNullOrWhiteSpace($To)) {
            try {
                if ($rowTime -gt [datetime]$To) { return $false }
            }
            catch { return $false }
        }
    }

    return $true
}

function Get-Incidents {
    <#
    .SYNOPSIS
        Lists tenant security incidents live from Microsoft Graph with §3.1 normalization and filters.
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
        [string]$Status = '',

        [Parameter()]
        [string]$Classification = '',

        [Parameter()]
        [string]$Assigned = '',

        [Parameter()]
        [string]$From = '',

        [Parameter()]
        [string]$To = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $allRaw = [System.Collections.Generic.List[object]]::new()
    $uri = '/v1.0/security/incidents?$top=100'

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
        $row = ConvertTo-IncidentRow -Entry $entry -TenantId $TenantId
        if (Test-IncidentFilter -Row $row -Severity $Severity -Status $Status -Classification $Classification -Assigned $Assigned -From $From -To $To) {
            $rows.Add($row)
        }
    }

    $offset = ConvertFrom-IncidentsCursor -Cursor $Cursor
    if ($offset -lt 0) { $offset = 0 }

    $paged = [System.Collections.Generic.List[object]]::new()
    $end = [System.Math]::Min($offset + $Top, $rows.Count)
    for ($i = $offset; $i -lt $end; $i++) {
        $paged.Add($rows[$i])
    }

    $nextCursor = $null
    if ($end -lt $rows.Count) {
        $nextCursor = ConvertTo-IncidentsCursor -Offset $end
    }

    return [pscustomobject]@{
        tenantId   = $TenantId
        totalCount = $rows.Count
        items      = @($paged)
        nextCursor = $nextCursor
    }
}
