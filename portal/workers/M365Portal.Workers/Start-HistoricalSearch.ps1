# Start-HistoricalSearch.ps1 — EPIC-024 historical search worker (SPEC §2 US-2, §3.2, §4.1, §9; §11 items 1+4; T-0465).
#
# The backend is EXO/Purview compliance search (New-ComplianceSearch /
# Start-ComplianceSearch / Get-ComplianceSearch) run inside the per-tenant EXO
# process; callers need high privilege plus the compliance/eDiscovery roles,
# which the BFF enforces before dispatch. The search runs as an async job:
# Start-HistoricalSearch creates and starts it, Get-HistoricalSearchResult
# polls it for progress and completion, and Stop-HistoricalSearch cancels it.
#
# Results are ephemeral (§11.4): matches and the download reference are
# returned on stdout only and never written to disk; only job and audit
# records persist. Progress flows through -WriteProgress (stderr by default so
# stdout stays the result transport); audit records flow through -WriteAudit.
# The supervisor connects EXO in the child process before invoking this file,
# so no secret handling lives here.

function Write-HistoricalSearchProgress {
    [CmdletBinding()]
    [OutputType([void])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$JobId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('queued', 'running', 'succeeded', 'failed', 'cancelled')]
        [string]$State,

        [Parameter()]
        [string]$SearchName = '',

        [Parameter()]
        [int]$ProgressPercent = -1,

        [Parameter()]
        [string]$Message = ''
    )

    $progressEvent = [ordered]@{
        schemaVersion = 'v1'
        jobType       = 'historical-search'
        jobId         = $JobId
        tenantId      = $TenantId
        section       = 'historical-search'
        state         = $State
        message       = $Message
        emittedAt     = (Get-Date -Format 'o')
    }
    if ($SearchName.Trim().Length -gt 0) {
        $progressEvent['searchName'] = $SearchName
    }
    if ($ProgressPercent -ge 0) {
        $progressEvent['progressPercent'] = $ProgressPercent
    }
    [Console]::Error.WriteLine(($progressEvent | ConvertTo-Json -Depth 5 -Compress))
}

function New-HistoricalSearchName {
    <#
    .SYNOPSIS
        Derives the compliance-search name for a historical-search job.
    .DESCRIPTION
        Compliance-search names allow a limited character set, so the job id
        is sanitized before prefixing; the name stays traceable to the job.
    .PARAMETER JobId
        Historical-search job id.
    .EXAMPLE
        New-HistoricalSearchName -JobId 'job-1'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$JobId
    )

    $safe = ($JobId.Trim() -replace '[^A-Za-z0-9_-]', '-').Trim('-')
    if ($safe.Length -eq 0) {
        throw "historical-search.invalid_job_id: job id has no usable characters"
    }
    return "historical-search-$safe"
}

function Get-HistoricalSearchUtcNow {
    [CmdletBinding()]
    [OutputType([string])]
    param()

    return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}

function New-HistoricalSearchJobRecord {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$JobId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SearchName,

        [Parameter(Mandatory)]
        [ValidateSet('queued', 'running', 'succeeded', 'failed', 'cancelled')]
        [string]$State,

        [Parameter()]
        [string]$Query = '',

        [Parameter()]
        [string[]]$ExchangeLocation = @(),

        [Parameter()]
        [int]$ProgressPercent = -1
    )

    $record = [pscustomobject]@{
        jobId           = $JobId
        tenantId        = $TenantId
        searchName      = $SearchName
        state           = $State
        query           = $Query
        exchangeLocation = @($ExchangeLocation)
        updatedAt       = (Get-HistoricalSearchUtcNow)
    }
    if ($ProgressPercent -ge 0) {
        $record | Add-Member -NotePropertyName 'progressPercent' -NotePropertyValue $ProgressPercent
    }
    return $record
}

