# Invoke-SharePointSiteAction.ps1 — EPIC-025 site delete/restore and recycle-bin
# lifecycle worker (SPEC §2 US-3, §3.1, §4.1, §6, §8; T-0485).
#
# Covers the destructive lifecycle: soft-delete a site, restore it from the
# deleted view, list the recycle bin, and restore or permanently empty
# recycle-bin entries. Delete and empty are destructive, so they follow the
# EPIC-006 gated-executor contract (T-0108): -DryRun reports the intended
# change without writing, -Confirmed is re-checked here so a job that skipped
# confirmation cannot apply, every apply captures before/after and emits one
# audit record plus a SiteOperation-shaped row (T-0481) carrying state and
# result. Restore is a write too, so it is audited, but it is reversible and
# does not require confirmation (SPEC §8 names delete and empty destructive).
# The supervisor connects Graph in the child process after materializing the
# tenant credential in-process; this file never touches secrets.
#
# Deleted sites are group-backed SharePoint sites, so the Graph directory
# deletedItems surface is the recycle bin: DELETE /groups/{id} soft-deletes,
# POST /directory/deletedItems/{id}/restore restores, and DELETE
# /directory/deletedItems/{id} empties permanently.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SharePointSiteActions = @(
    'delete'
    'restore'
    'recyclebin-list'
    'recyclebin-restore'
    'recyclebin-empty'
)

function ConvertTo-SharePointSiteRow {
    <#
    .SYNOPSIS
        Shapes one live Graph site/group into the lifecycle before snapshot.
    .DESCRIPTION
        Keeps the identity, display name, URL, and active state the delete plan
        needs. The URL falls back to the group mail when Graph exposes one.
    .PARAMETER Site
        The Graph group/site record.
    .EXAMPLE
        ConvertTo-SharePointSiteRow -Site $site
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Site
    )

    $id = [string]$Site['id']
    $displayName = [string]$Site['displayName']
    if ([string]::IsNullOrWhiteSpace($displayName)) {
        $displayName = $id
    }
    $url = $null
    if (-not [string]::IsNullOrWhiteSpace([string]$Site['mail'])) {
        $url = 'https://{0}' -f [string]$Site['mail']
    }
    elseif (-not [string]::IsNullOrWhiteSpace([string]$Site['webUrl'])) {
        $url = [string]$Site['webUrl']
    }

    return [pscustomobject]@{
        id          = $id
        displayName = $displayName
        url         = $url
        type        = [string]$Site['visibility']
        state       = 'active'
    }
}

function ConvertTo-SharePointDeletedSiteRow {
    <#
    .SYNOPSIS
        Shapes one deleted Graph item into the recycle-bin/deleted-view row.
    .DESCRIPTION
        Keeps the identity and deletion metadata (deleted-at, days left before
        the 30-day retention purges the item) the restore picker needs.
        Days-until-purge is null when Graph reports no deletion time.
    .PARAMETER Item
        The Graph directory deletedItems record.
    .EXAMPLE
        ConvertTo-SharePointDeletedSiteRow -Item $item
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Item
    )

    $id = [string]$Item['id']
    $displayName = [string]$Item['displayName']
    if ([string]::IsNullOrWhiteSpace($displayName)) {
        $displayName = $id
    }
    $url = $null
    if (-not [string]::IsNullOrWhiteSpace([string]$Item['mail'])) {
        $url = 'https://{0}' -f [string]$Item['mail']
    }

    $deletedAt = $null
    $rawDeleted = $Item['deletedDateTime']
    if ($null -ne $rawDeleted -and ([string]$rawDeleted).Trim().Length -gt 0) {
        try {
            $deletedAt = ([datetime]$rawDeleted).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        }
        catch {
            $deletedAt = [string]$rawDeleted
        }
    }

    $daysUntilPurge = $null
    if ($null -ne $deletedAt) {
        try {
            $elapsed = ((Get-Date).ToUniversalTime() - ([datetime]$deletedAt).ToUniversalTime()).TotalDays
            $remaining = [System.Math]::Floor(30 - $elapsed)
            if ($remaining -lt 0) {
                $remaining = 0
            }
            $daysUntilPurge = $remaining
        }
        catch {
            $daysUntilPurge = $null
        }
    }

    return [pscustomobject]@{
        id             = $id
        siteId         = $id
        displayName    = $displayName
        url            = $url
        deletedAt      = $deletedAt
        daysUntilPurge = $daysUntilPurge
    }
}

