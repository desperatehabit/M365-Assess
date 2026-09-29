# Search-AuditLog.ps1 — EPIC-032 manual audit-log search worker (SPEC §3.1, §4.1, §6, §8, §11.1; T-0622).
#
# Per-workload routing (SPEC §11.1): Graph directoryAudits/signIns where those
# endpoints cover the workload, Purview audit search (Search-UnifiedAuditLog)
# for content workloads (Exchange/SharePoint/OneDrive). Every record is
# normalised onto the §3.1 columns (Timestamp, User, Activity, Workload,
# Object, Result). Results are ephemeral (§4.1): returned on stdout only and
# never written to disk; the only persistence is the audit event written
# through -WriteAudit. The worker is read-only: only Graph GET requests and
# read-only Purview searches are issued.

$script:AuditSearchWorkloadBackends = [ordered]@{
    'Exchange'   = 'Purview'
    'SharePoint' = 'Purview'
    'OneDrive'   = 'Purview'
    'Directory'  = 'Graph'
    'SignIn'     = 'Graph'
}

$script:AuditSearchPurviewRecordTypes = [ordered]@{
    'Exchange'   = @('ExchangeAdmin', 'ExchangeItem')
    'SharePoint' = @('SharePoint')
    'OneDrive'   = @('OneDrive')
}

$script:AuditSearchGraphResources = [ordered]@{
    'Directory' = 'directoryAudits'
    'SignIn'    = 'signIns'
}

function Get-AuditSearchBackend {
    <#
    .SYNOPSIS
        Resolves the audit-search backend for a workload (SPEC §11.1).
    .DESCRIPTION
        Graph directoryAudits/signIns cover the Directory and SignIn workloads;
        Purview audit search covers the content workloads Exchange, SharePoint,
        and OneDrive. Matching is case-insensitive; unknown workloads return
        'Unknown' so callers can raise a structured error.
    .PARAMETER Workload
        Workload name, e.g. 'Exchange' or 'Directory'.
    .EXAMPLE
        Get-AuditSearchBackend -Workload 'sharepoint'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string]$Workload
    )

    $key = $Workload.Trim()
    foreach ($name in @($script:AuditSearchWorkloadBackends.Keys)) {
        if ($name.Equals($key, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $script:AuditSearchWorkloadBackends[$name]
        }
    }
    return 'Unknown'
}

function Get-AuditSearchWorkloads {
    <#
    .SYNOPSIS
        Lists the workload keys the audit-search worker can route.
    .EXAMPLE
        Get-AuditSearchWorkloads
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @($script:AuditSearchWorkloadBackends.Keys)
}

function Test-AuditSearchDates {
    <#
    .SYNOPSIS
        Validates the optional search date window.
    .DESCRIPTION
        Empty bounds are allowed (the Purview backend then defaults to the
        last 90 days); supplied bounds must be parseable datetimes with the
        start not after the end.
    .PARAMETER StartDate
        Optional window start (parseable datetime).
    .PARAMETER EndDate
        Optional window end (parseable datetime).
    #>
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
            throw "audit-search.invalid_date_range: start date '$StartDate' is after end date '$EndDate'"
        }
    }
    catch {
        if ($_.Exception.Message -like 'audit-search.*') {
            throw
        }
        throw "audit-search.invalid_date: dates must be parseable datetimes: $($_.Exception.Message)"
    }
}

