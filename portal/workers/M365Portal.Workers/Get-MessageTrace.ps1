# Get-MessageTrace.ps1 — EPIC-024 message trace worker (SPEC §2 US-1, §3.1, §4.1, §6, §9; T-0462).
#
# Live EXO reads only: traces messages through Get-MessageTraceV2 filtered by
# sender, recipient, subject, date range, and status, and shapes the §3.1
# results table (Timestamp · Sender · Recipient · Subject · Status · Event)
# with cursor paging. The EXO trace window is validated before the read and a
# structured error naming the limit is thrown when the requested range exceeds
# it, guiding the caller to historical search (§9). Only Get- cmdlets are
# issued; nothing is written to the tenant and message data is never mirrored
# to disk. The caller (child entrypoint) runs with the EXO session the
# supervisor connected after materializing the tenant credential in-process;
# this file never touches secrets.

# Get-MessageTraceV2 returns trace data for the last 10 days; older messages
# require historical search (SPEC §9).
$script:MessageTraceWindowDays = 10

function Get-MessageTraceWindowDays {
    <#
    .SYNOPSIS
        Returns the EXO message trace window in days.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param()

    return $script:MessageTraceWindowDays
}

function ConvertTo-MessageTraceDate {
    <#
    .SYNOPSIS
        Parses a filter date into a datetime, throwing a structured error when unparsable.
    #>
    [CmdletBinding()]
    [OutputType([datetime])]
    param(
        [Parameter(Mandatory)]
        [string]$Value,

        [Parameter(Mandatory)]
        [string]$Field
    )

    try {
        return [datetime]$Value
    }
    catch {
        throw "message-trace.invalid_date: $Field '$Value' is not a parseable datetime"
    }
}

function Test-MessageTraceWindow {
    <#
    .SYNOPSIS
        Validates a requested date range against the EXO message trace window.
    .DESCRIPTION
        A range is rejected when either end is older than the trace window, when
        the start follows the end, or when the span exceeds the window. The
        window error names the limit and points at historical search (SPEC §9).
        Empty ends are skipped so the caller can default them first.
    .PARAMETER StartDate
        Requested window start (parseable datetime) or empty.
    .PARAMETER EndDate
        Requested window end (parseable datetime) or empty.
    .PARAMETER Now
        Reference instant for the window boundary; defaults to the current UTC time.
    .EXAMPLE
        Test-MessageTraceWindow -StartDate '2026-09-01T00:00:00Z' -EndDate '2026-09-28T00:00:00Z'
    #>
    [CmdletBinding()]
    [OutputType([void])]
    param(
        [Parameter()]
        [string]$StartDate = '',

        [Parameter()]
        [string]$EndDate = '',

        [Parameter()]
        [datetime]$Now = (Get-Date).ToUniversalTime()
    )

    $window = $script:MessageTraceWindowDays
    $oldest = $Now.ToUniversalTime().AddDays(-$window)

    $hasStart = $StartDate.Trim().Length -gt 0
    $hasEnd = $EndDate.Trim().Length -gt 0
    if (-not $hasStart -and -not $hasEnd) {
        return
    }

    $start = $null
    $end = $null
    if ($hasStart) {
        $start = ConvertTo-MessageTraceDate -Value $StartDate -Field 'startDate'
        if ($start.ToUniversalTime() -lt $oldest) {
            throw "message-trace.window_exceeded: the EXO message trace window is $window days; start date '$StartDate' is outside the window. Use historical search for older messages."
        }
    }
    if ($hasEnd) {
        $end = ConvertTo-MessageTraceDate -Value $EndDate -Field 'endDate'
        if ($end.ToUniversalTime() -lt $oldest) {
            throw "message-trace.window_exceeded: the EXO message trace window is $window days; end date '$EndDate' is outside the window. Use historical search for older messages."
        }
    }
    if ($null -ne $start -and $null -ne $end) {
        if ($start.ToUniversalTime() -gt $end.ToUniversalTime()) {
            throw "message-trace.invalid_date_range: start date '$StartDate' is after end date '$EndDate'"
        }
        $spanDays = ($end.ToUniversalTime() - $start.ToUniversalTime()).Days
        if ($spanDays -gt $window) {
            throw "message-trace.window_exceeded: the EXO message trace window is $window days; the requested range spans $spanDays days. Use historical search for older messages."
        }
    }
}

