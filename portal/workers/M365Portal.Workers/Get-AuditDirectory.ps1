# Get-AuditDirectory.ps1 — EPIC-032 directory-audits worker (SPEC §3.4, §6, §11.1; T-0622).
#
# Exposes Graph directoryAudits (SPEC §11.1: Graph covers the directory
# workload) with category and date filters, normalised onto the §3.4 columns
# (Timestamp, Activity, Initiated by, Target, Result). Read-only: only Graph
# GET requests are issued; results are returned on stdout only and never
# written to disk.

$script:AuditDirectoryCategories = @(
    'UserManagement'
    'GroupManagement'
    'ApplicationManagement'
    'RoleManagement'
    'DirectoryManagement'
    'PolicyManagement'
    'ResourceManagement'
)

function Get-AuditDirectoryCategories {
    <#
    .SYNOPSIS
        Lists the Graph directoryAudits category values the worker accepts.
    .EXAMPLE
        Get-AuditDirectoryCategories
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @($script:AuditDirectoryCategories)
}

function ConvertTo-AuditDirectoryCategory {
    <#
    .SYNOPSIS
        Canonicalises a directory-audits category filter.
    .DESCRIPTION
        Matching is case-insensitive; an unknown category raises a structured
        error so callers never send an invalid $filter to Graph.
    .PARAMETER Category
        Category name, e.g. 'UserManagement'.
    .EXAMPLE
        ConvertTo-AuditDirectoryCategory -Category 'usermanagement'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string]$Category
    )

    $key = $Category.Trim()
    foreach ($known in $script:AuditDirectoryCategories) {
        if ($known.Equals($key, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $known
        }
    }
    throw "audit-search.invalid_category: category '$Category' is not a directoryAudits category"
}

function Test-AuditDirectoryDates {
    <#
    .SYNOPSIS
        Validates the optional directory-audits date window.
    .DESCRIPTION
        Empty bounds are allowed; supplied bounds must be parseable datetimes
        with the start not after the end.
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

function Get-AuditDirectoryPropertyValue {
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

function ConvertFrom-AuditDirectoryEntry {
    <#
    .SYNOPSIS
        Normalises a Graph directoryAudits entry onto the §3.4 columns.
    .DESCRIPTION
        Timestamp is activityDateTime, Activity is activityDisplayName,
        Initiated by is the initiating user (falling back to the app display
        name, then 'System'), Target is the first target resource, and Result
        is the Graph result.
    .PARAMETER Entry
        Graph directoryAudits entry.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Entry
    )

    $activity = ''
    $activityName = Get-AuditDirectoryPropertyValue -Item $Entry -Name 'activityDisplayName'
    if (-not [string]::IsNullOrWhiteSpace([string]$activityName)) {
        $activity = [string]$activityName
    }

    $initiatedBy = ''
    $initiator = Get-AuditDirectoryPropertyValue -Item $Entry -Name 'initiatedBy'
    $initiatedUser = Get-AuditDirectoryPropertyValue -Item $initiator -Name 'user'
    $userPrincipal = Get-AuditDirectoryPropertyValue -Item $initiatedUser -Name 'userPrincipalName'
    if (-not [string]::IsNullOrWhiteSpace([string]$userPrincipal)) {
        $initiatedBy = [string]$userPrincipal
    }
    else {
        $initiatedApp = Get-AuditDirectoryPropertyValue -Item $initiator -Name 'app'
        $appName = Get-AuditDirectoryPropertyValue -Item $initiatedApp -Name 'displayName'
        if (-not [string]::IsNullOrWhiteSpace([string]$appName)) {
            $initiatedBy = [string]$appName
        }
    }
    if ($initiatedBy.Length -eq 0) {
        $initiatedBy = 'System'
    }

    $target = ''
    $targets = @(Get-AuditDirectoryPropertyValue -Item $Entry -Name 'targetResources')
    foreach ($resource in $targets) {
        if ($null -eq $resource) {
            continue
        }
        foreach ($prop in @('userPrincipalName', 'displayName', 'id')) {
            $candidate = Get-AuditDirectoryPropertyValue -Item $resource -Name $prop
            if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
                $target = [string]$candidate
                break
            }
        }
        if ($target.Length -gt 0) {
            break
        }
    }

    $result = ''
    $resultValue = Get-AuditDirectoryPropertyValue -Item $Entry -Name 'result'
    if (-not [string]::IsNullOrWhiteSpace([string]$resultValue)) {
        $result = [string]$resultValue
    }

    $timestamp = ''
    $activityDate = Get-AuditDirectoryPropertyValue -Item $Entry -Name 'activityDateTime'
    if (-not [string]::IsNullOrWhiteSpace([string]$activityDate)) {
        $timestamp = [string]$activityDate
    }

    return [pscustomobject]@{
        Timestamp   = $timestamp
        Activity    = $activity
        InitiatedBy = $initiatedBy
        Target      = $target
        Result      = $result
    }
}

