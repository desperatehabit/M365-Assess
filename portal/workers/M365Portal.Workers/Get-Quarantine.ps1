# Get-Quarantine.ps1 — EPIC-022 quarantine list and detail read (SPEC §2 US-3, §3.3, §5, §6, §11.1).
#
# Live EXO reads only: quarantined items are never mirrored, so every call reads
# Get-QuarantineMessage directly and shapes rows to the §3.3 columns (received,
# subject, sender, recipient, reason, policy, expires, state, direction) across
# the Email, Files, and Teams tabs. Single-message mode (-MessageId) queries
# Get-QuarantineMessage -Identity and tries Preview-QuarantineMessage when
# available, falling back to Graph metadata-only preview state when unavailable.
# Only Get-/Preview- cmdlets are issued; nothing is written to the tenant.

function Get-QuarantineMessageField {
    <#
    .SYNOPSIS
        Reads the first non-null property or dictionary key from a record.
    .DESCRIPTION
        Supports both PSCustomObject records from Exchange Online and hashtable
        records used in unit tests without triggering strict-mode missing
        property errors.
    .PARAMETER Record
        The source object or dictionary.
    .PARAMETER Names
        Candidate property or key names in priority order.
    .EXAMPLE
        Get-QuarantineMessageField -Record $msg -Names @('Identity', 'MessageId')
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [object]$Record,

        [Parameter(Mandatory)]
        [string[]]$Names
    )

    foreach ($name in $Names) {
        if ($Record -is [System.Collections.IDictionary]) {
            if ($Record.Contains($name) -and $null -ne $Record[$name]) {
                return $Record[$name]
            }
        }
        else {
            $prop = $Record.PSObject.Properties[$name]
            if ($null -ne $prop -and $null -ne $prop.Value) {
                return $prop.Value
            }
        }
    }
    return $null
}

function ConvertTo-QuarantineTimestamp {
    <#
    .SYNOPSIS
        Normalizes a date/time field into an ISO-8601 UTC string or null.
    .PARAMETER Value
        Raw timestamp value from EXO or JSON.
    .PARAMETER AllowNull
        Return $null instead of empty string when Value is missing.
    .EXAMPLE
        ConvertTo-QuarantineTimestamp -Value $msg.Expires -AllowNull $true
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter()]
        [object]$Value,

        [Parameter()]
        [bool]$AllowNull = $false
    )

    if ($null -eq $Value) {
        if ($AllowNull) { return $null }
        return ''
    }
    if ($Value -is [datetime]) {
        return ([datetime]$Value).ToUniversalTime().ToString('o')
    }
    if ($Value -is [datetimeoffset]) {
        return ([datetimeoffset]$Value).ToUniversalTime().ToString('o')
    }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        if ($AllowNull) { return $null }
        return ''
    }
    return $text.Trim()
}

function ConvertTo-QuarantineTab {
    <#
    .SYNOPSIS
        Normalizes a quarantine tab name to the §3.3 vocabulary.
    .DESCRIPTION
        Maps email/messages to email, files to files, and
        teams/teamsmessages/teams-messages to teams; throws on unknown values.
    .PARAMETER Tab
        Raw tab name.
    .EXAMPLE
        ConvertTo-QuarantineTab -Tab 'teams-messages'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Tab
    )

    $normalized = $Tab.Trim().ToLowerInvariant() -replace '[-_\s]', ''
    switch ($normalized) {
        'email' { return 'email' }
        'messages' { return 'email' }
        'files' { return 'files' }
        'teams' { return 'teams' }
        'teamsmessages' { return 'teams' }
        default { throw "Unknown quarantine tab: $Tab. Expected one of: email, files, teams." }
    }
}