function ConvertTo-SharePointRecycleBinCursor {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-SharePointRecycleBinCursor {
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
        Write-Verbose 'Ignoring undecodable recycle-bin cursor and starting at the first page.'
    }
    return 0
}

function Get-SharePointSiteState {
    <#
    .SYNOPSIS
        Reads one live site/group for the delete before snapshot.
    .DESCRIPTION
        A site that is already deleted (or unknown) returns null so the caller
        refuses the delete with a structured error instead of deleting blindly.
    .PARAMETER SiteId
        Site/group identity.
    .EXAMPLE
        Get-SharePointSiteState -SiteId 'site-1'
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SiteId
    )

    try {
        $uri = '/v1.0/groups/{0}?$select=id,displayName,mail,visibility' -f $SiteId
        $site = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction Stop
        if ($null -eq $site) {
            return $null
        }
        return ConvertTo-SharePointSiteRow -Site $site
    }
    catch {
        return $null
    }
}

function Get-SharePointDeletedSiteState {
    <#
    .SYNOPSIS
        Reads one deleted site for the restore before snapshot.
    .DESCRIPTION
        Looks the identity up in the deleted set only. A site that is live (or
        unknown) returns null so the caller refuses the restore with a
        structured error instead of restoring blindly.
    .PARAMETER SiteId
        Deleted site/group identity.
    .EXAMPLE
        Get-SharePointDeletedSiteState -SiteId 'site-1'
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SiteId
    )

    try {
        $uri = '/v1.0/directory/deletedItems/{0}' -f $SiteId
        $item = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction Stop
        if ($null -eq $item) {
            return $null
        }
        return ConvertTo-SharePointDeletedSiteRow -Item $item
    }
    catch {
        return $null
    }
}