function Get-AuditDirectory {
    <#
    .SYNOPSIS
        Lists Graph directoryAudits with category and date filters (SPEC §3.4).
    .DESCRIPTION
        The category and date window are pushed to Graph as a directoryAudits
        $filter; entries are normalised onto the §3.4 columns (Timestamp,
        Activity, Initiated by, Target, Result), sorted newest-first, and
        capped at Top. Read-only: only Graph GET requests are issued, and
        results are returned on stdout only.
    .PARAMETER TenantId
        Tenant the query runs against.
    .PARAMETER Category
        Optional directoryAudits category (case-insensitive).
    .PARAMETER StartDate
        Optional window start (parseable datetime).
    .PARAMETER EndDate
        Optional window end (parseable datetime, must follow StartDate).
    .PARAMETER Top
        Maximum entries to return.
    .EXAMPLE
        Get-AuditDirectory -TenantId 'tenant-a' -Category 'UserManagement' -StartDate '2026-09-01' -EndDate '2026-09-28'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$Category = '',

        [Parameter()]
        [string]$StartDate = '',

        [Parameter()]
        [string]$EndDate = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100
    )

    Test-AuditDirectoryDates -StartDate $StartDate -EndDate $EndDate

    $category = ''
    if ($Category.Trim().Length -gt 0) {
        $category = ConvertTo-AuditDirectoryCategory -Category $Category
    }

    $filters = [System.Collections.Generic.List[string]]::new()
    if ($category.Length -gt 0) {
        $filters.Add("category eq '$category'")
    }
    if ($StartDate.Trim().Length -gt 0) {
        $start = ([datetime]$StartDate).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $filters.Add("activityDateTime ge $start")
    }
    if ($EndDate.Trim().Length -gt 0) {
        $end = ([datetime]$EndDate).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $filters.Add("activityDateTime le $end")
    }

    $uri = '/v1.0/auditLogs/directoryAudits?$top=' + $Top
    if ($filters.Count -gt 0) {
        $uri += '&$filter=' + [uri]::EscapeDataString(($filters -join ' and '))
    }

    $entries = [System.Collections.Generic.List[object]]::new()
    $pages = 0
    do {
        $pages++
        if ($pages -gt 100) {
            break
        }
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        $value = Get-AuditDirectoryPropertyValue -Item $response -Name 'value'
        if ($null -ne $value) {
            foreach ($entry in @($value)) {
                if ($null -ne $entry) {
                    $entries.Add($entry)
                }
            }
        }
        $next = Get-AuditDirectoryPropertyValue -Item $response -Name '@odata.nextLink'
        if ([string]::IsNullOrWhiteSpace([string]$next)) {
            break
        }
        $uri = [string]$next
    } while ($true)

    $rows = foreach ($entry in $entries) {
        ConvertFrom-AuditDirectoryEntry -Entry $entry
    }

    $sorted = @($rows | Sort-Object -Property @{
        Expression = {
            $parsed = [datetime]::MinValue
            if (-not [datetime]::TryParse([string]$_.Timestamp, [ref]$parsed)) {
                return [datetime]::MinValue
            }
            return $parsed.ToUniversalTime()
        }
    } -Descending | Select-Object -First $Top)

    return [pscustomobject]@{
        tenantId   = $TenantId
        category   = $category
        totalCount = @($sorted).Count
        entries    = @($sorted)
    }
}