function New-AuditSearchEvent {
    <#
    .SYNOPSIS
        Builds the audit event a manual search writes (SPEC §8).
    .DESCRIPTION
        The event carries the search id, the resolved workloads, and the
        applied filters; it flows through the -WriteAudit seam to the app
        audit sink. Search results themselves are never persisted.
    .PARAMETER TenantId
        Tenant the search ran against.
    .PARAMETER Action
        'audit.search' for a result search, 'audit.search.export' for an export.
    .PARAMETER SearchId
        Unique id of this search run.
    .PARAMETER Detail
        Optional extra event members (workloads, filters, result count).
    .EXAMPLE
        New-AuditSearchEvent -TenantId 'tenant-a' -Action 'audit.search' -SearchId 'search-1'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('audit.search', 'audit.search.export')]
        [string]$Action,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SearchId,

        [Parameter()]
        [hashtable]$Detail = @{}
    )

    $audit = @{
        id        = [guid]::NewGuid().ToString()
        tenantId  = $TenantId
        action    = $Action
        targetId  = $SearchId
        timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    foreach ($key in @($Detail.Keys)) {
        $audit[$key] = $Detail[$key]
    }
    return $audit
}

function Get-AuditSearchPropertyValue {
    <#
    .SYNOPSIS
        Reads a property from a Graph entry or hashtable without throwing.
    .DESCRIPTION
        Graph entries arrive as PSCustomObject and envelopes as hashtables;
        both yield $null for missing members, but a malformed wrapper can
        throw, so every read goes through this helper.
    .PARAMETER Item
        The entry to read from.
    .PARAMETER Name
        Property name.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [object]$Item,

        [Parameter(Mandatory)]
        [string]$Name
    )

    if ($null -eq $Item) {
        return $null
    }
    try {
        if ($Item -is [System.Collections.IDictionary]) {
            if ($Item.Contains($Name)) {
                return $Item[$Name]
            }
            return $null
        }
        return $Item.$Name
    }
    catch {
        return $null
    }
}

function ConvertFrom-GraphDirectoryAudit {
    <#
    .SYNOPSIS
        Normalises a Graph directoryAudits entry onto the §3.1 columns.
    .DESCRIPTION
        Timestamp is activityDateTime, User is the initiating user (falling
        back to the app display name, then 'System'), Activity is
        activityDisplayName, Object is the first target resource, and Result
        is the Graph result. IpAddress stays empty: directory audits carry no
        client IP, so an IP filter excludes them.
    .PARAMETER Entry
        Graph directoryAudits entry.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Entry
    )

    $user = ''
    $initiatedBy = Get-AuditSearchPropertyValue -Item $Entry -Name 'initiatedBy'
    $initiatedUser = Get-AuditSearchPropertyValue -Item $initiatedBy -Name 'user'
    $userPrincipal = Get-AuditSearchPropertyValue -Item $initiatedUser -Name 'userPrincipalName'
    if (-not [string]::IsNullOrWhiteSpace([string]$userPrincipal)) {
        $user = [string]$userPrincipal
    }
    else {
        $initiatedApp = Get-AuditSearchPropertyValue -Item $initiatedBy -Name 'app'
        $appName = Get-AuditSearchPropertyValue -Item $initiatedApp -Name 'displayName'
        if (-not [string]::IsNullOrWhiteSpace([string]$appName)) {
            $user = [string]$appName
        }
    }
    if ($user.Length -eq 0) {
        $user = 'System'
    }

    $activity = ''
    $activityName = Get-AuditSearchPropertyValue -Item $Entry -Name 'activityDisplayName'
    if (-not [string]::IsNullOrWhiteSpace([string]$activityName)) {
        $activity = [string]$activityName
    }

    $object = ''
    $targets = @(Get-AuditSearchPropertyValue -Item $Entry -Name 'targetResources')
    foreach ($target in $targets) {
        if ($null -eq $target) {
            continue
        }
        foreach ($prop in @('userPrincipalName', 'displayName', 'id')) {
            $candidate = Get-AuditSearchPropertyValue -Item $target -Name $prop
            if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
                $object = [string]$candidate
                break
            }
        }
        if ($object.Length -gt 0) {
            break
        }
    }

    $result = ''
    $resultValue = Get-AuditSearchPropertyValue -Item $Entry -Name 'result'
    if (-not [string]::IsNullOrWhiteSpace([string]$resultValue)) {
        $result = [string]$resultValue
    }

    $timestamp = ''
    $activityDate = Get-AuditSearchPropertyValue -Item $Entry -Name 'activityDateTime'
    if (-not [string]::IsNullOrWhiteSpace([string]$activityDate)) {
        $timestamp = [string]$activityDate
    }

    return [pscustomobject]@{
        Timestamp = $timestamp
        User      = $user
        Activity  = $activity
        Workload  = 'Directory'
        Object    = $object
        Result    = $result
        IpAddress = ''
    }
}

