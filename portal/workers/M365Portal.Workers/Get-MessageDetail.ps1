# Get-MessageDetail.ps1 — EPIC-024 message viewer (SPEC §2 US-3, §3.3, §4.1, §6, §9, §11.2).
#
# Live EXO reads only: given a trace/search result id, returns the full delivery
# timeline (events, connectors, filters hit) and headers, read-only. The message
# body is privacy-sensitive (§9), so it is fetched only when the caller passes
# -IncludeBody (the BFF sets that only for callers holding Exchange.MailContent.Reveal);
# otherwise the response omits the body and reports it as gated. Only Get-
# cmdlets are issued; nothing is written to the tenant and message data is never
# mirrored to disk. The caller (child entrypoint) runs with the EXO session the
# supervisor connected after materializing the tenant credential in-process;
# this file never touches secrets.

function ConvertTo-MessageEvent {
    <#
    .SYNOPSIS
        Shapes one Get-MessageTraceDetail record into a delivery timeline event.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Record
    )

    $detail = [string]$Record.Detail
    if ($detail.Trim().Length -eq 0) {
        $detail = [string]$Record.Action
    }

    return [pscustomobject]@{
        timestamp = if ($null -ne $Record.Date) { [string]$Record.Date } else { '' }
        event     = [string]$Record.Event
        detail    = $detail.Trim()
    }
}

function ConvertTo-MessageConnectors {
    <#
    .SYNOPSIS
        Collects the distinct connectors a message passed through.
    .DESCRIPTION
        EXO surfaces the sending/receiving connector on each trace detail
        record's Data payload under varying property names; every non-empty
        value is collected and de-duplicated so one unavailable slice cannot
        hide the rest of the path.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()]
        [object[]]$Records = @()
    )

    $seen = [System.Collections.Generic.List[string]]::new()
    foreach ($record in @($Records)) {
        $data = $record.Data
        if ($null -eq $data) {
            continue
        }
        foreach ($name in @('ConnectorId', 'Connector', 'SendingConnector', 'ReceivingConnector')) {
            $value = $null
            if ($data -is [System.Collections.IDictionary] -and $data.Contains($name)) {
                $value = $data[$name]
            }
            elseif ($null -ne $data.PSObject -and $null -ne $data.PSObject.Properties[$name]) {
                $value = $data.$name
            }
            $text = [string]$value
            if ($text.Trim().Length -gt 0 -and -not $seen.Contains($text.Trim())) {
                $seen.Add($text.Trim())
            }
        }
    }
    return @($seen)
}

function ConvertTo-MessageFiltersHit {
    <#
    .SYNOPSIS
        Collects the distinct transport/filter verdicts a message triggered.
    .DESCRIPTION
        Filter evidence (spam verdicts, SCL, transport rules, malware/phish and
        DLP hits) rides on each trace detail record's Data payload. Keys
        matching the filter family are collected as 'Name: Value' strings and
        de-duplicated; an unrecognised Data shape yields an empty list rather
        than failing the read.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()]
        [object[]]$Records = @()
    )

    $seen = [System.Collections.Generic.List[string]]::new()
    foreach ($record in @($Records)) {
        $data = $record.Data
        if ($null -eq $data) {
            continue
        }
        $entries = @()
        if ($data -is [System.Collections.IDictionary]) {
            foreach ($key in @($data.Keys)) {
                $entries += [pscustomobject]@{ Name = [string]$key; Value = $data[$key] }
            }
        }
        elseif ($null -ne $data.PSObject) {
            $entries = @($data.PSObject.Properties)
        }
        foreach ($entry in @($entries)) {
            $name = [string]$entry.Name
            if ($name -notmatch '(?i)filter|rule|verdict|scl|spam|malware|phish|dlp|quarantine|action') {
                continue
            }
            if ($name -match '(?i)^connector') {
                continue
            }
            $text = "$($name.Trim()): $([string]$entry.Value)".Trim()
            if ($text.Length -gt 0 -and -not $seen.Contains($text)) {
                $seen.Add($text)
            }
        }
    }
    return @($seen)
}

function ConvertTo-MessageHeaders {
    <#
    .SYNOPSIS
        Shapes trace detail header payloads into name/value pairs.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter()]
        [object[]]$Records = @()
    )

    $headers = [System.Collections.Generic.List[object]]::new()
    foreach ($record in @($Records)) {
        $data = $record.Data
        if ($null -eq $data) {
            continue
        }
        $raw = $null
        if ($data -is [System.Collections.IDictionary] -and $data.Contains('MessageHeaders')) {
            $raw = $data['MessageHeaders']
        }
        elseif ($null -ne $data.PSObject -and $null -ne $data.PSObject.Properties['MessageHeaders']) {
            $raw = $data.MessageHeaders
        }
        if ($null -eq $raw) {
            continue
        }
        $pairs = @()
        if ($raw -is [System.Collections.IDictionary]) {
            foreach ($key in @($raw.Keys)) {
                $pairs += [pscustomobject]@{ name = [string]$key; value = [string]$raw[$key] }
            }
        }
        else {
            $pairs = @($raw)
        }
        foreach ($pair in @($pairs)) {
            $name = [string]$pair.name
            if ($name.Trim().Length -eq 0 -and $null -ne $pair.PSObject -and $null -ne $pair.PSObject.Properties['Name']) {
                $name = [string]$pair.Name
            }
            $value = [string]$pair.value
            if ($value.Trim().Length -eq 0 -and $null -ne $pair.PSObject -and $null -ne $pair.PSObject.Properties['Value']) {
                $value = [string]$pair.Value
            }
            if ($name.Trim().Length -eq 0) {
                continue
            }
            if (-not @($headers | Where-Object { $_.name -eq $name.Trim() -and $_.value -eq $value })) {
                $headers.Add([pscustomobject]@{ name = $name.Trim(); value = $value })
            }
        }
    }
    return @($headers)
}

