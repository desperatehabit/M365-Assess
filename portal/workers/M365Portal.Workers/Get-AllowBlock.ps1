# Get-AllowBlock.ps1 — EPIC-022 tenant allow/block list read (SPEC §2 US-5, §3.4, §5, §6, §11.3).
#
# Live EXO reads only: allow/block entries are never mirrored locally, so every
# call reads Get-TenantAllowBlockListItems for Sender, Url, and FileHash across
# Allow and Block switches, classifies Sender entries with '@' as 'sender' and
# without '@' as 'domain', applies optional filters, and returns the §3.4 rows.
# Only Get- cmdlets are issued; nothing is written to the tenant.

function Get-AllowBlockField {
    <#
    .SYNOPSIS
        Reads the first non-null property or dictionary key from a record.
    .PARAMETER Record
        Source object or dictionary.
    .PARAMETER Names
        Candidate field names in priority order.
    .EXAMPLE
        Get-AllowBlockField -Record $item -Names @('ExpirationDate', 'ExpiresOn')
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

function ConvertTo-AllowBlockType {
    <#
    .SYNOPSIS
        Normalizes an allow/block entry type to the §3.4 vocabulary.
    .DESCRIPTION
        Accepts sender/senders/address/email -> sender, domain/domains -> domain,
        url/urls -> url, and file/filehash/file-hash/hash -> file. Throws on unknown.
    .PARAMETER Type
        Raw allow/block entry type.
    .EXAMPLE
        ConvertTo-AllowBlockType -Type 'file-hash'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Type
    )

    $normalized = $Type.Trim().ToLowerInvariant() -replace '[\s_-]', ''
    switch ($normalized) {
        'sender' { return 'sender' }
        'senders' { return 'sender' }
        'address' { return 'sender' }
        'email' { return 'sender' }
        'domain' { return 'domain' }
        'domains' { return 'domain' }
        'url' { return 'url' }
        'urls' { return 'url' }
        'file' { return 'file' }
        'filehash' { return 'file' }
        'hash' { return 'file' }
        default { throw "Unknown allow/block type: $Type. Expected one of: sender, domain, url, file." }
    }
}

function ConvertTo-AllowBlockAction {
    <#
    .SYNOPSIS
        Normalizes an allow/block entry action to 'allow' or 'block'.
    .PARAMETER EntryAction
        Raw entry action value.
    .EXAMPLE
        ConvertTo-AllowBlockAction -EntryAction 'Block'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [Alias('Action')]
        [string]$EntryAction
    )

    $normalized = $EntryAction.Trim().ToLowerInvariant()
    switch ($normalized) {
        'allow' { return 'allow' }
        'block' { return 'block' }
        default { throw "Unknown allow/block action: $EntryAction. Expected one of: allow, block." }
    }
}

function ConvertTo-ExoAllowBlockListType {
    <#
    .SYNOPSIS
        Maps a §3.4 allow/block type to the Exchange Online ListType parameter.
    .PARAMETER Type
        Normalized §3.4 type: sender, domain, url, or file.
    .EXAMPLE
        ConvertTo-ExoAllowBlockListType -Type 'domain'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('sender', 'domain', 'url', 'file')]
        [string]$Type
    )

    switch ($Type) {
        'sender' { return 'Sender' }
        'domain' { return 'Sender' }
        'url' { return 'Url' }
        'file' { return 'FileHash' }
    }
}

function ConvertTo-AllowBlockRow {
    <#
    .SYNOPSIS
        Shapes one Get-TenantAllowBlockListItems record into an AllowBlockEntry.
    .DESCRIPTION
        Classifies Sender list items containing '@' as 'sender' and others as
        'domain', formats expiration timestamps to UTC ISO-8601 when present,
        and defaults notes to an empty string.
    .PARAMETER Item
        The record from Get-TenantAllowBlockListItems.
    .PARAMETER ListType
        The EXO list type queried: Sender, Url, or FileHash.
    .PARAMETER EntryAction
        The entry action queried: allow or block.
    .EXAMPLE
        ConvertTo-AllowBlockRow -Item $item -ListType 'Sender' -EntryAction 'block'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Item,

        [Parameter(Mandatory)]
        [ValidateSet('Sender', 'Url', 'FileHash')]
        [string]$ListType,

        [Parameter(Mandatory)]
        [ValidateSet('allow', 'block')]
        [string]$EntryAction
    )

    $valueRaw = Get-AllowBlockField -Record $Item -Names @('Value', 'Entry', 'value')
    $value = if ($null -ne $valueRaw) { ([string]$valueRaw).Trim() } else { '' }

    $resolvedType = switch ($ListType) {
        'Sender' {
            if ($value.Contains('@')) { 'sender' } else { 'domain' }
        }
        'Url' { 'url' }
        'FileHash' { 'file' }
    }

    $expiresRaw = Get-AllowBlockField -Record $Item -Names @('ExpirationDate', 'ExpiresOn', 'expiresOn')
    $expiresOn = $null
    if ($null -ne $expiresRaw) {
        if ($expiresRaw -is [datetime]) {
            $expiresOn = ([datetime]$expiresRaw).ToUniversalTime().ToString('o')
        }
        elseif ($expiresRaw -is [datetimeoffset]) {
            $expiresOn = ([datetimeoffset]$expiresRaw).UtcDateTime.ToString('o')
        }
        else {
            $expText = [string]$expiresRaw
            if (-not [string]::IsNullOrWhiteSpace($expText)) {
                $parsedExp = [datetimeoffset]::MinValue
                $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
                if ([datetimeoffset]::TryParse($expText.Trim(), [System.Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsedExp)) {
                    $expiresOn = $parsedExp.UtcDateTime.ToString('o')
                }
                else {
                    $expiresOn = $expText.Trim()
                }
            }
        }
    }

    $notesRaw = Get-AllowBlockField -Record $Item -Names @('Notes', 'notes')
    $notes = if ($null -ne $notesRaw) { [string]$notesRaw } else { '' }

    return [pscustomobject]@{
        type      = $resolvedType
        value     = $value
        action    = $EntryAction
        expiresOn = $expiresOn
        notes     = $notes
    }
}