function New-HistoricalSearchAuditEvent {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('mail.historical_search.start', 'mail.historical_search.cancel', 'mail.historical_search.finish')]
        [string]$Action,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$JobId,

        [Parameter()]
        [string]$SearchName = '',

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [hashtable]$Detail = @{}
    )

    $audit = @{
        id        = [guid]::NewGuid().ToString()
        tenantId  = $TenantId
        action    = $Action
        targetId  = $JobId
        timestamp = (Get-HistoricalSearchUtcNow)
    }
    if ($SearchName.Trim().Length -gt 0) {
        $audit['targetName'] = $SearchName
    }
    if ($Actor.Trim().Length -gt 0) {
        $audit['actor'] = $Actor
    }
    foreach ($key in @($Detail.Keys)) {
        $audit[$key] = $Detail[$key]
    }
    return $audit
}

function Test-HistoricalSearchDates {
    [CmdletBinding()]
    [OutputType([void])]
    param(
        [Parameter()]
        [string]$StartDate = '',

        [Parameter()]
        [string]$EndDate = ''
    )

    if ($StartDate.Trim().Length -eq 0 -or $EndDate.Trim().Length -eq 0) {
        return
    }
    try {
        $start = [datetime]$StartDate
        $end = [datetime]$EndDate
        if ($start.ToUniversalTime() -gt $end.ToUniversalTime()) {
            throw "historical-search.invalid_date_range: start date '$StartDate' is after end date '$EndDate'"
        }
    }
    catch {
        if ($_.Exception.Message -like 'historical-search.*') {
            throw
        }
        throw "historical-search.invalid_date: dates must be parseable datetimes: $($_.Exception.Message)"
    }
}

function Start-HistoricalSearch {
    <#
    .SYNOPSIS
        Creates and starts the EXO compliance search behind a historical-search job.
    .DESCRIPTION
        Validates the scoped parameters, emits queued/running progress, creates
        the compliance search (New-ComplianceSearch) scoped to the requested
        mailboxes and date window, starts it, and returns the running job
        record with a start audit event. The compliance search itself runs
        asynchronously in EXO; completion is observed via
        Get-HistoricalSearchResult. Message data is never persisted here.
    .PARAMETER TenantId
        Tenant the search runs against. Carried through to the job record.
    .PARAMETER JobId
        Historical-search job id; sources the compliance-search name.
    .PARAMETER Query
        KQL content-match query (New-ComplianceSearch -ContentMatchQuery).
    .PARAMETER ExchangeLocation
        Mailbox scope. Empty searches all exchange locations.
    .PARAMETER StartDate
        Optional window start (parseable datetime).
    .PARAMETER EndDate
        Optional window end (parseable datetime, must follow StartDate).
    .PARAMETER WriteProgress
        Progress seam; defaults to stderr progress events.
    .PARAMETER WriteAudit
        Audit seam receiving the start audit event.
    .EXAMPLE
        Start-HistoricalSearch -TenantId 'tenant-a' -JobId 'job-1' -Query 'subject:invoice' -ExchangeLocation @('All')
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$JobId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Query,

        [Parameter()]
        [string[]]$ExchangeLocation = @(),

        [Parameter()]
        [string]$StartDate = '',

        [Parameter()]
        [string]$EndDate = '',

        [Parameter()]
        [scriptblock]$WriteProgress = { param($ProgressEvent) Write-HistoricalSearchProgress -JobId $ProgressEvent.jobId -TenantId $ProgressEvent.tenantId -State $ProgressEvent.state -SearchName $ProgressEvent.searchName -Message $ProgressEvent.message },

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    $queryText = $Query.Trim()
    if ($queryText.Length -eq 0) {
        throw "historical-search.invalid_query: a non-empty KQL query is required"
    }
    Test-HistoricalSearchDates -StartDate $StartDate -EndDate $EndDate

    $locations = @($ExchangeLocation | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if ($locations.Count -eq 0) {
        $locations = @('All')
    }

    $searchName = New-HistoricalSearchName -JobId $JobId
    $null = & $WriteProgress @{ jobId = $JobId; tenantId = $TenantId; searchName = $searchName; state = 'queued'; message = 'Creating the compliance search.' }

    $newParams = @{
        Name               = $searchName
        ExchangeLocation   = $locations
        ContentMatchQuery  = $queryText
    }
    if ($StartDate.Trim().Length -gt 0) {
        $newParams['StartDate'] = $StartDate.Trim()
    }
    if ($EndDate.Trim().Length -gt 0) {
        $newParams['EndDate'] = $EndDate.Trim()
    }
    $null = New-ComplianceSearch @newParams
    $null = Start-ComplianceSearch -Identity $searchName

    $null = & $WriteProgress @{ jobId = $JobId; tenantId = $TenantId; searchName = $searchName; state = 'running'; message = 'The compliance search is running.' }
    $null = & $WriteAudit (New-HistoricalSearchAuditEvent -TenantId $TenantId -Action 'mail.historical_search.start' -JobId $JobId -SearchName $searchName -Detail @{ query = $queryText; exchangeLocation = @($locations) })

    return New-HistoricalSearchJobRecord -JobId $JobId -TenantId $TenantId -SearchName $searchName -State 'running' -Query $queryText -ExchangeLocation $locations
}

function ConvertTo-HistoricalSearchMatch {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Item
    )

    if ($Item -is [System.Collections.IDictionary]) {
        $get = { param($k) if ($Item.Contains($k)) { return $Item[$k] } else { return $null } }
        return [pscustomobject]@{
            mailbox          = [string](& $get 'Mailbox')
            subject          = [string](& $get 'Subject')
            receivedAt       = [string](& $get 'ReceivedAt')
            sizeBytes        = (& $get 'SizeBytes')
        }
    }
    $mailbox = ''
    foreach ($prop in @('Mailbox', 'Location', 'PrimarySmtpAddress')) {
        if ($null -ne $Item.$prop -and ([string]$Item.$prop).Trim().Length -gt 0) {
            $mailbox = [string]$Item.$prop
            break
        }
    }
    $subject = ''
    foreach ($prop in @('Subject', 'Title')) {
        if ($null -ne $Item.$prop -and ([string]$Item.$prop).Trim().Length -gt 0) {
            $subject = [string]$Item.$prop
            break
        }
    }
    $receivedAt = ''
    foreach ($prop in @('ReceivedAt', 'Received', 'Date')) {
        if ($null -ne $Item.$prop -and ([string]$Item.$prop).Trim().Length -gt 0) {
            $receivedAt = [string]$Item.$prop
            break
        }
    }
    $sizeBytes = $null
    if ($null -ne $Item.SizeBytes) {
        $sizeBytes = $Item.SizeBytes
    }
    elseif ($null -ne $Item.Size) {
        $sizeBytes = $Item.Size
    }
    return [pscustomobject]@{
        mailbox    = $mailbox
        subject    = $subject
        receivedAt = $receivedAt
        sizeBytes  = $sizeBytes
    }
}