function Get-SharePointRecycleBin {
    <#
    .SYNOPSIS
        Lists deleted sites/items live from Graph.
    .DESCRIPTION
        Pages the directory deletedItems collection once, shapes the
        restore-picker rows, applies the search filter, and returns one cursor
        page. Only GET is issued; nothing is written to the tenant.
    .PARAMETER TenantId
        Tenant the items belong to. Carried through to the result envelope.
    .PARAMETER Search
        Case-insensitive substring match against display name and URL.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-SharePointRecycleBin -TenantId 'tenant-a' -Top 50
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
        [ValidateRange(1, 999)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $items = @(Invoke-MgGraphRequest -Method GET -Uri '/v1.0/directory/deletedItems/microsoft.graph.group')

    $rows = [System.Collections.Generic.List[object]]::new()
    $needle = $Search.Trim().ToLowerInvariant()
    foreach ($item in @($items)) {
        if ($null -eq $item) {
            continue
        }
        $row = ConvertTo-SharePointDeletedSiteRow -Item $item
        if ($needle.Length -gt 0) {
            $haystack = ('{0} {1}' -f $row.displayName, $row.url).ToLowerInvariant()
            if (-not $haystack.Contains($needle)) {
                continue
            }
        }
        $rows.Add($row)
    }

    $ordered = @($rows)
    $offset = ConvertFrom-SharePointRecycleBinCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-SharePointRecycleBinCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Invoke-SharePointSiteDelete {
    <#
    .SYNOPSIS
        Previews or applies the soft-delete of one SharePoint site.
    .DESCRIPTION
        -DryRun returns the plan with no Graph write. Without -DryRun,
        -Confirmed is required or the apply is refused. The site is looked up
        live first for the before snapshot; a site that is not found throws a
        structured NotFound error the BFF maps to a 4xx. Every apply emits one
        auditEvent plus a SiteOperation-shaped row carrying state and result.
    .PARAMETER TenantId
        Tenant the site belongs to. Carried through to the result envelope.
    .PARAMETER SiteId
        Site/group identity to soft-delete.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for apply; the BFF confirms the plan before dispatch.
    .PARAMETER Actor
        Caller identity recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-SharePointSiteDelete -TenantId 'tenant-a' -SiteId 'site-1' -Confirmed
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SiteId,

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    $siteKey = $SiteId.Trim()
    $before = Get-SharePointSiteState -SiteId $siteKey
    if ($null -eq $before) {
        throw "NotFound: site '$siteKey' was not found; delete is available only for a live site"
    }

    $targetName = [string]$before.displayName
    $after = [pscustomobject]@{
        id          = $siteKey
        displayName = $targetName
        url         = $before.url
        type        = $before.type
        state       = 'softDeleted'
    }
    $diff = @("Soft-delete site '$targetName' ($siteKey)")

    $plan = [pscustomobject]@{
        action               = 'delete'
        siteId               = $siteKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = $diff
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = (-not $Confirmed)
    }

    if ($DryRun) {
        return $plan
    }

    if (-not $Confirmed) {
        throw "sharepoint.confirm_required: delete of '$siteKey' requires explicit confirmation"
    }

    $null = Invoke-MgGraphRequest -Method DELETE -Uri ('/v1.0/groups/{0}' -f $siteKey)

    $appliedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    $audit = @{
        id            = [guid]::NewGuid().ToString()
        tenantId      = $TenantId
        action        = 'sharepoint.site.delete'
        targetId      = $siteKey
        targetName    = $targetName
        timestamp     = $appliedAt
        result        = 'success'
        before        = $before
        after         = $after
        error         = $null
        actor         = $Actor
        correlationId = $CorrelationId
    }
    & $WriteAudit $audit

    $operation = @{
        id        = [guid]::NewGuid().ToString()
        tenantId  = $TenantId
        siteId    = $siteKey
        operation = 'delete'
        state     = 'succeeded'
        by        = $Actor
        at        = $appliedAt
        result    = 'deleted'
    }

    return [pscustomobject]@{
        success       = $true
        state         = 'succeeded'
        operation     = 'delete'
        siteId        = $siteKey
        targetName    = $targetName
        plan          = $plan
        result        = @{ id = $siteKey; state = 'softDeleted' }
        auditEvent    = $audit
        siteOperation = $operation
    }
}

function Invoke-SharePointSiteRestore {
    <#
    .SYNOPSIS
        Previews or applies the restore of one soft-deleted SharePoint site.
    .DESCRIPTION
        -DryRun returns the plan with no Graph write. The site is looked up in
        the deleted set first for the before snapshot; a site that is not
        soft-deleted throws a structured NotFound error the BFF maps to a 4xx.
        Restore is a write, so every apply emits one auditEvent plus a
        SiteOperation-shaped row, but it is reversible and does not require
        confirmation.
    .PARAMETER TenantId
        Tenant the site belongs to. Carried through to the result envelope.
    .PARAMETER SiteId
        Soft-deleted site/group identity.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Optional explicit confirmation; restore does not require it.
    .PARAMETER Actor
        Caller identity recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-SharePointSiteRestore -TenantId 'tenant-a' -SiteId 'site-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SiteId,

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    $siteKey = $SiteId.Trim()
    $deleted = Get-SharePointDeletedSiteState -SiteId $siteKey
    if ($null -eq $deleted) {
        throw "NotFound: site '$siteKey' is not in the deleted view; restore is available only for a soft-deleted site"
    }

    $targetName = [string]$deleted.displayName
    $before = [pscustomobject]@{
        id          = $siteKey
        displayName = $targetName
        url         = $deleted.url
        state       = 'softDeleted'
    }
    $after = [pscustomobject]@{
        id          = $siteKey
        displayName = $targetName
        url         = $deleted.url
        state       = 'active'
    }
    $diff = @("Restore soft-deleted site '$targetName' ($siteKey)")

    $plan = [pscustomobject]@{
        action               = 'restore'
        siteId               = $siteKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = $diff
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = $false
    }

    if ($DryRun) {
        return $plan
    }

    $null = Invoke-MgGraphRequest -Method POST -Uri ('/v1.0/directory/deletedItems/{0}/restore' -f $siteKey)

    $appliedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    $audit = @{
        id            = [guid]::NewGuid().ToString()
        tenantId      = $TenantId
        action        = 'sharepoint.site.restore'
        targetId      = $siteKey
        targetName    = $targetName
        timestamp     = $appliedAt
        result        = 'success'
        before        = $before
        after         = $after
        error         = $null
        actor         = $Actor
        correlationId = $CorrelationId
    }
    & $WriteAudit $audit

    $operation = @{
        id        = [guid]::NewGuid().ToString()
        tenantId  = $TenantId
        siteId    = $siteKey
        operation = 'restore'
        state     = 'succeeded'
        by        = $Actor
        at        = $appliedAt
        result    = 'restored'
    }

    return [pscustomobject]@{
        success       = $true
        state         = 'succeeded'
        operation     = 'restore'
        siteId        = $siteKey
        targetName    = $targetName
        plan          = $plan
        result        = @{ id = $siteKey; state = 'active' }
        auditEvent    = $audit
        siteOperation = $operation
    }
}

function Invoke-SharePointRecycleBinAction {
    <#
    .SYNOPSIS
        Previews or applies restore/empty over selected recycle-bin entries.
    .DESCRIPTION
        Plan mode returns exactly which entries will change and performs no
        writes. Empty apply requires -Confirmed. Every applied entry gets a
        per-row before/after, one audit event, and one SiteOperation-shaped row,
        so a partial batch is always fully reported, never silent.
    .PARAMETER TenantId
        Tenant the entries belong to.
    .PARAMETER Action
        Restore returns the entries to the deleted-sites view; Empty purges
        them permanently.
    .PARAMETER RecycleBinIds
        Entry identities to act on.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for empty apply.
    .PARAMETER Actor
        Caller identity recorded on the audit events.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit events.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-SharePointRecycleBinAction -TenantId 'tenant-a' -Action 'restore' -RecycleBinIds @('site-1')
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('restore', 'empty')]
        [string]$Action,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$RecycleBinIds,

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    $ids = @($RecycleBinIds | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -ne '' })
    if ($ids.Count -eq 0) {
        throw 'sharepoint.empty_selection: at least one recycle-bin entry is required'
    }
    if ($Action -eq 'empty' -and -not $DryRun -and -not $Confirmed) {
        $entryWord = if ($ids.Count -eq 1) { 'entry' } else { 'entries' }
        throw "sharepoint.confirm_required: emptying $($ids.Count) recycle-bin $entryWord requires explicit confirmation"
    }

    $operationName = 'recyclebin.{0}' -f $Action
    $auditAction = 'sharepoint.{0}' -f $operationName

    if ($DryRun) {
        $planned = foreach ($id in $ids) {
            [pscustomobject]@{
                id     = $id
                siteId = $id
                status = 'planned'
                before = @{ id = $id; state = 'deleted' }
                after  = @{ id = $id; state = if ($Action -eq 'restore') { 'active' } else { 'purged' } }
                error  = $null
            }
        }
        return [pscustomobject]@{
            action  = $Action
            mode    = 'plan'
            results = @($planned)
            summary = [pscustomobject]@{
                total     = $ids.Count
                succeeded = 0
                failed    = 0
            }
        }
    }

    $results = [System.Collections.Generic.List[object]]::new()
    $audits = [System.Collections.Generic.List[object]]::new()
    $operations = [System.Collections.Generic.List[object]]::new()
    $succeeded = 0
    $failed = 0

    foreach ($id in $ids) {
        $before = @{ id = $id; state = 'deleted' }
        try {
            if ($Action -eq 'restore') {
                $null = Invoke-MgGraphRequest -Method POST -Uri ('/v1.0/directory/deletedItems/{0}/restore' -f $id)
                $after = @{ id = $id; state = 'active' }
                $rowState = 'restored'
            }
            else {
                $null = Invoke-MgGraphRequest -Method DELETE -Uri ('/v1.0/directory/deletedItems/{0}' -f $id)
                $after = @{ id = $id; state = 'purged' }
                $rowState = 'emptied'
            }
            $succeeded++
            $appliedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
            $results.Add([pscustomobject]@{
                    id     = $id
                    siteId = $id
                    status = $rowState
                    before = $before
                    after  = $after
                    error  = $null
                }) | Out-Null
            $audit = @{
                id            = [guid]::NewGuid().ToString()
                tenantId      = $TenantId
                action        = $auditAction
                targetId      = $id
                targetName    = $id
                timestamp     = $appliedAt
                result        = 'success'
                before        = $before
                after         = $after
                error         = $null
                actor         = $Actor
                correlationId = $CorrelationId
            }
            & $WriteAudit $audit
            $audits.Add($audit) | Out-Null
            $operations.Add(@{
                    id        = [guid]::NewGuid().ToString()
                    tenantId  = $TenantId
                    siteId    = $id
                    operation = $operationName
                    state     = 'succeeded'
                    by        = $Actor
                    at        = $appliedAt
                    result    = $rowState
                }) | Out-Null
        }
        catch {
            $failed++
            $failedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
            $message = $_.Exception.Message
            $results.Add([pscustomobject]@{
                    id     = $id
                    siteId = $id
                    status = 'failed'
                    before = $before
                    after  = $null
                    error  = $message
                }) | Out-Null
            $audit = @{
                id            = [guid]::NewGuid().ToString()
                tenantId      = $TenantId
                action        = $auditAction
                targetId      = $id
                targetName    = $id
                timestamp     = $failedAt
                result        = 'failure'
                before        = $before
                after         = $null
                error         = $message
                actor         = $Actor
                correlationId = $CorrelationId
            }
            & $WriteAudit $audit
            $audits.Add($audit) | Out-Null
            $operations.Add(@{
                    id        = [guid]::NewGuid().ToString()
                    tenantId  = $TenantId
                    siteId    = $id
                    operation = $operationName
                    state     = 'failed'
                    by        = $Actor
                    at        = $failedAt
                    result    = $message
                }) | Out-Null
        }
    }

    return [pscustomobject]@{
        action       = $Action
        mode         = 'apply'
        results      = $results.ToArray()
        auditEvents  = $audits.ToArray()
        siteOperations = $operations.ToArray()
        summary      = [pscustomobject]@{
            total     = $ids.Count
            succeeded = $succeeded
            failed    = $failed
        }
    }
}

