# Get-Alerts.ps1 — EPIC-028 alert list worker (SPEC §2 US-4, §3.3, §6, §7, §9,
# §11 item 2; T-0548).
#
# Live Graph reads only: alerts are never mirrored to disk (SPEC §5). Each
# Microsoft Graph security alert (security/alerts_v2) is normalized onto the
# T-0542 model (portal/contracts/src/alerts.ts): schemaVersion/id/source/title/
# severity/status/entity/created/incidentId/passthrough. Defender, Defender for
# Office 365 (MDO), and Graph-sourced alerts share the alerts_v2 shape, so the
# source is derived from serviceSource and unmappable severity/status values
# fall back to 'unknown' rather than silently coercing to an empty row.
# The worker is read-only: only GET requests are issued.

function Read-AlertsJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-Alerts.
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
        Source   = if ($json.source) { [string]$json.source } else { '' }
        Severity = if ($json.severity) { [string]$json.severity } else { '' }
        Status   = if ($json.status) { [string]$json.status } else { '' }
        Top      = if ($json.top) { [int]$json.top } else { 100 }
        Cursor   = if ($json.cursor) { [string]$json.cursor } else { '' }
    }
    return $result
}

function ConvertTo-AlertsCursor {
    param([int]$Offset)
    if ($Offset -le 0) { return '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("offset:$Offset")
    return [System.Convert]::ToBase64String($bytes)
}

function ConvertFrom-AlertsCursor {
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

$script:AlertSeverityByKey = @{
    'unknown'       = 'unknown'
    'informational' = 'informational'
    'low'           = 'low'
    'medium'        = 'medium'
    'high'          = 'high'
}

$script:AlertStatusByKey = @{
    'unknown'    = 'unknown'
    'new'        = 'new'
    'inprogress' = 'inProgress'
    'resolved'   = 'resolved'
}

$script:AlertConsumedKeys = @(
    'id'
    'title'
    'severity'
    'status'
    'createdDateTime'
    'incidentId'
    'actorDisplayName'
    'evidence'
    '@odata.type'
)

function Get-AlertPropertyValue {
    param(
        [object]$Object,
        [string[]]$Names
    )

    if ($null -eq $Object) { return $null }
    foreach ($name in $Names) {
        $value = $Object.$name
        if ($value -is [string] -and -not [string]::IsNullOrWhiteSpace($value)) {
            return $value
        }
    }
    return $null
}

function ConvertTo-AlertKey {
    param([string]$Value)
    return ($Value -replace '[^a-zA-Z0-9]', '').ToLowerInvariant()
}

function ConvertTo-AlertSource {
    <#
    .SYNOPSIS
        Maps a raw alerts_v2 service source onto the T-0542 source vocabulary.
    .DESCRIPTION
        Defender for Office 365 maps to 'mdo', any other Defender product to
        'defender', and everything else (e.g. Azure AD Identity Protection) to
        'graph'. An absent or unmappable value is treated as 'graph'.
    #>
    param([object]$Value)

    if ($Value -is [string] -and -not [string]::IsNullOrWhiteSpace($Value)) {
        $key = ConvertTo-AlertKey -Value $Value
        if ($key.Contains('office365')) { return 'mdo' }
        if ($key.Contains('defender')) { return 'defender' }
    }
    return 'graph'
}

function Get-AlertRawSource {
    param([object]$Entry)

    $value = Get-AlertPropertyValue -Object $Entry -Names @('serviceSource', 'detectionSource', 'providerName')
    if ($null -ne $value) { return $value }
    if ($null -ne $Entry.vendorInformation) {
        return Get-AlertPropertyValue -Object $Entry.vendorInformation -Names @('provider')
    }
    return ''
}

function ConvertTo-AlertSeverity {
    param($Value)

    if ($Value -is [string] -and -not [string]::IsNullOrWhiteSpace($Value)) {
        $key = ConvertTo-AlertKey -Value $Value
        if ($script:AlertSeverityByKey.ContainsKey($key)) {
            return $script:AlertSeverityByKey[$key]
        }
    }
    return 'unknown'
}

function ConvertTo-AlertStatus {
    param($Value)

    if ($Value -is [string] -and -not [string]::IsNullOrWhiteSpace($Value)) {
        $key = ConvertTo-AlertKey -Value $Value
        if ($script:AlertStatusByKey.ContainsKey($key)) {
            return $script:AlertStatusByKey[$key]
        }
    }
    return 'unknown'
}

function ConvertTo-AlertEntityKind {
    param([string]$Type)

    $normalized = $Type.ToLowerInvariant()
    foreach ($kind in @('user', 'device', 'mailbox', 'process', 'url', 'file', 'ip')) {
        if ($normalized.Contains($kind)) { return $kind }
    }
    return $null
}

function New-AlertEntity {
    param(
        [string]$Kind,
        [object]$DisplayName,
        [object]$Id
    )

    $entity = @{ kind = $Kind }
    if ($DisplayName -is [string] -and -not [string]::IsNullOrWhiteSpace($DisplayName)) {
        $entity['displayName'] = $DisplayName
    }
    if ($Id -is [string] -and -not [string]::IsNullOrWhiteSpace($Id)) {
        $entity['id'] = $Id
    }
    return $entity
}

function ConvertTo-AlertEntity {
    <#
    .SYNOPSIS
        Shapes the first mappable evidence item into a T-0542 alert entity.
    #>
    param([object]$Entry)

    if ($null -ne $Entry.evidence) {
        foreach ($item in @($Entry.evidence)) {
            if ($null -eq $item) { continue }
            $type = Get-AlertPropertyValue -Object $item -Names @('@odata.type', 'evidenceType', 'type')
            if ($null -eq $type) { continue }
            $kind = ConvertTo-AlertEntityKind -Type $type
            if ($null -eq $kind) { continue }

            switch ($kind) {
                'user' {
                    $account = $item.userAccount
                    $target = if ($null -ne $account) { $account } else { $item }
                    $displayName = Get-AlertPropertyValue -Object $target -Names @('displayName', 'accountName', 'userPrincipalName')
                    $id = Get-AlertPropertyValue -Object $target -Names @('azureAdUserId', 'accountName', 'userPrincipalName')
                    return New-AlertEntity -Kind $kind -DisplayName $displayName -Id $id
                }
                'device' {
                    $displayName = Get-AlertPropertyValue -Object $item -Names @('deviceDnsName', 'displayName')
                    $id = Get-AlertPropertyValue -Object $item -Names @('mdeDeviceId', 'azureAdDeviceId', 'deviceId')
                    return New-AlertEntity -Kind $kind -DisplayName $displayName -Id $id
                }
                'mailbox' {
                    $displayName = Get-AlertPropertyValue -Object $item -Names @('primaryAddress', 'mailboxPrimaryAddress', 'displayName')
                    $id = Get-AlertPropertyValue -Object $item -Names @('primaryAddress', 'mailboxPrimaryAddress')
                    return New-AlertEntity -Kind $kind -DisplayName $displayName -Id $id
                }
                'ip' {
                    $displayName = Get-AlertPropertyValue -Object $item -Names @('ipAddress', 'address')
                    return New-AlertEntity -Kind $kind -DisplayName $displayName -Id $null
                }
                'file' {
                    $displayName = Get-AlertPropertyValue -Object $item -Names @('fileName', 'displayName')
                    $id = Get-AlertPropertyValue -Object $item -Names @('fileHash', 'sha256', 'filePath')
                    return New-AlertEntity -Kind $kind -DisplayName $displayName -Id $id
                }
                'url' {
                    $displayName = Get-AlertPropertyValue -Object $item -Names @('url', 'displayName')
                    return New-AlertEntity -Kind $kind -DisplayName $displayName -Id $null
                }
                'process' {
                    $displayName = Get-AlertPropertyValue -Object $item -Names @('processFilePath', 'displayName')
                    $id = Get-AlertPropertyValue -Object $item -Names @('processId')
                    return New-AlertEntity -Kind $kind -DisplayName $displayName -Id $id
                }
                default { return New-AlertEntity -Kind $kind -DisplayName $null -Id $null }
            }
        }
    }

    $actor = Get-AlertPropertyValue -Object $Entry -Names @('actorDisplayName')
    if ($null -ne $actor) {
        return New-AlertEntity -Kind 'unknown' -DisplayName $actor -Id $null
    }
    return $null
}

function ConvertTo-AlertPassthrough {
    <#
    .SYNOPSIS
        Collects every alerts_v2 field the canonical model does not consume.
    #>
    param([object]$Entry)

    $passthrough = @{}
    if ($Entry -is [System.Collections.IDictionary]) {
        foreach ($key in $Entry.Keys) {
            if ($script:AlertConsumedKeys -contains [string]$key) { continue }
            $passthrough[[string]$key] = $Entry[$key]
        }
        return $passthrough
    }
    foreach ($property in $Entry.PSObject.Properties) {
        if ($script:AlertConsumedKeys -contains $property.Name) { continue }
        $passthrough[$property.Name] = $property.Value
    }
    return $passthrough
}

function ConvertTo-AlertRow {
    param(
        [object]$Entry,
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId
    )

    $id = if ($Entry.id) { [string]$Entry.id } else { '' }
    $title = if ($Entry.title) { [string]$Entry.title } else { '' }
    $created = if ($Entry.createdDateTime) { [string]$Entry.createdDateTime } else { '' }

    $incidentId = $null
    if ($Entry.incidentId -is [string] -and -not [string]::IsNullOrWhiteSpace($Entry.incidentId)) {
        $incidentId = [string]$Entry.incidentId
    }

    return [pscustomobject]@{
        schemaVersion = 'v1'
        id            = $id
        source        = ConvertTo-AlertSource -Value (Get-AlertRawSource -Entry $Entry)
        title         = $title
        severity      = ConvertTo-AlertSeverity -Value $Entry.severity
        status        = ConvertTo-AlertStatus -Value $Entry.status
        entity        = ConvertTo-AlertEntity -Entry $Entry
        created       = $created
        incidentId    = $incidentId
        passthrough   = ConvertTo-AlertPassthrough -Entry $Entry
    }
}

function Test-AlertFilter {
    param(
        [object]$Row,
        [string]$Source = '',
        [string]$Severity = '',
        [string]$Status = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($Source)) {
        if ($Row.source.ToLowerInvariant() -ne $Source.Trim().ToLowerInvariant()) {
            return $false
        }
    }

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

    return $true
}

function Get-Alerts {
    <#
    .SYNOPSIS
        Lists tenant security alerts live from Microsoft Graph with T-0542 normalization.
    .DESCRIPTION
        Reads security/alerts_v2 (Defender/MDO/Graph share this shape), maps each
        alert onto the normalized model, applies the source/severity/status
        filters, and returns an offset-cursor page. Only GET requests are issued.
    .PARAMETER TenantId
        Tenant the alerts belong to. Stamped on the page envelope.
    .PARAMETER Source
        Optional source filter: defender, mdo, or graph.
    .PARAMETER Severity
        Optional severity filter.
    .PARAMETER Status
        Optional status filter.
    .PARAMETER Top
        Page size, 1-1000.
    .PARAMETER Cursor
        Opaque cursor returned by a previous call.
    .EXAMPLE
        Get-Alerts -TenantId 'tenant-a' -Source 'mdo' -Top 50
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$Source = '',

        [Parameter()]
        [string]$Severity = '',

        [Parameter()]
        [string]$Status = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $allRaw = [System.Collections.Generic.List[object]]::new()
    $uri = '/v1.0/security/alerts_v2?$top=100'

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
        $row = ConvertTo-AlertRow -Entry $entry -TenantId $TenantId
        if ([string]::IsNullOrWhiteSpace($row.id)) { continue }
        if (Test-AlertFilter -Row $row -Source $Source -Severity $Severity -Status $Status) {
            $rows.Add($row)
        }
    }

    $offset = ConvertFrom-AlertsCursor -Cursor $Cursor
    if ($offset -lt 0) { $offset = 0 }

    $paged = [System.Collections.Generic.List[object]]::new()
    $end = [System.Math]::Min($offset + $Top, $rows.Count)
    for ($i = $offset; $i -lt $end; $i++) {
        $paged.Add($rows[$i])
    }

    $nextCursor = $null
    if ($end -lt $rows.Count) {
        $nextCursor = ConvertTo-AlertsCursor -Offset $end
    }

    return [pscustomobject]@{
        tenantId   = $TenantId
        totalCount = $rows.Count
        items      = @($paged)
        nextCursor = $nextCursor
    }
}