function Get-AllowBlock {
    <#
    .SYNOPSIS
        Lists tenant allow/block list entries live from Exchange Online.
    .DESCRIPTION
        Queries Get-TenantAllowBlockListItems across Sender, Url, and FileHash
        with Allow and Block switches, classifies Sender entries with '@' as
        'sender' and others as 'domain', applies optional Type, Action, and
        Value filters, and returns the §3.4 page shape.
    .PARAMETER TenantId
        Tenant identifier carried through to the result envelope.
    .PARAMETER Type
        Optional entry type filter: sender, domain, url, or file.
    .PARAMETER Action
        Optional entry action filter: allow or block.
    .PARAMETER Value
        Optional case-insensitive value filter.
    .EXAMPLE
        Get-AllowBlock -TenantId 'tenant-a' -Type 'domain'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$Type = '',

        [Parameter()]
        [string]$Action = '',

        [Parameter()]
        [string]$Value = ''
    )

    $normalizedType = ''
    $listTypes = @('Sender', 'Url', 'FileHash')
    if (-not [string]::IsNullOrWhiteSpace($Type)) {
        $normalizedType = ConvertTo-AllowBlockType -Type $Type
        $listTypes = @(ConvertTo-ExoAllowBlockListType -Type $normalizedType)
    }

    $actions = @('allow', 'block')
    if (-not [string]::IsNullOrWhiteSpace($Action)) {
        $normalizedAction = ConvertTo-AllowBlockAction -EntryAction $Action
        $actions = @($normalizedAction)
    }

    $rows = [System.Collections.Generic.List[object]]::new()
    $valueNeedle = $Value.Trim().ToLowerInvariant()

    foreach ($listType in $listTypes) {
        foreach ($entryAction in $actions) {
            $queryParams = @{
                ListType    = $listType
                ErrorAction = 'Stop'
            }
            if ($entryAction -eq 'allow') {
                $queryParams['Allow'] = $true
            }
            else {
                $queryParams['Block'] = $true
            }

            $rawItems = Get-TenantAllowBlockListItems @queryParams
            foreach ($item in @($rawItems)) {
                if ($null -eq $item) {
                    continue
                }
                $row = ConvertTo-AllowBlockRow -Item $item -ListType $listType -EntryAction $entryAction
                if (-not [string]::IsNullOrWhiteSpace($normalizedType) -and [string]$row.type -ne $normalizedType) {
                    continue
                }
                if ($valueNeedle.Length -gt 0 -and -not ([string]$row.value).ToLowerInvariant().Contains($valueNeedle)) {
                    continue
                }
                $rows.Add($row)
            }
        }
    }

    $ordered = @($rows | Sort-Object -Property type, action, value)
    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = @($ordered)
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Read-AllowBlockJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Get-AllowBlock parameters.
    .DESCRIPTION
        Validates schemaVersion v1 and tenantId, then extracts optional type,
        action, and value filters from the envelope payload.
    .PARAMETER Path
        Path to the job envelope JSON file.
    .EXAMPLE
        Read-AllowBlockJob -Path './run/allow-block-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Allow/block job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Allow/block job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Allow/block job is missing required field: tenantId'
    }

    $source = $job['payload']
    if ($source -isnot [System.Collections.IDictionary]) {
        $source = @{}
    }
    if ($source.Contains('filters') -and $source['filters'] -is [System.Collections.IDictionary]) {
        $source = $source['filters']
    }

    $rawType = if ($source.Contains('type') -and $null -ne $source['type']) { [string]$source['type'] } else { '' }
    $type = if ([string]::IsNullOrWhiteSpace($rawType)) { '' } else { ConvertTo-AllowBlockType -Type $rawType }

    $rawAction = ''
    if ($source.Contains('action') -and $null -ne $source['action']) {
        $rawAction = [string]$source['action']
    }
    elseif ($source.Contains('entryAction') -and $null -ne $source['entryAction']) {
        $rawAction = [string]$source['entryAction']
    }
    $action = if ([string]::IsNullOrWhiteSpace($rawAction)) { '' } else { ConvertTo-AllowBlockAction -EntryAction $rawAction }

    $value = if ($source.Contains('value') -and $null -ne $source['value']) { [string]$source['value'] } else { '' }

    return @{
        TenantId = $tenantId
        Type     = $type
        Action   = $action
        Value    = $value
    }
}