function Invoke-SharePointSiteAction {
    <#
    .SYNOPSIS
        Dispatches one SharePoint site lifecycle action to its handler.
    .DESCRIPTION
        Maps the action name used by the job envelope and entrypoint onto the
        delete, restore, recycle-bin list, and recycle-bin restore/empty
        handlers so the entrypoint stays thin.
    .PARAMETER TenantId
        Tenant the action targets.
    .PARAMETER Action
        delete | restore | recyclebin-list | recyclebin-restore | recyclebin-empty.
    .PARAMETER SiteId
        Site identity for delete/restore.
    .PARAMETER RecycleBinIds
        Recycle-bin identities for restore/empty.
    .PARAMETER DryRun
        Report the intended change without writing.
    .PARAMETER Confirmed
        Explicit confirmation for delete/empty apply.
    .PARAMETER Actor
        Caller identity recorded on the audit events.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit events.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-SharePointSiteAction -TenantId 'tenant-a' -Action 'delete' -SiteId 'site-1' -Confirmed
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('delete', 'restore', 'recyclebin-list', 'recyclebin-restore', 'recyclebin-empty')]
        [string]$Action,

        [Parameter()]
        [string]$SiteId = '',

        [Parameter()]
        [AllowEmptyCollection()]
        [string[]]$RecycleBinIds = @(),

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    switch ($Action) {
        'delete' {
            return Invoke-SharePointSiteDelete -TenantId $TenantId -SiteId $SiteId -DryRun $DryRun -Confirmed $Confirmed -Actor $Actor -CorrelationId $CorrelationId -WriteAudit $WriteAudit
        }
        'restore' {
            return Invoke-SharePointSiteRestore -TenantId $TenantId -SiteId $SiteId -DryRun $DryRun -Confirmed $Confirmed -Actor $Actor -CorrelationId $CorrelationId -WriteAudit $WriteAudit
        }
        'recyclebin-list' {
            return Get-SharePointRecycleBin -TenantId $TenantId
        }
        'recyclebin-restore' {
            return Invoke-SharePointRecycleBinAction -TenantId $TenantId -Action 'restore' -RecycleBinIds $RecycleBinIds -DryRun $DryRun -Confirmed $Confirmed -Actor $Actor -CorrelationId $CorrelationId -WriteAudit $WriteAudit
        }
        'recyclebin-empty' {
            return Invoke-SharePointRecycleBinAction -TenantId $TenantId -Action 'empty' -RecycleBinIds $RecycleBinIds -DryRun $DryRun -Confirmed $Confirmed -Actor $Actor -CorrelationId $CorrelationId -WriteAudit $WriteAudit
        }
        default {
            throw "sharepoint.unknown_action: '$Action'"
        }
    }
}

function Read-SharePointSiteActionJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-SharePointSiteAction parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        action, target, confirmation, and dry-run flag. The envelope carries
        references and planned values only; secrets are never present here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-SharePointSiteActionJob -Path './run/site-action-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "SharePoint site action job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "SharePoint site action job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'SharePoint site action job is missing required field: tenantId'
    }
    $action = [string]$job['action']
    if ($script:SharePointSiteActions -notcontains $action) {
        throw "SharePoint site action job has unsupported action: '$action'"
    }
    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $ids = @()
    if ($null -ne $payload['recycleBinIds']) {
        $ids = @($payload['recycleBinIds'] | ForEach-Object { [string]$_ })
    }

    return @{
        TenantId      = $tenantId
        Action        = $action
        SiteId        = if ($payload['siteId']) { [string]$payload['siteId'] } else { '' }
        RecycleBinIds = $ids
        Confirmed     = ($payload['confirm'] -eq $true)
        DryRun        = ($payload['dryRun'] -eq $true)
        Actor         = if ($job['actor']) { [string]$job['actor'] } else { '' }
        CorrelationId = if ($job['correlationId']) { [string]$job['correlationId'] } else { '' }
    }
}