function Get-HistoricalSearchProgressPercent {
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)]
        [object]$Search
    )

    foreach ($prop in @('PercentComplete', 'JobProgress', 'Progress')) {
        try {
            $raw = $Search.$prop
        }
        catch {
            $raw = $null
        }
        if ($null -eq $raw) {
            continue
        }
        $text = ([string]$raw).Trim().TrimEnd('%')
        $value = 0
        if ([int]::TryParse($text, [ref]$value) -and $value -ge 0) {
            if ($value -gt 100) {
                $value = 100
            }
            return $value
        }
    }
    return -1
}

function Get-HistoricalSearchResult {
    <#
    .SYNOPSIS
        Polls the compliance search behind a historical-search job.
    .DESCRIPTION
        Reads the live Get-ComplianceSearch state, emits a running progress
        event with the EXO percent-complete while unfinished, and on
        completion returns the job record with metadata-only matches plus the
        export download reference. Matches carry mailbox, subject, received
        time, and size only — message bodies are never returned and never
        persisted. A terminal completion also emits the finish audit event.
    .PARAMETER TenantId
        Tenant the search runs against.
    .PARAMETER JobId
        Historical-search job id.
    .PARAMETER SearchName
        Compliance-search name from Start-HistoricalSearch.
    .PARAMETER Top
        Maximum matches to return.
    .PARAMETER WriteProgress
        Progress seam; defaults to stderr progress events.
    .PARAMETER WriteAudit
        Audit seam receiving the finish audit event on completion.
    .EXAMPLE
        Get-HistoricalSearchResult -TenantId 'tenant-a' -JobId 'job-1' -SearchName 'historical-search-job-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$JobId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SearchName,

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [scriptblock]$WriteProgress = { param($ProgressEvent) Write-HistoricalSearchProgress -JobId $ProgressEvent.jobId -TenantId $ProgressEvent.tenantId -State $ProgressEvent.state -SearchName $ProgressEvent.searchName -Message $ProgressEvent.message },

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    $search = Get-ComplianceSearch -Identity $SearchName -ErrorAction Stop
    if ($null -eq $search) {
        throw "historical-search.not_found: compliance search '$SearchName' was not found"
    }

    $status = ''
    try {
        $status = [string]$search.Status
    }
    catch {
        $status = ''
    }
    $percent = Get-HistoricalSearchProgressPercent -Search $search

    $progressParams = @{ jobId = $JobId; tenantId = $TenantId; searchName = $SearchName; message = "Compliance search state: $status." }
    if ($percent -ge 0) {
        $progressParams['progressPercent'] = $percent
    }

    switch ($status.Trim().ToLowerInvariant()) {
        'completed' {
            $found = [System.Collections.Generic.List[object]]::new()
            $rawItems = @()
            foreach ($prop in @('SuccessResults', 'Results', 'Items')) {
                try {
                    $candidate = $search.$prop
                }
                catch {
                    $candidate = $null
                }
                if ($null -ne $candidate) {
                    if ($candidate -is [System.Collections.IDictionary]) {
                        foreach ($key in @($candidate.Keys)) {
                            $rawItems += @{ Mailbox = [string]$key; Subject = ''; ReceivedAt = ''; SizeBytes = $candidate[$key] }
                        }
                    }
                    else {
                        $rawItems += @($candidate)
                    }
                }
                if ($rawItems.Count -gt 0) {
                    break
                }
            }
            foreach ($item in @($rawItems | Select-Object -First $Top)) {
                if ($null -eq $item) {
                    continue
                }
                $found.Add((ConvertTo-HistoricalSearchMatch -Item $item))
            }

            $progressParams['state'] = 'succeeded'
            $null = & $WriteProgress $progressParams
            $null = & $WriteAudit (New-HistoricalSearchAuditEvent -TenantId $TenantId -Action 'mail.historical_search.finish' -JobId $JobId -SearchName $SearchName -Detail @{ state = 'succeeded'; matchCount = $found.Count })

            $job = New-HistoricalSearchJobRecord -JobId $JobId -TenantId $TenantId -SearchName $SearchName -State 'succeeded'
            $job | Add-Member -NotePropertyName 'matches' -NotePropertyValue @($found)
            $job | Add-Member -NotePropertyName 'totalCount' -NotePropertyValue $found.Count
            $job | Add-Member -NotePropertyName 'downloadRef' -NotePropertyValue "compliance-search/$SearchName/export"
            return $job
        }
        'failed' {
            $progressParams['state'] = 'failed'
            $null = & $WriteProgress $progressParams
            $null = & $WriteAudit (New-HistoricalSearchAuditEvent -TenantId $TenantId -Action 'mail.historical_search.finish' -JobId $JobId -SearchName $SearchName -Detail @{ state = 'failed' })
            return New-HistoricalSearchJobRecord -JobId $JobId -TenantId $TenantId -SearchName $SearchName -State 'failed'
        }
        'notstarted' {
            $progressParams['state'] = 'queued'
            $null = & $WriteProgress $progressParams
            $record = New-HistoricalSearchJobRecord -JobId $JobId -TenantId $TenantId -SearchName $SearchName -State 'queued'
            if ($percent -ge 0) {
                $record | Add-Member -NotePropertyName 'progressPercent' -NotePropertyValue $percent
            }
            return $record
        }
        default {
            $progressParams['state'] = 'running'
            $null = & $WriteProgress $progressParams
            $record = New-HistoricalSearchJobRecord -JobId $JobId -TenantId $TenantId -SearchName $SearchName -State 'running'
            if ($percent -ge 0) {
                $record | Add-Member -NotePropertyName 'progressPercent' -NotePropertyValue $percent
            }
            return $record
        }
    }
}