function Read-MessageBodyContent {
    <#
    .SYNOPSIS
        Fetches the privileged message body for callers holding Exchange.MailContent.Reveal.
    .DESCRIPTION
        Elevated-content seam: invoked only when the worker runs with
        -IncludeBody. A failed body read yields null so the viewer still
        returns metadata, headers, and timeline; the caller reports the body
        as gated with the failure reason.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MessageId
    )

    try {
        $export = Get-MessageTraceDetail -MessageId $MessageId -ErrorAction Stop |
            Where-Object { $null -ne $_.Data -and (
                ($_.Data -is [System.Collections.IDictionary] -and $_.Data.Contains('MessageBody')) -or
                ($null -ne $_.Data.PSObject -and $null -ne $_.Data.PSObject.Properties['MessageBody'])
            ) } |
            Select-Object -First 1
        if ($null -eq $export) {
            return $null
        }
        if ($export.Data -is [System.Collections.IDictionary]) {
            return [string]$export.Data['MessageBody']
        }
        return [string]$export.Data.MessageBody
    }
    catch {
        Write-Verbose "Message body unavailable for '$MessageId': $($_.Exception.Message)"
        return $null
    }
}

function Get-MessageDetail {
    <#
    .SYNOPSIS
        Reads one message's delivery timeline, connectors, filters, and headers live from EXO.
    .DESCRIPTION
        Resolves the message through Get-MessageTrace, expands the delivery
        timeline through Get-MessageTraceDetail, and returns metadata plus
        events, connectors, filters hit, and headers. The body is returned
        only with -IncludeBody; otherwise body is null and bodyGated is true.
        Only Get- cmdlets are issued; nothing is written to the tenant.
    .PARAMETER TenantId
        Tenant the message belongs to. Carried through to the result envelope.
    .PARAMETER MessageId
        Message identity (InternetMessageId or MessageTraceId).
    .PARAMETER IncludeBody
        Fetch the privileged message body. The BFF passes this only for
        callers holding Exchange.MailContent.Reveal.
    .EXAMPLE
    .    Get-MessageDetail -TenantId 'tenant-a' -MessageId '<id>'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MessageId,

        [Parameter()]
        [switch]$IncludeBody
    )

    $summary = Get-MessageTrace -MessageId $MessageId -ErrorAction Stop
    if ($summary -is [array]) {
        $summary = $summary | Select-Object -First 1
    }
    if ($null -eq $summary) {
        throw "Message '$MessageId' was not found (code: message.not_found)"
    }

    $detailRecords = @(Get-MessageTraceDetail -MessageId $MessageId -ErrorAction Stop)

    $events = [System.Collections.Generic.List[object]]::new()
    foreach ($record in @($detailRecords)) {
        if ($null -eq $record) {
            continue
        }
        $events.Add((ConvertTo-MessageEvent -Record $record))
    }

    $recipients = @()
    foreach ($recipient in @($summary.Recipients, $summary.RecipientAddress, $summary.To)) {
        foreach ($entry in @($recipient)) {
            $text = [string]$entry
            if ($text.Trim().Length -gt 0) {
                $recipients += $text.Trim()
            }
        }
    }

    $body = $null
    $bodyGated = $true
    $bodyGateReason = 'The message body requires the Exchange.MailContent.Reveal permission.'
    if ($IncludeBody) {
        $fetched = Read-MessageBodyContent -MessageId $MessageId
        if ($null -ne $fetched -and ([string]$fetched).Trim().Length -gt 0) {
            $body = [string]$fetched
            $bodyGated = $false
            $bodyGateReason = ''
        }
        else {
            $bodyGateReason = 'The message body is unavailable for this message.'
        }
    }

    return [pscustomobject]@{
        tenantId       = $TenantId
        messageId      = $MessageId
        subject        = [string]$summary.Subject
        sender         = [string]$summary.SenderAddress
        recipients     = @($recipients | Select-Object -Unique)
        receivedAt     = if ($null -ne $summary.Received) { [string]$summary.Received } else { '' }
        status         = [string]$summary.Status
        size           = if ($null -ne $summary.Size) { [string]$summary.Size } else { '' }
        deliveryEvents = @($events)
        connectors     = @(ConvertTo-MessageConnectors -Records $detailRecords)
        filtersHit     = @(ConvertTo-MessageFiltersHit -Records $detailRecords)
        headers        = @(ConvertTo-MessageHeaders -Records $detailRecords)
        body           = $body
        bodyGated      = $bodyGated
        bodyGateReason = $bodyGateReason
        retrievedAt    = (Get-Date -Format 'o')
    }
}

function Read-MessageDetailJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Get-MessageDetail parameters.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Message detail job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Message detail job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Message detail job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $messageId = [string]$payload['messageId']
    if ([string]::IsNullOrWhiteSpace($messageId)) {
        throw 'Message detail job is missing required field: payload.messageId'
    }

    $includeBody = $false
    if ($payload.Contains('includeBody')) {
        try {
            $includeBody = [System.Convert]::ToBoolean($payload['includeBody'])
        }
        catch {
            $includeBody = $false
        }
    }

    return @{
        TenantId    = $tenantId
        MessageId   = $messageId
        IncludeBody = $includeBody
    }
}