function ConvertFrom-GraphSignIn {
    <#
    .SYNOPSIS
        Normalises a Graph signIns entry onto the §3.1 columns.
    .DESCRIPTION
        Timestamp is createdDateTime, User is userPrincipalName, Activity is
        the app display name, Object is the resource, and Result maps the
        sign-in status errorCode (0 is success). IpAddress feeds the IP
        filter and is stripped from the returned shape.
    .PARAMETER Entry
        Graph signIns entry.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Entry
    )

    $user = ''
    $userPrincipal = Get-AuditSearchPropertyValue -Item $Entry -Name 'userPrincipalName'
    if (-not [string]::IsNullOrWhiteSpace([string]$userPrincipal)) {
        $user = [string]$userPrincipal
    }

    $activity = ''
    $appName = Get-AuditSearchPropertyValue -Item $Entry -Name 'appDisplayName'
    if (-not [string]::IsNullOrWhiteSpace([string]$appName)) {
        $activity = [string]$appName
    }
    if ($activity.Length -eq 0) {
        $activity = 'Sign-in'
    }

    $object = ''
    $resource = Get-AuditSearchPropertyValue -Item $Entry -Name 'resourceDisplayName'
    if (-not [string]::IsNullOrWhiteSpace([string]$resource)) {
        $object = [string]$resource
    }
    if ($object.Length -eq 0) {
        $object = $user
    }

    $ip = ''
    $ipAddress = Get-AuditSearchPropertyValue -Item $Entry -Name 'ipAddress'
    if (-not [string]::IsNullOrWhiteSpace([string]$ipAddress)) {
        $ip = [string]$ipAddress
    }

    $result = 'success'
    $status = Get-AuditSearchPropertyValue -Item $Entry -Name 'status'
    $errorCode = Get-AuditSearchPropertyValue -Item $status -Name 'errorCode'
    if ($null -ne $errorCode -and [string]$errorCode -ne '0') {
        $result = 'failure'
    }

    $timestamp = ''
    $created = Get-AuditSearchPropertyValue -Item $Entry -Name 'createdDateTime'
    if (-not [string]::IsNullOrWhiteSpace([string]$created)) {
        $timestamp = [string]$created
    }

    return [pscustomobject]@{
        Timestamp = $timestamp
        User      = $user
        Activity  = $activity
        Workload  = 'SignIn'
        Object    = $object
        Result    = $result
        IpAddress = $ip
    }
}