function Resolve-QuarantineMessageTab {
    <#
    .SYNOPSIS
        Infers the §3.3 tab (email, files, teams) from an EXO quarantine record.
    .PARAMETER Message
        The raw Get-QuarantineMessage record.
    .EXAMPLE
        Resolve-QuarantineMessageTab -Message $msg
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [object]$Message
    )

    $explicit = Get-QuarantineMessageField -Record $Message -Names @('Tab', 'tab')
    if ($null -ne $explicit -and -not [string]::IsNullOrWhiteSpace([string]$explicit)) {
        return ConvertTo-QuarantineTab -Tab ([string]$explicit)
    }

    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($field in @('EntityType', 'Source', 'MessageType', 'QuarantineTypes', 'Type')) {
        $val = Get-QuarantineMessageField -Record $Message -Names @($field)
        if ($null -ne $val) {
            if ($val -is [System.Collections.IEnumerable] -and $val -isnot [string]) {
                foreach ($entry in $val) {
                    if ($null -ne $entry) {
                        $candidates.Add([string]$entry)
                    }
                }
            }
            else {
                $candidates.Add([string]$val)
            }
        }
    }

    $combined = ($candidates -join ' ').Trim()
    if ($combined -match '(?i)\b(teams|teamsmessages?|microsoftteams)\b') {
        return 'teams'
    }
    if ($combined -match '(?i)\b(files?|spfile|sharepoint|onedrive)\b') {
        return 'files'
    }
    return 'email'
}

function ConvertTo-QuarantineRow {
    <#
    .SYNOPSIS
        Shapes one EXO quarantine message record into the §3.3 row contract.
    .PARAMETER Message
        The Get-QuarantineMessage record.
    .PARAMETER Tab
        Optional explicit tab override; inferred from the record when omitted.
    .EXAMPLE
        ConvertTo-QuarantineRow -Message $msg
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Message,

        [Parameter()]
        [string]$Tab = ''
    )

    $rawId = Get-QuarantineMessageField -Record $Message -Names @('Identity', 'MessageId', 'messageId', 'NetworkMessageId')
    $messageId = if ($null -ne $rawId) { [string]$rawId } else { '' }

    $resolvedTab = if (-not [string]::IsNullOrWhiteSpace($Tab)) {
        ConvertTo-QuarantineTab -Tab $Tab
    }
    else {
        Resolve-QuarantineMessageTab -Message $Message
    }

    $receivedRaw = Get-QuarantineMessageField -Record $Message -Names @('ReceivedTime', 'received', 'Received')
    $received = ConvertTo-QuarantineTimestamp -Value $receivedRaw -AllowNull $false

    $subjectRaw = Get-QuarantineMessageField -Record $Message -Names @('Subject', 'subject')
    $subject = if ($null -ne $subjectRaw) { [string]$subjectRaw } else { '' }

    $senderRaw = Get-QuarantineMessageField -Record $Message -Names @('SenderAddress', 'sender', 'Sender')
    $sender = if ($null -ne $senderRaw) { [string]$senderRaw } else { '' }

    $recipientRaw = Get-QuarantineMessageField -Record $Message -Names @('RecipientAddress', 'recipient', 'Recipient')
    $recipient = ''
    if ($null -ne $recipientRaw) {
        if ($recipientRaw -is [System.Collections.IEnumerable] -and $recipientRaw -isnot [string]) {
            $parts = [System.Collections.Generic.List[string]]::new()
            foreach ($entry in $recipientRaw) {
                $text = ([string]$entry).Trim()
                if ($text.Length -gt 0) {
                    $parts.Add($text)
                }
            }
            $recipient = $parts -join ', '
        }
        else {
            $recipient = [string]$recipientRaw
        }
    }

    $reasonRaw = Get-QuarantineMessageField -Record $Message -Names @('QuarantineTypes', 'Type', 'Reason', 'reason')
    $reason = ''
    if ($null -ne $reasonRaw) {
        if ($reasonRaw -is [System.Collections.IEnumerable] -and $reasonRaw -isnot [string]) {
            $reasonParts = [System.Collections.Generic.List[string]]::new()
            foreach ($entry in $reasonRaw) {
                $text = ([string]$entry).Trim()
                if ($text.Length -gt 0) {
                    $reasonParts.Add($text)
                }
            }
            $reason = $reasonParts -join ', '
        }
        else {
            $reason = [string]$reasonRaw
        }
    }

    $policyRaw = Get-QuarantineMessageField -Record $Message -Names @('PolicyName', 'Policy', 'policy')
    $policy = if ($null -ne $policyRaw) { [string]$policyRaw } else { '' }

    $expiresRaw = Get-QuarantineMessageField -Record $Message -Names @('Expires', 'ExpiresOn', 'expires')
    $expires = ConvertTo-QuarantineTimestamp -Value $expiresRaw -AllowNull $true

    $stateRaw = Get-QuarantineMessageField -Record $Message -Names @('ReleaseStatus', 'State', 'state')
    $state = if ($null -ne $stateRaw -and -not [string]::IsNullOrWhiteSpace([string]$stateRaw)) {
        ([string]$stateRaw).Trim()
    }
    else {
        'Quarantined'
    }

    $directionRaw = Get-QuarantineMessageField -Record $Message -Names @('Direction', 'direction')
    $direction = if ($null -ne $directionRaw) { [string]$directionRaw } else { '' }

    $policyTypeRaw = Get-QuarantineMessageField -Record $Message -Names @('PolicyType', 'policyType')
    $policyType = if ($null -ne $policyTypeRaw -and -not [string]::IsNullOrWhiteSpace([string]$policyTypeRaw)) {
        [string]$policyTypeRaw
    }
    else {
        $null
    }

    $sizeRaw = Get-QuarantineMessageField -Record $Message -Names @('Size', 'MessageSize', 'size')
    $size = $null
    if ($null -ne $sizeRaw) {
        $parsedSize = 0L
        if ([long]::TryParse([string]$sizeRaw, [ref]$parsedSize)) {
            $size = $parsedSize
        }
    }

    return [pscustomobject]@{
        messageId  = $messageId
        tab        = $resolvedTab
        received   = $received
        subject    = $subject
        sender     = $sender
        recipient  = $recipient
        reason     = $reason
        policy     = $policy
        expires    = $expires
        state      = $state
        direction  = $direction
        policyType = $policyType
        size       = $size
    }
}

