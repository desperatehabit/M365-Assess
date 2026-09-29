# Get-TransportRules.ps1 — EPIC-021 transport rules list read (SPEC §2 US-1, §3.1, §5, §6).
#
# Live EXO reads only: rules are read with Get-TransportRule on every call and
# shaped to the §3.1 columns (name, priority, state, conditions, actions,
# exceptions, last modified). Filtering and cursor paging happen over that
# single read. Only Get- cmdlets are issued; nothing is written to the tenant
# and nothing is persisted to disk. The caller (child entrypoint) runs with the
# EXO session the supervisor connected after materializing the tenant
# credential in-process; this file never touches secrets.

function ConvertTo-TransportRuleCondition {
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [object]$Rule,

        [Parameter(Mandatory)]
        [string[]]$PropertyNames
    )

    $summaries = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $PropertyNames) {
        $value = $Rule.$name
        if ($null -eq $value) {
            continue
        }
        $text = @($value | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_.Length -gt 0 }) -join ', '
        if ($text.Length -eq 0 -or $text -eq 'False') {
            continue
        }
        $summaries.Add("$name=$text")
    }
    return @($summaries)
}

function ConvertTo-TransportRuleRow {
    <#
    .SYNOPSIS
        Shapes one Get-TransportRule record into the §3.1 list row.
    .PARAMETER Rule
        The Get-TransportRule record.
    .EXAMPLE
        ConvertTo-TransportRuleRow -Rule $rule
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Rule
    )

    $id = [string]$Rule.Guid
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Rule.Identity
    }
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Rule.Name
    }

    $priority = $null
    $parsedPriority = 0
    if ([int]::TryParse([string]$Rule.Priority, [ref]$parsedPriority)) {
        $priority = $parsedPriority
    }

    $state = 'disabled'
    if ([string]$Rule.State -eq 'Enabled') {
        $state = 'enabled'
    }

    $lastModified = $null
    foreach ($field in @('WhenChangedUTC', 'WhenChanged')) {
        $raw = [string]$Rule.$field
        if ($raw.Trim().Length -gt 0) {
            $lastModified = $raw.Trim()
            break
        }
    }

    $conditionNames = @('From', 'FromMemberOf', 'FromScope', 'SentTo', 'SentToMemberOf', 'SentToScope', 'SubjectContainsWords', 'SubjectOrBodyContainsWords', 'HeaderContainsMessageHeader', 'HasAttachment', 'MessageSizeOver', 'AttachmentExtensionMatchesWords', 'RecipientDomainIs')
    $actionNames = @('AddToRecipients', 'BlindCopyTo', 'CopyTo', 'ModerateMessageByUser', 'RedirectMessageTo', 'RejectMessageReasonText', 'DeleteMessage', 'Quarantine', 'PrependSubject', 'SetHeaderName', 'ApplyHtmlDisclaimerText', 'ApplyHtmlDisclaimerFallbackAction', 'RouteMessageOutboundConnector')
    $exceptionNames = @('ExceptIfFrom', 'ExceptIfFromMemberOf', 'ExceptIfFromScope', 'ExceptIfSentTo', 'ExceptIfSentToMemberOf', 'ExceptIfSubjectContainsWords', 'ExceptIfSubjectOrBodyContainsWords', 'ExceptIfHasAttachment', 'ExceptIfRecipientDomainIs')

    return [pscustomobject]@{
        id           = $id
        name         = [string]$Rule.Name
        priority     = $priority
        state        = $state
        conditions   = @(ConvertTo-TransportRuleCondition -Rule $Rule -PropertyNames $conditionNames)
        actions      = @(ConvertTo-TransportRuleCondition -Rule $Rule -PropertyNames $actionNames)
        exceptions   = @(ConvertTo-TransportRuleCondition -Rule $Rule -PropertyNames $exceptionNames)
        lastModified = $lastModified
    }
}

function Test-TransportRuleFilter {
    <#
    .SYNOPSIS
        Applies the list filters to one shaped row.
    .PARAMETER Row
        The ConvertTo-TransportRuleRow result.
    .PARAMETER Search
        Case-insensitive substring match against the rule name.
    .PARAMETER State
        Keeps enabled, disabled, or all when empty.
    .EXAMPLE
        Test-TransportRuleFilter -Row $row -State 'enabled'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [string]$State = ''
    )

    if ($Search.Trim().Length -gt 0) {
        $needle = $Search.Trim().ToLowerInvariant()
        if (-not ([string]$Row.name).ToLowerInvariant().Contains($needle)) {
            return $false
        }
    }
    if ($State.Trim().Length -gt 0 -and [string]$Row.state -ne $State.Trim().ToLowerInvariant()) {
        return $false
    }
    return $true
}

function Get-TransportRules {
    <#
    .SYNOPSIS
        Lists tenant transport rules live from Exchange Online with §3.1 columns.
    .DESCRIPTION
        Reads Get-TransportRule once, shapes the §3.1 rows ordered by priority,
        applies the requested filters, and returns one cursor page. Only Get-
        cmdlets are issued; nothing is written to the tenant and nothing is
        persisted.
    .PARAMETER TenantId
        Tenant the rules belong to. Carried through to the result envelope.
    .PARAMETER Search
        Case-insensitive substring match against the rule name.
    .PARAMETER State
        Filter by rule state: enabled, disabled, or empty for all.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-TransportRules -TenantId 'tenant-a' -State 'enabled' -Top 50
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
        [ValidateSet('', 'enabled', 'disabled')]
        [string]$State = '',

        [Parameter()]
        [ValidateRange(1, 999)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $allRules = @(Get-TransportRule -ErrorAction Stop)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($rule in @($allRules)) {
        if ($null -eq $rule) {
            continue
        }
        $row = ConvertTo-TransportRuleRow -Rule $rule
        if (Test-TransportRuleFilter -Row $row -Search $Search -State $State) {
            $rows.Add($row)
        }
    }

    $ordered = @($rows | Sort-Object -Property @{ Expression = { $_.priority }; Ascending = $true }, @{ Expression = { $_.name }; Ascending = $true })
    $offset = ConvertFrom-TransportRulesCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-TransportRulesCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Read-TransportRulesJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Get-TransportRules parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then merges the
        optional payload filters with explicit overrides. The envelope carries
        references only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-TransportRulesJob -Path './run/transport-rules-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Transport rules job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Transport rules job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Transport rules job is missing required field: tenantId'
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

    return @{
        TenantId = $tenantId
        Search   = [string]$filters['search']
        State    = [string]$filters['state']
        Top      = Get-TransportRulesJobInt -Value $filters['top'] -Default 100
        Cursor   = [string]$filters['cursor']
    }
}

function Get-TransportRulesJobInt {
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter()]
        [object]$Value,

        [Parameter()]
        [int]$Default = 0
    )

    if ($null -eq $Value -or ([string]$Value).Trim().Length -eq 0) {
        return $Default
    }
    $parsed = 0
    if ([int]::TryParse([string]$Value, [ref]$parsed)) {
        return $parsed
    }
    return $Default
}

function ConvertTo-TransportRulesCursor {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-TransportRulesCursor {
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
        Write-Verbose 'Ignoring undecodable transport rules cursor and starting at the first page.'
    }
    return 0
}