function ConvertFrom-UnifiedAuditRecord {
    <#
    .SYNOPSIS
        Normalises a Purview Search-UnifiedAuditLog record onto the §3.1 columns.
    .DESCRIPTION
        Timestamp is CreationDate (UTC ISO-8601), User and Activity join the
        record's UserIds and Operations, Workload is the RecordType, Object is
        the AuditData ObjectId, and Result is the AuditData Result when the
        record carries one. IpAddress is the AuditData ClientIP so the IP
        filter can match; it is stripped from the returned shape.
    .PARAMETER Record
        Search-UnifiedAuditLog record.
    .PARAMETER Workload
        Requested workload key; used as the Workload fallback when the record
        carries no RecordType.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Record,

        [Parameter(Mandatory)]
        [string]$Workload
    )

    $auditData = @{}
    $auditDataJson = Get-AuditSearchPropertyValue -Item $Record -Name 'AuditData'
    if (-not [string]::IsNullOrWhiteSpace([string]$auditDataJson)) {
        try {
            $parsed = ([string]$auditDataJson) | ConvertFrom-Json -AsHashtable
            if ($null -ne $parsed) {
                $auditData = $parsed
            }
        }
        catch {
            $auditData = @{}
        }
    }

    $userIds = @(Get-AuditSearchPropertyValue -Item $Record -Name 'UserIds')
    $users = foreach ($entry in $userIds) {
        if (-not [string]::IsNullOrWhiteSpace([string]$entry)) {
            [string]$entry
        }
    }

    $operations = @(Get-AuditSearchPropertyValue -Item $Record -Name 'Operations')
    $activities = foreach ($entry in $operations) {
        if (-not [string]::IsNullOrWhiteSpace([string]$entry)) {
            [string]$entry
        }
    }

    $object = ''
    if ($auditData.ContainsKey('ObjectId')) {
        $object = [string]$auditData['ObjectId']
    }

    $result = ''
    if ($auditData.ContainsKey('Result')) {
        $result = [string]$auditData['Result']
    }

    $ip = ''
    if ($auditData.ContainsKey('ClientIP')) {
        $ip = [string]$auditData['ClientIP']
    }

    $recordType = Get-AuditSearchPropertyValue -Item $Record -Name 'RecordType'
    $workload = if ([string]::IsNullOrWhiteSpace([string]$recordType)) { $Workload } else { [string]$recordType }

    $timestamp = ''
    $created = Get-AuditSearchPropertyValue -Item $Record -Name 'CreationDate'
    if ($created -is [datetime]) {
        $timestamp = $created.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    elseif (-not [string]::IsNullOrWhiteSpace([string]$created)) {
        $timestamp = [string]$created
    }

    return [pscustomobject]@{
        Timestamp = $timestamp
        User      = ($users -join ', ')
        Activity  = ($activities -join ', ')
        Workload  = $workload
        Object    = $object
        Result    = $result
        IpAddress = $ip
    }
}

