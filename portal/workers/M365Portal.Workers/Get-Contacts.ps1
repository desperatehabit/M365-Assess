# Get-Contacts.ps1 — EPIC-023 contacts list read (SPEC §3.1, §5, §6).
#
# Live EXO reads only: contacts are never mirrored, so every call reads
# Get-MailContact / Get-MailUser directly and shapes rows to the §3.1
# columns (display name, external address, type, hidden from GAL, last
# modified). Filtering and cursor paging happen over that single read.
# Only Get- cmdlets are issued; nothing is written to the tenant. The
# caller (child entrypoint) runs with the EXO session the supervisor
# connected after materializing the tenant credential in-process; this
# file never touches secrets.

function ConvertTo-ContactType {
    <#
    .SYNOPSIS
        Maps RecipientTypeDetails to the §3.1 contact type vocabulary.
    .PARAMETER RecipientTypeDetails
        The EXO RecipientTypeDetails value.
    .EXAMPLE
        ConvertTo-ContactType -RecipientTypeDetails 'MailContact'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$RecipientTypeDetails = ''
    )

    switch ($RecipientTypeDetails.Trim()) {
        'MailContact' { return 'mailContact' }
        'MailUser' { return 'mailUser' }
        default { return 'mailContact' }
    }
}

function ConvertTo-ContactRow {
    <#
    .SYNOPSIS
        Shapes one EXO contact into the §3.1 list row.
    .PARAMETER Contact
        The Get-MailContact or Get-MailUser record.
    .EXAMPLE
        ConvertTo-ContactRow -Contact $contact
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Contact
    )

    $id = [string]$Contact.ExchangeObjectId
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Contact.PrimarySmtpAddress
    }

    $displayName = $null
    if (([string]$Contact.DisplayName).Trim().Length -gt 0) {
        $displayName = [string]$Contact.DisplayName
    }

    $externalAddress = $null
    $rawExternal = [string]$Contact.ExternalEmailAddress
    if ($rawExternal.Trim().Length -gt 0) {
        $externalAddress = $rawExternal.Trim()
    }

    $lastModified = $null
    $rawModified = [string]$Contact.WhenChanged
    if ($rawModified.Trim().Length -gt 0) {
        $lastModified = $rawModified.Trim()
    }

    return [pscustomobject]@{
        id              = $id
        displayName     = $displayName
        externalAddress = $externalAddress
        type            = ConvertTo-ContactType -RecipientTypeDetails ([string]$Contact.RecipientTypeDetails)
        hiddenFromGal   = ($Contact.HiddenFromAddressListsEnabled -eq $true)
        lastModified    = $lastModified
    }
}

function Test-ContactFilter {
    <#
    .SYNOPSIS
        Applies the §3.1 list filters to one shaped row.
    .PARAMETER Row
        The ConvertTo-ContactRow result.
    .PARAMETER Search
        Case-insensitive substring match against display name and external address.
    .PARAMETER Type
        Keeps mailContact, mailUser, or all when empty.
    .PARAMETER Hidden
        'true' keeps hidden contacts, 'false' the rest, empty both.
    .EXAMPLE
        Test-ContactFilter -Row $row -Type 'mailContact'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [string]$Type = '',

        [Parameter()]
        [string]$Hidden = ''
    )

    if ($Search.Trim().Length -gt 0) {
        $needle = $Search.Trim().ToLowerInvariant()
        $haystack = ("{0} {1}" -f $Row.displayName, $Row.externalAddress).ToLowerInvariant()
        if (-not $haystack.Contains($needle)) {
            return $false
        }
    }
    if ($Type.Trim().Length -gt 0 -and $Row.type -ne $Type.Trim().ToLowerInvariant()) {
        return $false
    }
    if ($Hidden.Trim().Length -gt 0) {
        $want = $Hidden.Trim().ToLowerInvariant() -eq 'true'
        if ([bool]$Row.hiddenFromGal -ne $want) {
            return $false
        }
    }
    return $true
}

function Get-Contacts {
    <#
    .SYNOPSIS
        Lists tenant contacts live from Exchange Online with §3.1 columns.
    .DESCRIPTION
        Pages Get-MailContact and Get-MailUser once, shapes the §3.1 rows,
        applies the requested filters, and returns one cursor page. Only
        Get- cmdlets are issued; nothing is written to the tenant and
        nothing is mirrored to disk.
    .PARAMETER TenantId
        Tenant the contacts belong to. Carried through to the result envelope.
    .PARAMETER Search
        Case-insensitive substring match against display name and external address.
    .PARAMETER Type
        Filter by contact type: mailContact or mailUser.
    .PARAMETER Hidden
        'true' keeps hidden contacts, 'false' the rest, empty both.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-Contacts -TenantId 'tenant-a' -Type 'mailContact' -Top 50
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
        [ValidateSet('', 'mailContact', 'mailUser')]
        [string]$Type = '',

        [Parameter()]
        [ValidateSet('', 'true', 'false')]
        [string]$Hidden = '',

        [Parameter()]
        [ValidateRange(1, 999)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $allContacts = @()
    $allContacts += @(Get-MailContact -ResultSize Unlimited -Properties DisplayName, PrimarySmtpAddress, ExternalEmailAddress, RecipientTypeDetails, HiddenFromAddressListsEnabled, WhenChanged, ExchangeObjectId)
    $allContacts += @(Get-MailUser -ResultSize Unlimited -Properties DisplayName, PrimarySmtpAddress, ExternalEmailAddress, RecipientTypeDetails, HiddenFromAddressListsEnabled, WhenChanged, ExchangeObjectId)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($contact in @($allContacts)) {
        if ($null -eq $contact) {
            continue
        }
        $row = ConvertTo-ContactRow -Contact $contact
        if (Test-ContactFilter -Row $row -Search $Search -Type $Type -Hidden $Hidden) {
            $rows.Add($row)
        }
    }

    $ordered = @($rows)
    $offset = ConvertFrom-ContactsCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-ContactsCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Read-ContactsJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Get-Contacts parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then merges the
        optional payload filters with explicit overrides. The envelope carries
        references only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-ContactsJob -Path './run/contacts-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Contacts job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Contacts job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Contacts job is missing required field: tenantId'
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
        Type     = [string]$filters['type']
        Hidden    = [string]$filters['hidden']
        Top      = Get-ContactsJobInt -Value $filters['top'] -Default 100
        Cursor   = [string]$filters['cursor']
    }
}

function Get-ContactsJobInt {
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

function ConvertTo-ContactsCursor {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-ContactsCursor {
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
        Write-Verbose "Ignoring undecodable contacts cursor and starting at the first page."
    }
    return 0
}