function ConvertTo-MessageTraceRow {
    <#
    .SYNOPSIS
        Shapes one Get-MessageTraceV2 record into the §3.1 results-table row.
    .DESCRIPTION
        Reads the trace record's timestamp, sender, recipient(s), subject,
        status, and event, tolerating the varying property names EXO surfaces.
        The event falls back to the status when the record carries no event.
    .PARAMETER Record
        The Get-MessageTraceV2 record.
    .EXAMPLE
        ConvertTo-MessageTraceRow -Record $traceRecord
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Record
    )

    $timestamp = ''
    foreach ($prop in @('Received', 'Date', 'Timestamp')) {
        if ($null -ne $Record.$prop -and ([string]$Record.$prop).Trim().Length -gt 0) {
            $timestamp = [string]$Record.$prop
            break
        }
    }

    $senderAddress = ''
    foreach ($prop in @('SenderAddress', 'Sender', 'From')) {
        if ($null -ne $Record.$prop -and ([string]$Record.$prop).Trim().Length -gt 0) {
            $senderAddress = [string]$Record.$prop
            break
        }
    }

    $recipients = [System.Collections.Generic.List[string]]::new()
    foreach ($prop in @('RecipientAddress', 'Recipients', 'Recipient', 'To')) {
        if ($null -ne $Record.$prop) {
            foreach ($entry in @($Record.$prop)) {
                $text = [string]$entry
                if ($text.Trim().Length -gt 0) {
                    $recipients.Add($text.Trim())
                }
            }
            if ($recipients.Count -gt 0) {
                break
            }
        }
    }

    $subject = ''
    foreach ($prop in @('Subject', 'Title')) {
        if ($null -ne $Record.$prop -and ([string]$Record.$prop).Trim().Length -gt 0) {
            $subject = [string]$Record.$prop
            break
        }
    }

    $status = ''
    foreach ($prop in @('Status', 'DeliveryStatus')) {
        if ($null -ne $Record.$prop -and ([string]$Record.$prop).Trim().Length -gt 0) {
            $status = [string]$Record.$prop
            break
        }
    }

    $eventName = ''
    foreach ($prop in @('Event', 'Action')) {
        if ($null -ne $Record.$prop -and ([string]$Record.$prop).Trim().Length -gt 0) {
            $eventName = [string]$Record.$prop
            break
        }
    }
    if ($eventName.Trim().Length -eq 0 -and $status.Trim().Length -gt 0) {
        $eventName = $status
    }

    return [pscustomobject]@{
        timestamp = $timestamp
        sender    = $senderAddress
        recipient = ($recipients | Select-Object -Unique) -join '; '
        subject   = $subject
        status    = $status
        event     = $eventName
    }
}

function Test-MessageTraceFilter {
    <#
    .SYNOPSIS
        Applies the §3.1 filters to one shaped trace row.
    .DESCRIPTION
        Sender, recipient, and status match case-insensitively on the full
        value; subject matches as a case-insensitive substring. Empty filters
        keep every row.
    .PARAMETER Row
        The ConvertTo-MessageTraceRow result.
    .PARAMETER SenderFilter
        Exact sender address filter; empty disables.
    .PARAMETER Recipient
        Exact recipient address filter; empty disables.
    .PARAMETER Subject
        Substring subject filter; empty disables.
    .PARAMETER Status
        Exact status filter; empty disables.
    .EXAMPLE
        Test-MessageTraceFilter -Row $row -Subject 'invoice' -Status 'Delivered'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [Parameter()]
        [string]$SenderFilter = '',

        [Parameter()]
        [string]$Recipient = '',

        [Parameter()]
        [string]$Subject = '',

        [Parameter()]
        [string]$Status = ''
    )

    if ($SenderFilter.Trim().Length -gt 0) {
        if ($Row.sender.Trim().ToLowerInvariant() -ne $SenderFilter.Trim().ToLowerInvariant()) {
            return $false
        }
    }
    if ($Recipient.Trim().Length -gt 0) {
        $needle = $Recipient.Trim().ToLowerInvariant()
        $recipients = @($Row.recipient -split ';' | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_.Length -gt 0 })
        if ($recipients -notcontains $needle) {
            return $false
        }
    }
    if ($Subject.Trim().Length -gt 0) {
        if (-not $Row.subject.ToLowerInvariant().Contains($Subject.Trim().ToLowerInvariant())) {
            return $false
        }
    }
    if ($Status.Trim().Length -gt 0) {
        if ($Row.status.Trim().ToLowerInvariant() -ne $Status.Trim().ToLowerInvariant()) {
            return $false
        }
    }
    return $true
}

function ConvertTo-MessageTraceCursor {
    <#
    .SYNOPSIS
        Encodes a row offset into an opaque page cursor.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-MessageTraceCursor {
    <#
    .SYNOPSIS
        Decodes an opaque page cursor back into a row offset.
    .DESCRIPTION
        An undecodable cursor yields the first page rather than failing the read.
    #>
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
        Write-Verbose "Ignoring undecodable message trace cursor and starting at the first page."
    }
    return 0
}