function Stop-HistoricalSearch {
    <#
    .SYNOPSIS
        Cancels the compliance search behind a historical-search job.
    .DESCRIPTION
        Removes the in-flight compliance search so EXO stops the long-running
        query, emits a cancelled progress event plus the cancel audit event,
        and returns the cancelled job record. Already-completed searches are
        refused with a structured error instead of being removed silently.
    .PARAMETER TenantId
        Tenant the search runs against.
    .PARAMETER JobId
        Historical-search job id.
    .PARAMETER SearchName
        Compliance-search name from Start-HistoricalSearch.
    .PARAMETER WriteProgress
        Progress seam; defaults to stderr progress events.
    .PARAMETER WriteAudit
        Audit seam receiving the cancel audit event.
    .EXAMPLE
        Stop-HistoricalSearch -TenantId 'tenant-a' -JobId 'job-1' -SearchName 'historical-search-job-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$JobId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SearchName,

        [Parameter()]
        [scriptblock]$WriteProgress = { param($ProgressEvent) Write-HistoricalSearchProgress -JobId $ProgressEvent.jobId -TenantId $ProgressEvent.tenantId -State $ProgressEvent.state -SearchName $ProgressEvent.searchName -Message $ProgressEvent.message },

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    $search = Get-ComplianceSearch -Identity $SearchName -ErrorAction Stop
    if ($null -eq $search) {
        throw "historical-search.not_found: compliance search '$SearchName' was not found"
    }
    $status = ''
    try {
        $status = ([string]$search.Status).Trim().ToLowerInvariant()
    }
    catch {
        $status = ''
    }
    if ($status -eq 'completed') {
        throw "historical-search.not_cancellable: compliance search '$SearchName' already completed and cannot be cancelled"
    }

    $null = Remove-ComplianceSearch -Identity $SearchName -Confirm:$false

    $null = & $WriteProgress @{ jobId = $JobId; tenantId = $TenantId; searchName = $SearchName; state = 'cancelled'; message = 'The compliance search was cancelled.' }
    $null = & $WriteAudit (New-HistoricalSearchAuditEvent -TenantId $TenantId -Action 'mail.historical_search.cancel' -JobId $JobId -SearchName $SearchName)

    return New-HistoricalSearchJobRecord -JobId $JobId -TenantId $TenantId -SearchName $SearchName -State 'cancelled'
}