function ConvertTo-QuarantineDateTime {
    <#
    .SYNOPSIS
        Parses an ISO-8601 date string into a UTC DateTimeOffset.
    .PARAMETER Value
        The date string to parse.
    .PARAMETER FieldName
        Field name for validation error messages.
    .EXAMPLE
        ConvertTo-QuarantineDateTime -Value '2026-09-01T00:00:00Z' -FieldName 'dateFrom'
    #>
    [CmdletBinding()]
    [OutputType([datetimeoffset])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Value,

        [Parameter(Mandatory)]
        [string]$FieldName
    )

    $parsed = [datetimeoffset]::MinValue
    $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
    if ([datetimeoffset]::TryParse($Value.Trim(), [System.Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
        return $parsed.ToUniversalTime()
    }
    throw "Invalid $FieldName timestamp: $Value"
}

function Test-QuarantineRowFilter {
    <#
    .SYNOPSIS
        Evaluates §3.3 list filters against one shaped quarantine row.
    .PARAMETER Row
        Shaped row from ConvertTo-QuarantineRow.
    .PARAMETER Tab
        Normalized target tab.
    .PARAMETER Reason
        Optional case-insensitive reason filter.
    .PARAMETER Direction
        Optional case-insensitive direction filter.
    .PARAMETER Recipient
        Optional case-insensitive recipient substring filter.
    .PARAMETER State
        Optional case-insensitive state filter.
    .PARAMETER DateFromUtc
        Optional inclusive lower bound on received timestamp.
    .PARAMETER DateToUtc
        Optional inclusive upper bound on received timestamp.
    .EXAMPLE
        Test-QuarantineRowFilter -Row $row -Tab 'email' -Reason 'Spam'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [Parameter(Mandatory)]
        [string]$Tab,

        [Parameter()]
        [string]$Reason = '',

        [Parameter()]
        [string]$Direction = '',

        [Parameter()]
        [string]$Recipient = '',

        [Parameter()]
        [string]$State = '',

        [Parameter()]
        [Nullable[datetimeoffset]]$DateFromUtc = $null,

        [Parameter()]
        [Nullable[datetimeoffset]]$DateToUtc = $null
    )

    if ([string]$Row.tab -ne $Tab) {
        return $false
    }
    if (-not [string]::IsNullOrWhiteSpace($Reason)) {
        $needle = $Reason.Trim().ToLowerInvariant()
        if (-not ([string]$Row.reason).ToLowerInvariant().Contains($needle)) {
            return $false
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($Direction)) {
        if (-not [string]::Equals(([string]$Row.direction).Trim(), $Direction.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($Recipient)) {
        $needle = $Recipient.Trim().ToLowerInvariant()
        if (-not ([string]$Row.recipient).ToLowerInvariant().Contains($needle)) {
            return $false
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($State)) {
        if (-not [string]::Equals(([string]$Row.state).Trim(), $State.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
    }
    if ($null -ne $DateFromUtc -or $null -ne $DateToUtc) {
        $receivedRaw = [string]$Row.received
        if ([string]::IsNullOrWhiteSpace($receivedRaw)) {
            return $false
        }
        $receivedDt = [datetimeoffset]::MinValue
        $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
        if (-not [datetimeoffset]::TryParse($receivedRaw, [System.Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$receivedDt)) {
            return $false
        }
        $receivedUtc = $receivedDt.ToUniversalTime()
        if ($null -ne $DateFromUtc -and $receivedUtc -lt $DateFromUtc.Value) {
            return $false
        }
        if ($null -ne $DateToUtc -and $receivedUtc -gt $DateToUtc.Value) {
            return $false
        }
    }
    return $true
}

function ConvertTo-QuarantineCursor {
    <#
    .SYNOPSIS
        Encodes an integer offset into an opaque base64url cursor.
    .PARAMETER Offset
        Zero-based row offset for the next page.
    .EXAMPLE
        ConvertTo-QuarantineCursor -Offset 50
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

function ConvertFrom-QuarantineCursor {
    <#
    .SYNOPSIS
        Decodes a base64url or integer cursor back into a non-negative offset.
    .PARAMETER Cursor
        Opaque cursor string from a previous page or empty for offset 0.
    .EXAMPLE
        ConvertFrom-QuarantineCursor -Cursor 'NTA'
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
    $trimmed = $Cursor.Trim()
    if ($trimmed -match '^\d+$') {
        $plainOffset = 0
        if ([int]::TryParse($trimmed, [ref]$plainOffset) -and $plainOffset -ge 0) {
            return $plainOffset
        }
        return 0
    }
    try {
        $text = $trimmed.Replace('-', '+').Replace('_', '/')
        $pad = (4 - ($text.Length % 4)) % 4
        $text += ('=' * $pad)
        $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text))
        $offset = 0
        if ([int]::TryParse($decoded, [ref]$offset) -and $offset -ge 0) {
            return $offset
        }
    }
    catch {
        Write-Verbose -Message 'Ignoring undecodable quarantine cursor and starting at the first page.'
    }
    return 0
}

function Get-Quarantine {
    <#
    .SYNOPSIS
        Lists quarantined messages or reads a single message preview live from EXO.
    .DESCRIPTION
        In single-message mode (-MessageId), calls Get-QuarantineMessage
        -Identity and attempts Preview-QuarantineMessage when available,
        falling back to Graph metadata preview when unavailable. Returns $null
        if no message matches. In list mode, filters by tab and §3.3 filters
        and returns an offset-paginated page.
    .PARAMETER TenantId
        Tenant identifier carried through to the result envelope.
    .PARAMETER MessageId
        Optional quarantined message identity for single-message detail mode.
    .PARAMETER Tab
        Target quarantine tab: email, files, or teams. Defaults to email.
    .PARAMETER Reason
        Optional quarantine reason filter.
    .PARAMETER Direction
        Optional message direction filter.
    .PARAMETER Recipient
        Optional recipient filter.
    .PARAMETER State
        Optional release-state filter.
    .PARAMETER DateFrom
        Optional inclusive start timestamp filter.
    .PARAMETER DateTo
        Optional inclusive end timestamp filter.
    .PARAMETER Cursor
        Optional pagination cursor.
    .PARAMETER Limit
        Page size for list mode. Defaults to 50.
    .EXAMPLE
        Get-Quarantine -TenantId 'tenant-a' -Tab 'email' -Limit 50
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$MessageId = '',

        [Parameter()]
        [string]$Tab = 'email',

        [Parameter()]
        [string]$Reason = '',

        [Parameter()]
        [string]$Direction = '',

        [Parameter()]
        [string]$Recipient = '',

        [Parameter()]
        [string]$State = '',

        [Parameter()]
        [string]$DateFrom = '',

        [Parameter()]
        [string]$DateTo = '',

        [Parameter()]
        [string]$Cursor = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Limit = 50
    )

    if (-not [string]::IsNullOrWhiteSpace($MessageId)) {
        $rawSingle = Get-QuarantineMessage -Identity $MessageId -ErrorAction Stop
        $matched = [System.Collections.Generic.List[object]]::new()
        foreach ($entry in @($rawSingle)) {
            if ($null -ne $entry) {
                $matched.Add($entry)
            }
        }
        if ($matched.Count -eq 0) {
            return $null
        }

        $row = ConvertTo-QuarantineRow -Message $matched[0]
        $preview = @{
            source    = 'graph'
            available = $false
            body      = $null
        }
        if (Get-Command -Name 'Preview-QuarantineMessage' -ErrorAction SilentlyContinue) {
            try {
                $exoPreview = Preview-QuarantineMessage -Identity $MessageId -ErrorAction Stop
                if ($null -ne $exoPreview) {
                    $bodyValue = if ($exoPreview -is [string]) {
                        $exoPreview
                    }
                    else {
                        Get-QuarantineMessageField -Record $exoPreview -Names @('Body', 'HtmlBody', 'TextBody', 'Preview', 'body')
                    }
                    $bodyText = if ($null -ne $bodyValue -and -not [string]::IsNullOrWhiteSpace([string]$bodyValue)) {
                        [string]$bodyValue
                    }
                    else {
                        $null
                    }
                    $preview = @{
                        source    = 'exo'
                        available = ($null -ne $bodyText)
                        body      = $bodyText
                    }
                }
            }
            catch {
                Write-Verbose -Message "Preview-QuarantineMessage failed for '$MessageId': $($_.Exception.Message)"
            }
        }

        return [pscustomobject]@{
            messageId  = $row.messageId
            tab        = $row.tab
            received   = $row.received
            subject    = $row.subject
            sender     = $row.sender
            recipient  = $row.recipient
            reason     = $row.reason
            policy     = $row.policy
            expires    = $row.expires
            state      = $row.state
            direction  = $row.direction
            policyType = $row.policyType
            size       = $row.size
            preview    = [pscustomobject]$preview
        }
    }

    $effectiveTab = if ([string]::IsNullOrWhiteSpace($Tab)) { 'email' } else { $Tab }
    $normalizedTab = ConvertTo-QuarantineTab -Tab $effectiveTab

    [Nullable[datetimeoffset]]$dateFromUtc = $null
    if (-not [string]::IsNullOrWhiteSpace($DateFrom)) {
        $dateFromUtc = ConvertTo-QuarantineDateTime -Value $DateFrom -FieldName 'dateFrom'
    }
    [Nullable[datetimeoffset]]$dateToUtc = $null
    if (-not [string]::IsNullOrWhiteSpace($DateTo)) {
        $dateToUtc = ConvertTo-QuarantineDateTime -Value $DateTo -FieldName 'dateTo'
    }

    $rawList = Get-QuarantineMessage -ErrorAction Stop
    $filtered = [System.Collections.Generic.List[object]]::new()
    foreach ($item in @($rawList)) {
        if ($null -eq $item) {
            continue
        }
        $row = ConvertTo-QuarantineRow -Message $item
        $filterParams = @{
            Row         = $row
            Tab         = $normalizedTab
            Reason      = $Reason
            Direction   = $Direction
            Recipient   = $Recipient
            State       = $State
            DateFromUtc = $dateFromUtc
            DateToUtc   = $dateToUtc
        }
        if (Test-QuarantineRowFilter @filterParams) {
            $filtered.Add($row)
        }
    }

    $ordered = @($filtered | Sort-Object -Property @{ Expression = { $_.received }; Descending = $true }, @{ Expression = { $_.messageId }; Ascending = $true })
    $offset = ConvertFrom-QuarantineCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Limit)
    $nextOffset = $offset + $page.Count
    $nextCursor = $null
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-QuarantineCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        tab         = $normalizedTab
        items       = @($page)
        totalCount  = $ordered.Count
        nextCursor  = $nextCursor
        retrievedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Get-QuarantineJobString {
    <#
    .SYNOPSIS
        Normalizes a job field to a string, preserving ISO UTC format for dates.
    .PARAMETER Source
        Dictionary containing the job payload.
    .PARAMETER Key
        Key name to read.
    .PARAMETER Default
        Fallback value when key is missing or null.
    .EXAMPLE
        Get-QuarantineJobString -Source $payload -Key 'tab' -Default 'email'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [System.Collections.IDictionary]$Source,

        [Parameter(Mandatory)]
        [string]$Key,

        [Parameter()]
        [string]$Default = ''
    )

    if (-not $Source.Contains($Key) -or $null -eq $Source[$Key]) {
        return $Default
    }
    $val = $Source[$Key]
    if ($val -is [datetime]) {
        return ([datetime]$val).ToUniversalTime().ToString('o')
    }
    if ($val -is [datetimeoffset]) {
        return ([datetimeoffset]$val).ToUniversalTime().ToString('o')
    }
    return [string]$val
}

function Read-QuarantineJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Get-Quarantine parameters.
    .DESCRIPTION
        Validates schemaVersion v1 and tenantId, then extracts single-message
        or list filter parameters from payload (or nested filters).
    .PARAMETER Path
        Path to the job envelope JSON file.
    .EXAMPLE
        Read-QuarantineJob -Path './run/quarantine-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Quarantine job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Quarantine job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Quarantine job is missing required field: tenantId'
    }

    $source = $job['payload']
    if ($source -isnot [System.Collections.IDictionary]) {
        $source = @{}
    }
    if ($source.Contains('filters') -and $source['filters'] -is [System.Collections.IDictionary]) {
        $source = $source['filters']
    }

    $rawTab = Get-QuarantineJobString -Source $source -Key 'tab' -Default ''
    $tab = if ([string]::IsNullOrWhiteSpace($rawTab)) {
        'email'
    }
    else {
        ConvertTo-QuarantineTab -Tab $rawTab
    }

    $limit = 50
    if ($source.Contains('limit') -and $null -ne $source['limit']) {
        $parsedLimit = 0
        if ([int]::TryParse([string]$source['limit'], [ref]$parsedLimit) -and $parsedLimit -ge 1 -and $parsedLimit -le 1000) {
            $limit = $parsedLimit
        }
    }

    return @{
        TenantId  = $tenantId
        MessageId = Get-QuarantineJobString -Source $source -Key 'messageId' -Default ''
        Tab       = $tab
        Reason    = Get-QuarantineJobString -Source $source -Key 'reason' -Default ''
        Direction = Get-QuarantineJobString -Source $source -Key 'direction' -Default ''
        Recipient = Get-QuarantineJobString -Source $source -Key 'recipient' -Default ''
        State     = Get-QuarantineJobString -Source $source -Key 'state' -Default ''
        DateFrom  = Get-QuarantineJobString -Source $source -Key 'dateFrom' -Default ''
        DateTo    = Get-QuarantineJobString -Source $source -Key 'dateTo' -Default ''
        Cursor    = Get-QuarantineJobString -Source $source -Key 'cursor' -Default ''
        Limit     = $limit
    }
}