function Test-AuditSearchFilter {
    <#
    .SYNOPSIS
        Applies the client-side user, activity, and IP filters to a normalised row.
    .DESCRIPTION
        User and Activity match case-insensitively as substrings; IpAddress
        matches case-insensitively and exactly. Empty filters match everything.
    .PARAMETER Row
        Normalised audit-search row (carries IpAddress until it is stripped).
    .PARAMETER User
        Optional user substring filter.
    .PARAMETER Activity
        Optional activity substring filter.
    .PARAMETER Ip
        Optional exact IP filter.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [string]$User = '',

        [string]$Activity = '',

        [string]$Ip = ''
    )

    $userFilter = $User.Trim()
    if ($userFilter.Length -gt 0) {
        $rowUser = [string]$Row.User
        if ($rowUser.IndexOf($userFilter, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            return $false
        }
    }

    $activityFilter = $Activity.Trim()
    if ($activityFilter.Length -gt 0) {
        $rowActivity = [string]$Row.Activity
        if ($rowActivity.IndexOf($activityFilter, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            return $false
        }
    }

    $ipFilter = $Ip.Trim()
    if ($ipFilter.Length -gt 0) {
        $rowIp = [string]$Row.IpAddress
        if (-not $rowIp.Equals($ipFilter, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
    }

    return $true
}

function New-AuditSearchGraphUri {
    <#
    .SYNOPSIS
        Builds the Graph auditLogs URI for a directory or sign-in search.
    .DESCRIPTION
        The date window is pushed to the backend as an activityDateTime
        (directoryAudits) or createdDateTime (signIns) $filter; the filter is
        URL-encoded because Graph expects encoded query strings.
    .PARAMETER Workload
        Canonical workload key: Directory or SignIn.
    .PARAMETER StartDate
        Optional window start (parseable datetime).
    .PARAMETER EndDate
        Optional window end (parseable datetime).
    .PARAMETER Top
        Page size requested from Graph.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Directory', 'SignIn')]
        [string]$Workload,

        [string]$StartDate = '',

        [string]$EndDate = '',

        [Parameter(Mandatory)]
        [int]$Top
    )

    $resource = $script:AuditSearchGraphResources[$Workload]
    $timeProperty = if ($Workload -eq 'Directory') { 'activityDateTime' } else { 'createdDateTime' }

    $filters = [System.Collections.Generic.List[string]]::new()
    if ($StartDate.Trim().Length -gt 0) {
        $start = ([datetime]$StartDate).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $filters.Add("$timeProperty ge $start")
    }
    if ($EndDate.Trim().Length -gt 0) {
        $end = ([datetime]$EndDate).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $filters.Add("$timeProperty le $end")
    }

    $uri = '/v1.0/auditLogs/' + $resource + '?$top=' + $Top
    if ($filters.Count -gt 0) {
        $uri += '&$filter=' + [uri]::EscapeDataString(($filters -join ' and '))
    }
    return $uri
}

function Invoke-AuditSearchGraph {
    <#
    .SYNOPSIS
        Pages through a Graph auditLogs collection following @odata.nextLink.
    .DESCRIPTION
        Read-only GET requests only. The page guard bounds the pull so a
        broad manual search cannot loop without limit.
    .PARAMETER Uri
        Initial (relative or absolute) Graph URI.
    .PARAMETER MaxPages
        Maximum pages to fetch.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)]
        [string]$Uri,

        [int]$MaxPages = 100
    )

    $entries = [System.Collections.Generic.List[object]]::new()
    $pages = 0
    do {
        $pages++
        if ($pages -gt $MaxPages) {
            break
        }
        $response = Invoke-MgGraphRequest -Method GET -Uri $Uri
        $value = Get-AuditSearchPropertyValue -Item $response -Name 'value'
        if ($null -ne $value) {
            foreach ($entry in @($value)) {
                if ($null -ne $entry) {
                    $entries.Add($entry)
                }
            }
        }
        $next = Get-AuditSearchPropertyValue -Item $response -Name '@odata.nextLink'
        if ([string]::IsNullOrWhiteSpace([string]$next)) {
            break
        }
        $Uri = [string]$next
    } while ($true)

    return @($entries)
}

function Search-AuditSearchUnified {
    <#
    .SYNOPSIS
        Runs the Purview audit search for one content workload.
    .DESCRIPTION
        Search-UnifiedAuditLog with the workload's RecordTypes, paginated
        with a ReturnLargeSet session like the module's Purview collector.
        Without a date window the search defaults to the last 90 days, the
        unified audit log's default retention floor.
    .PARAMETER Workload
        Canonical workload key: Exchange, SharePoint, or OneDrive.
    .PARAMETER StartDate
        Optional window start (parseable datetime).
    .PARAMETER EndDate
        Optional window end (parseable datetime).
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Exchange', 'SharePoint', 'OneDrive')]
        [string]$Workload,

        [string]$StartDate = '',

        [string]$EndDate = ''
    )

    $start = (Get-Date).AddDays(-90)
    if ($StartDate.Trim().Length -gt 0) {
        $start = [datetime]$StartDate
    }
    $end = (Get-Date)
    if ($EndDate.Trim().Length -gt 0) {
        $end = [datetime]$EndDate
    }

    $searchParams = @{
        StartDate      = $start
        EndDate        = $end
        ResultSize     = 5000
        RecordType     = @($script:AuditSearchPurviewRecordTypes[$Workload])
        SessionId      = [guid]::NewGuid().ToString()
        SessionCommand = 'ReturnLargeSet'
    }

    $entries = [System.Collections.Generic.List[object]]::new()
    $pages = 0
    do {
        $pages++
        if ($pages -gt 100) {
            break
        }
        $batch = @(Search-UnifiedAuditLog @searchParams)
        if ($batch.Count -eq 0) {
            break
        }
        foreach ($record in $batch) {
            if ($null -ne $record) {
                $entries.Add($record)
            }
        }
        $total = 0
        $resultCount = Get-AuditSearchPropertyValue -Item $batch[0] -Name 'ResultCount'
        if ($null -ne $resultCount) {
            try {
                $total = [int]$resultCount
            }
            catch {
                $total = 0
            }
        }
        if ($total -gt 0 -and $entries.Count -ge $total) {
            break
        }
    } while ($true)

    return @($entries)
}