function Read-HistoricalSearchJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Start-HistoricalSearch parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        action (start, poll, or cancel) with the scoped search parameters.
        The envelope carries references and search parameters only; secrets
        are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-HistoricalSearchJob -Path './run/historical-search-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Historical-search job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Historical-search job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Historical-search job is missing required field: tenantId'
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

    $jobId = ''
    if ($job['jobId']) {
        $jobId = [string]$job['jobId']
    }
    if ($jobId.Trim().Length -eq 0 -and $filters['jobId']) {
        $jobId = [string]$filters['jobId']
    }

    $action = 'start'
    if ($filters['action']) {
        $action = ([string]$filters['action']).Trim().ToLowerInvariant()
    }
    if (@('start', 'poll', 'cancel') -notcontains $action) {
        throw "Historical-search job has unsupported action: $action"
    }

    $locations = @()
    $rawLocations = $filters['exchangeLocation']
    if ($rawLocations -is [System.Collections.IEnumerable] -and $rawLocations -isnot [string]) {
        foreach ($entry in @($rawLocations)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$entry)) {
                $locations += [string]$entry
            }
        }
    }
    elseif (-not [string]::IsNullOrWhiteSpace([string]$rawLocations)) {
        $locations = @([string]$rawLocations)
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
        JobId            = $jobId
        Action           = $action
        Query            = [string]$filters['query']
        ExchangeLocation = $locations
        StartDate        = [string]$filters['startDate']
        EndDate          = [string]$filters['endDate']
        Top              = $top
        SearchName       = [string]$filters['searchName']
    }
}