function Get-MessageTrace {
    <#
    .SYNOPSIS
        Traces tenant messages live from Exchange Online with the §3.1 filters.
    .DESCRIPTION
        Validates the requested date range against the EXO trace window, reads
        Get-MessageTraceV2 once for the window, shapes the §3.1 rows, applies
        the filters, and returns one cursor page. Only Get- cmdlets are issued;
        nothing is written to the tenant and nothing is mirrored to disk.
    .PARAMETER TenantId
        Tenant the trace runs against. Carried through to the result envelope.
    .PARAMETER SenderAddress
        Exact sender address filter.
    .PARAMETER RecipientAddress
        Exact recipient address filter.
    .PARAMETER Subject
        Substring subject filter.
    .PARAMETER Status
        Exact status filter.
    .PARAMETER StartDate
        Window start (parseable datetime). Defaults to the start of the trace window.
    .PARAMETER EndDate
        Window end (parseable datetime). Defaults to now.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-MessageTrace -TenantId 'tenant-a' -SenderAddress 'sender@example.com' -Subject 'invoice' -Top 50
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$SenderAddress = '',

        [Parameter()]
        [string]$RecipientAddress = '',

        [Parameter()]
        [string]$Subject = '',

        [Parameter()]
        [string]$Status = '',

        [Parameter()]
        [string]$StartDate = '',

        [Parameter()]
        [string]$EndDate = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $window = $script:MessageTraceWindowDays
    $now = (Get-Date).ToUniversalTime()

    Test-MessageTraceWindow -StartDate $StartDate -EndDate $EndDate -Now $now

    $effectiveStart = $StartDate
    if ($effectiveStart.Trim().Length -eq 0) {
        $effectiveStart = $now.AddDays(-$window).ToString('o')
    }
    $effectiveEnd = $EndDate
    if ($effectiveEnd.Trim().Length -eq 0) {
        $effectiveEnd = $now.ToString('o')
    }

    $start = ConvertTo-MessageTraceDate -Value $effectiveStart -Field 'startDate'
    $end = ConvertTo-MessageTraceDate -Value $effectiveEnd -Field 'endDate'

    $traceParams = @{
        StartDate = $start
        EndDate   = $end
        PageSize  = 1000
    }
    if ($SenderAddress.Trim().Length -gt 0) {
        $traceParams['SenderAddress'] = $SenderAddress.Trim()
    }
    if ($RecipientAddress.Trim().Length -gt 0) {
        $traceParams['RecipientAddress'] = $RecipientAddress.Trim()
    }
    if ($Status.Trim().Length -gt 0) {
        $traceParams['Status'] = $Status.Trim()
    }

    $records = @(Get-MessageTraceV2 @traceParams)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($record in $records) {
        if ($null -eq $record) {
            continue
        }
        $row = ConvertTo-MessageTraceRow -Record $record
        if (Test-MessageTraceFilter -Row $row -Sender $SenderAddress -Recipient $RecipientAddress -Subject $Subject -Status $Status) {
            $rows.Add($row)
        }
    }

    $ordered = @($rows)
    $offset = ConvertFrom-MessageTraceCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-MessageTraceCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Read-MessageTraceJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Get-MessageTrace parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        scoped trace filters and paging. The envelope carries references only;
        secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-MessageTraceJob -Path './run/message-trace-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Message trace job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Message trace job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Message trace job is missing required field: tenantId'
    }

    $filters = $job['payload']
    if ($filters -is [System.Collections.IDictionary]) {
        $nested = $filters['filters']
        if ($nested -is [System.Collections.IDictionary]) {
            $filters = $nested
        }
    }
    else {
        $filters = @{}
    }
    if ($filters -isnot [System.Collections.IDictionary]) {
        $filters = @{}
    }

    $top = 100
    if ($filters['top']) {
        try {
            $parsed = [int]$filters['top']
            if ($parsed -ge 1 -and $parsed -le 1000) {
                $top = $parsed
            }
        }
        catch {
            $top = 100
        }
    }

    return @{
        TenantId         = $tenantId
        SenderAddress    = [string]$filters['sender']
        RecipientAddress = [string]$filters['recipient']
        Subject          = [string]$filters['subject']
        Status           = [string]$filters['status']
        StartDate        = [string]$filters['startDate']
        EndDate          = [string]$filters['endDate']
        Top              = $top
        Cursor           = [string]$filters['cursor']
    }
}