function Sort-AuditSearchRows {
    <#
    .SYNOPSIS
        Sorts normalised rows newest-first and caps them at Top.
    .DESCRIPTION
        Rows with unparseable timestamps sort last; the sort is stable enough
        for the manual-search table, which shows newest activity first.
    .PARAMETER Rows
        Normalised audit-search rows.
    .PARAMETER Top
        Maximum rows to return.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)]
        [object[]]$Rows,

        [Parameter(Mandatory)]
        [int]$Top
    )

    $sorted = @($Rows | Sort-Object -Property @{
        Expression = {
            $parsed = [datetime]::MinValue
            if (-not [datetime]::TryParse([string]$_.Timestamp, [ref]$parsed)) {
                return [datetime]::MinValue
            }
            return $parsed.ToUniversalTime()
        }
    } -Descending | Select-Object -First $Top)

    $results = foreach ($row in $sorted) {
        if ($row.PSObject.Properties.Name -contains 'IpAddress') {
            $row.PSObject.Properties.Remove('IpAddress')
        }
        $row
    }
    return @($results)
}

function Search-AuditLog {
    <#
    .SYNOPSIS
        Runs a manual audit-log search with per-workload routing (SPEC §11.1).
    .DESCRIPTION
        Each requested workload routes to its backend: Graph directoryAudits
        (Directory) and signIns (SignIn) where those endpoints cover the
        workload, Purview audit search (Search-UnifiedAuditLog) for the
        content workloads Exchange, SharePoint, and OneDrive. An empty
        workload list searches every supported workload. Records are
        normalised onto the §3.1 columns (Timestamp, User, Activity,
        Workload, Object, Result); the date window goes to the backend while
        user, activity, and IP filter client-side. Results are ephemeral
        (§4.1): returned on stdout only, never written to disk. The only
        persistence is the audit event written through -WriteAudit.
    .PARAMETER TenantId
        Tenant the search runs against.
    .PARAMETER StartDate
        Optional window start (parseable datetime).
    .PARAMETER EndDate
        Optional window end (parseable datetime, must follow StartDate).
    .PARAMETER User
        Optional case-insensitive user substring filter.
    .PARAMETER Activity
        Optional case-insensitive activity substring filter.
    .PARAMETER Workload
        Workload keys to search; empty searches all supported workloads.
    .PARAMETER Ip
        Optional exact client-IP filter.
    .PARAMETER Top
        Maximum rows to return.
    .PARAMETER WriteAudit
        Audit seam receiving the audit.search event.
    .EXAMPLE
        Search-AuditLog -TenantId 'tenant-a' -Workload @('Exchange') -StartDate '2026-09-01' -EndDate '2026-09-28'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$StartDate = '',

        [Parameter()]
        [string]$EndDate = '',

        [Parameter()]
        [string]$User = '',

        [Parameter()]
        [string]$Activity = '',

        [Parameter()]
        [string[]]$Workload = @(),

        [Parameter()]
        [string]$Ip = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    Test-AuditSearchDates -StartDate $StartDate -EndDate $EndDate

    $requested = @($Workload | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ })
    if ($requested.Count -eq 0) {
        $requested = Get-AuditSearchWorkloads
    }
    $resolved = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $requested) {
        $canonical = ''
        foreach ($known in @($script:AuditSearchWorkloadBackends.Keys)) {
            if ($known.Equals($name.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
                $canonical = $known
                break
            }
        }
        if ($canonical.Length -eq 0) {
            throw "audit-search.invalid_workload: workload '$name' is not supported"
        }
        if (-not $resolved.Contains($canonical)) {
            $resolved.Add($canonical)
        }
    }

    $searchId = [guid]::NewGuid().ToString()
    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($name in $resolved) {
        $backend = Get-AuditSearchBackend -Workload $name
        switch ($backend) {
            'Graph' {
                $uri = New-AuditSearchGraphUri -Workload $name -StartDate $StartDate -EndDate $EndDate -Top $Top
                $entries = Invoke-AuditSearchGraph -Uri $uri
                foreach ($entry in $entries) {
                    $row = if ($name -eq 'Directory') {
                        ConvertFrom-GraphDirectoryAudit -Entry $entry
                    }
                    else {
                        ConvertFrom-GraphSignIn -Entry $entry
                    }
                    if ($null -ne $row) {
                        $rows.Add($row)
                    }
                }
            }
            'Purview' {
                $records = Search-AuditSearchUnified -Workload $name -StartDate $StartDate -EndDate $EndDate
                foreach ($record in $records) {
                    $row = ConvertFrom-UnifiedAuditRecord -Record $record -Workload $name
                    if ($null -ne $row) {
                        $rows.Add($row)
                    }
                }
            }
        }
    }

    $filtered = foreach ($row in $rows) {
        if (Test-AuditSearchFilter -Row $row -User $User -Activity $Activity -Ip $Ip) {
            $row
        }
    }

    $results = Sort-AuditSearchRows -Rows @($filtered) -Top $Top

    $null = & $WriteAudit (New-AuditSearchEvent -TenantId $TenantId -Action 'audit.search' -SearchId $searchId -Detail @{
        workloads   = @($resolved)
        resultCount = @($results).Count
        startDate   = $StartDate.Trim()
        endDate     = $EndDate.Trim()
        user        = $User.Trim()
        activity    = $Activity.Trim()
        ip          = $Ip.Trim()
    })

    return [pscustomobject]@{
        tenantId   = $TenantId
        searchId   = $searchId
        workloads  = @($resolved)
        totalCount = @($results).Count
        results    = @($results)
    }
}

