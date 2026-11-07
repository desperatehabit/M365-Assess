# Get-Connectors.ps1 — EPIC-021 connector list read (SPEC §2 US-3, §3.2, §5, §6).
#
# Live EXO reads only: inbound and outbound connectors are read with
# Get-InboundConnector / Get-OutboundConnector on every call and shaped to the
# §3.2 columns (name, type, state, from, to, TLS, last modified). Filtering and
# cursor paging happen over that single read. Only Get- cmdlets are issued;
# nothing is written to the tenant and nothing is persisted to disk. The caller
# (child entrypoint) runs with the EXO session the supervisor connected after
# materializing the tenant credential in-process; this file never touches
# secrets.

function ConvertTo-ConnectorRow {
    <#
    .SYNOPSIS
        Shapes one inbound or outbound connector into the §3.2 list row.
    .PARAMETER Connector
        The Get-InboundConnector / Get-OutboundConnector record.
    .PARAMETER Type
        'inbound' or 'outbound'.
    .EXAMPLE
        ConvertTo-ConnectorRow -Connector $connector -Type 'inbound'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Connector,

        [Parameter(Mandatory)]
        [ValidateSet('inbound', 'outbound')]
        [string]$Type
    )

    $id = [string]$Connector.Guid
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Connector.Identity
    }
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Connector.Name
    }

    $state = 'disabled'
    if ([string]$Connector.Enabled -eq 'True' -or $Connector.Enabled -eq $true) {
        $state = 'enabled'
    }

    $from = $null
    $to = $null
    if ($Type -eq 'inbound') {
        $from = @($Connector.SenderDomains | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_.Length -gt 0 }) -join ', '
    }
    else {
        $targets = @($Connector.RecipientDomains | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_.Length -gt 0 })
        if ($targets.Count -eq 0) {
            $targets = @($Connector.SmartHosts | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_.Length -gt 0 })
        }
        $to = $targets -join ', '
    }

    $tls = $null
    if ($null -ne $Connector.RequireTls) {
        $tls = [bool]$Connector.RequireTls
    }
    elseif ($null -ne $Connector.TlsSettings) {
        $tls = ([string]$Connector.TlsSettings).ToLowerInvariant() -ne 'opportunistic'
    }

    $lastModified = $null
    foreach ($field in @('WhenChangedUTC', 'WhenChanged')) {
        $raw = [string]$Connector.$field
        if ($raw.Trim().Length -gt 0) {
            $lastModified = $raw.Trim()
            break
        }
    }

    return [pscustomobject]@{
        id           = $id
        name         = [string]$Connector.Name
        type         = $Type
        state        = $state
        from         = if ($from.Length -gt 0) { $from } else { $null }
        to           = if ($to.Length -gt 0) { $to } else { $null }
        tls          = $tls
        lastModified = $lastModified
    }
}

function Test-ConnectorFilter {
    <#
    .SYNOPSIS
        Applies the list filters to one shaped connector row.
    .PARAMETER Row
        The ConvertTo-ConnectorRow result.
    .PARAMETER Search
        Case-insensitive substring match against the connector name.
    .PARAMETER Type
        Keeps inbound, outbound, or all when empty.
    .PARAMETER State
        Keeps enabled, disabled, or all when empty.
    .EXAMPLE
        Test-ConnectorFilter -Row $row -State 'enabled'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [string]$Type = '',

        [Parameter()]
        [string]$State = ''
    )

    if ($Search.Trim().Length -gt 0) {
        $needle = $Search.Trim().ToLowerInvariant()
        if (-not ([string]$Row.name).ToLowerInvariant().Contains($needle)) {
            return $false
        }
    }
    if ($Type.Trim().Length -gt 0 -and [string]$Row.type -ne $Type.Trim().ToLowerInvariant()) {
        return $false
    }
    if ($State.Trim().Length -gt 0 -and [string]$Row.state -ne $State.Trim().ToLowerInvariant()) {
        return $false
    }
    return $true
}

function Get-Connectors {
    <#
    .SYNOPSIS
        Lists tenant connectors live from Exchange Online with §3.2 columns.
    .DESCRIPTION
        Reads inbound and outbound connectors once, shapes the §3.2 rows ordered
        by type then name, applies the requested filters, and returns one cursor
        page. Only Get- cmdlets are issued; nothing is written to the tenant and
        nothing is persisted.
    .PARAMETER TenantId
        Tenant the connectors belong to. Carried through to the result envelope.
    .PARAMETER Search
        Case-insensitive substring match against the connector name.
    .PARAMETER Type
        Filter by connector type: inbound, outbound, or empty for all.
    .PARAMETER State
        Filter by connector state: enabled, disabled, or empty for all.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-Connectors -TenantId 'tenant-a' -Type 'inbound' -Top 50
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [ValidateSet('', 'inbound', 'outbound')]
        [string]$Type = '',

        [Parameter()]
        [ValidateSet('', 'enabled', 'disabled')]
        [string]$State = '',

        [Parameter()]
        [ValidateRange(1, 999)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($connector in @(Get-InboundConnector -ErrorAction Stop)) {
        if ($null -eq $connector) { continue }
        $rows.Add((ConvertTo-ConnectorRow -Connector $connector -Type 'inbound'))
    }
    foreach ($connector in @(Get-OutboundConnector -ErrorAction Stop)) {
        if ($null -eq $connector) { continue }
        $rows.Add((ConvertTo-ConnectorRow -Connector $connector -Type 'outbound'))
    }

    $filtered = @($rows | Where-Object { Test-ConnectorFilter -Row $_ -Search $Search -Type $Type -State $State })
    $ordered = @($filtered | Sort-Object -Property @{ Expression = { $_.type }; Ascending = $true }, @{ Expression = { $_.name }; Ascending = $true })
    $offset = ConvertFrom-ConnectorsCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-ConnectorsCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Read-ConnectorsJob {
    <#
    .SYNOPSIS
        Reads a flat job envelope file into Get-Connectors parameters.
    .DESCRIPTION
        Validates the envelope carries a tenant, then merges the optional filter
        fields. The envelope carries references only; secrets are never present
        and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-ConnectorsJob -Path './run/connectors-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Connectors job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $job.tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }

    return @{
        TenantId = [string]$job.tenantId
        Search   = if ($job.search) { [string]$job.search } else { '' }
        Type     = if ($job.type) { [string]$job.type } else { '' }
        State    = if ($job.state) { [string]$job.state } else { '' }
        Top      = if ($job.top) { [int]$job.top } else { 100 }
        Cursor   = if ($job.cursor) { [string]$job.cursor } else { '' }
    }
}

function ConvertTo-ConnectorsCursor {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-ConnectorsCursor {
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter()]
        [string]$Cursor = ''
    )

    if ([string]::IsNullOrWhiteSpace($Cursor)) {
        return 0
    }
    try {
        $text = $Cursor.Trim().Replace('-', '+').Replace('_', '/')
        $pad = (4 - ($text.Length % 4)) % 4
        $text += ('=' * $pad)
        $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text))
        $offset = 0
        if ([int]::TryParse($decoded, [ref]$offset) -and $offset -ge 0) {
            return $offset
        }
    }
    catch {
        Write-Verbose 'Ignoring undecodable connectors cursor and starting at the first page.'
    }
    return 0
}
