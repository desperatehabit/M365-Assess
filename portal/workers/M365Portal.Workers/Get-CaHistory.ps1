# Get-CaHistory.ps1 — EPIC-015 Conditional Access change-history worker (SPEC §4.4, §11.4; T-0830).
#
# Reads Graph directoryAudits filtered to the Conditional Access policy activities
# (add, update, delete policy) so changes made outside the portal — in the Entra
# admin center, by other tools, or by Microsoft — appear in CA change history.
# The BFF merges these with the portal's own before/after audit_events rows.
# Read-only: only Graph GET requests are issued; results are returned on stdout.

$script:CaPolicyAuditActivities = @(
    'Add conditional access policy'
    'Update conditional access policy'
    'Delete conditional access policy'
)

function Read-CaHistoryJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-CaHistory.
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

    return @{
        TenantId = [string]$json.tenantId
        PolicyId = if ($json.policyId) { [string]$json.policyId } else { '' }
        Top      = if ($json.top) { [int]$json.top } else { 0 }
    }
}

function Get-CaHistoryPropertyValue {
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
        [Parameter()]
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

function ConvertTo-CaHistoryAction {
    <#
    .SYNOPSIS
        Maps a directory-audit activity onto the portal's ca.policy.* action vocabulary.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string]$Activity
    )

    switch ($Activity) {
        'Add conditional access policy' { return 'ca.policy.create' }
        'Update conditional access policy' { return 'ca.policy.update' }
        'Delete conditional access policy' { return 'ca.policy.delete' }
        default { return $Activity }
    }
}

function ConvertTo-CaHistoryRecord {
    <#
    .SYNOPSIS
        Normalises a Graph directoryAudits entry onto a CaPolicyChangeRecord.
    .DESCRIPTION
        policyId/policyName come from the first target resource carrying an id,
        timestamp from activityDateTime, initiatedBy from the initiating user
        (falling back to the app display name, then 'System'), and action from
        the activity. before/after stay null: directory audits carry no
        portal-style before/after; the raw audit is kept on rawAudit.
    .PARAMETER Entry
        Graph directoryAudits entry.
    .PARAMETER TenantId
        Tenant the query ran against.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Entry,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId
    )

    $activity = [string](Get-CaHistoryPropertyValue -Item $Entry -Name 'activityDisplayName')
    $timestamp = [string](Get-CaHistoryPropertyValue -Item $Entry -Name 'activityDateTime')

    $initiatedBy = ''
    $initiator = Get-CaHistoryPropertyValue -Item $Entry -Name 'initiatedBy'
    $initiatedUser = Get-CaHistoryPropertyValue -Item $initiator -Name 'user'
    $userPrincipal = Get-CaHistoryPropertyValue -Item $initiatedUser -Name 'userPrincipalName'
    if (-not [string]::IsNullOrWhiteSpace($userPrincipal)) {
        $initiatedBy = [string]$userPrincipal
    }
    else {
        $initiatedApp = Get-CaHistoryPropertyValue -Item $initiator -Name 'app'
        $appName = Get-CaHistoryPropertyValue -Item $initiatedApp -Name 'displayName'
        if (-not [string]::IsNullOrWhiteSpace([string]$appName)) {
            $initiatedBy = [string]$appName
        }
    }
    if ($initiatedBy.Length -eq 0) {
        $initiatedBy = 'System'
    }

    $policyId = ''
    $policyName = ''
    $targets = @(Get-CaHistoryPropertyValue -Item $Entry -Name 'targetResources')
    foreach ($resource in $targets) {
        if ($null -eq $resource) {
            continue
        }
        $resourceId = Get-CaHistoryPropertyValue -Item $resource -Name 'id'
        if ([string]::IsNullOrWhiteSpace([string]$resourceId)) {
            continue
        }
        $policyId = [string]$resourceId
        $resourceName = Get-CaHistoryPropertyValue -Item $resource -Name 'displayName'
        $policyName = if (-not [string]::IsNullOrWhiteSpace([string]$resourceName)) { [string]$resourceName } else { $policyId }
        break
    }

    $entryId = [string](Get-CaHistoryPropertyValue -Item $Entry -Name 'id')
    if ($entryId.Length -eq 0) {
        $entryId = "$timestamp|$policyId"
    }

    $category = Get-CaHistoryPropertyValue -Item $Entry -Name 'category'
    $result = Get-CaHistoryPropertyValue -Item $Entry -Name 'result'

    return [pscustomobject]@{
        id          = $entryId
        tenantId    = $TenantId
        policyId    = $policyId
        policyName  = $policyName
        timestamp   = $timestamp
        initiatedBy = $initiatedBy
        action      = ConvertTo-CaHistoryAction -Activity $activity
        source      = 'directoryAudit'
        before      = $null
        after       = $null
        rawAudit    = [pscustomobject]@{
            activity        = $activity
            category        = if ($null -ne $category) { [string]$category } else { '' }
            result          = if ($null -ne $result) { [string]$result } else { '' }
            targetResources = @($targets)
        }
    }
}

function Get-CaHistory {
    <#
    .SYNOPSIS
        Lists Graph directoryAudits for Conditional Access policy changes (SPEC §4.4).
    .DESCRIPTION
        The CA policy activities are pushed to Graph as a directoryAudits
        $filter; entries are normalised onto the CaPolicyChangeRecord shape
        with source 'directoryAudit', sorted newest-first, and capped at Top.
        When PolicyId is given, entries are narrowed to that policy. Read-only:
        only Graph GET requests are issued, and results are returned on stdout.
    .PARAMETER TenantId
        Tenant the query runs against.
    .PARAMETER PolicyId
        Optional policy id to scope the history to one policy.
    .PARAMETER Top
        Maximum entries to return.
    .EXAMPLE
        Get-CaHistory -TenantId 'tenant-a' -PolicyId 'pol-1' -Top 50
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$PolicyId = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100
    )

    $activityFilter = ($script:CaPolicyAuditActivities | ForEach-Object { "activityDisplayName eq '$_'" }) -join ' or '
    $uri = '/v1.0/auditLogs/directoryAudits?$top=' + $Top + '&$filter=' + [uri]::EscapeDataString($activityFilter)

    $entries = [System.Collections.Generic.List[object]]::new()
    $pages = 0
    do {
        $pages++
        if ($pages -gt 100) {
            break
        }
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        $value = Get-CaHistoryPropertyValue -Item $response -Name 'value'
        if ($null -ne $value) {
            foreach ($entry in @($value)) {
                if ($null -ne $entry) {
                    $entries.Add($entry)
                }
            }
        }
        $next = Get-CaHistoryPropertyValue -Item $response -Name '@odata.nextLink'
        if ([string]::IsNullOrWhiteSpace([string]$next)) {
            break
        }
        $uri = [string]$next
    } while ($true)

    $records = foreach ($entry in $entries) {
        ConvertTo-CaHistoryRecord -Entry $entry -TenantId $TenantId
    }

    if (-not [string]::IsNullOrWhiteSpace($PolicyId)) {
        $records = @($records | Where-Object { $_.policyId -eq $PolicyId })
    }

    $sorted = @($records | Sort-Object -Property @{
        Expression = {
            $parsed = [datetime]::MinValue
            if (-not [datetime]::TryParse([string]$_.timestamp, [ref]$parsed)) {
                return [datetime]::MinValue
            }
            return $parsed.ToUniversalTime()
        }
    } -Descending | Select-Object -First $Top)

    return [pscustomobject]@{
        tenantId   = $TenantId
        totalCount = @($sorted).Count
        items      = @($sorted)
    }
}