function Read-AuditSearchJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into search-audit parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        action (search or directory) with the scoped filters. The envelope
        carries references and search parameters only; secrets are never
        present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-AuditSearchJob -Path './run/audit-search-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Audit-search job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Audit-search job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Audit-search job is missing required field: tenantId'
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

    $action = 'search'
    if ($filters['action']) {
        $action = ([string]$filters['action']).Trim().ToLowerInvariant()
    }
    if (@('search', 'directory') -notcontains $action) {
        throw "Audit-search job has unsupported action: $action"
    }

    $workloads = @()
    $rawWorkloads = $filters['workloads']
    if ($rawWorkloads -is [System.Collections.IEnumerable] -and $rawWorkloads -isnot [string]) {
        foreach ($entry in @($rawWorkloads)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$entry)) {
                $workloads += [string]$entry
            }
        }
    }
    elseif (-not [string]::IsNullOrWhiteSpace([string]$rawWorkloads)) {
        $workloads = @([string]$rawWorkloads)
    }
    if ($workloads.Count -eq 0 -and $filters['workload']) {
        $workloads = @([string]$filters['workload'])
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
        TenantId  = $tenantId
        Action    = $action
        Workload  = $workloads
        StartDate = [string]$filters['startDate']
        EndDate   = [string]$filters['endDate']
        User      = [string]$filters['user']
        Activity  = [string]$filters['activity']
        Ip        = [string]$filters['ip']
        Category  = [string]$filters['category']
        Top       = $top
    }
}
