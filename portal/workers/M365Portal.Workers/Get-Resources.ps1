# Get-Resources.ps1 — EPIC-023 resource mailbox read (SPEC §2 US-3, §3.3, §5, §6).
#
# Live EXO reads only: resource objects are never mirrored, so every call reads
# Get-EXOMailbox (rooms/equipment) or Get-DistributionGroup (room lists) directly
# and shapes rows to the §3.3 columns (name, capacity, location, type, hidden).
# Room lists are EXO distribution groups with RecipientTypeDetails 'RoomList'
# (SPEC §11 item 3: EXO room lists first; M365 groups are out of v1) and carry
# their membership from Get-DistributionGroupMember. Room location is read from
# CustomAttribute1, the conventional EXO attribute for room location. Filtering
# and cursor paging happen over that single read. Only Get- cmdlets are issued;
# nothing is written to the tenant. The caller (child entrypoint) runs with the
# EXO session the supervisor connected after materializing the tenant credential
# in-process; this file never touches secrets.

function ConvertTo-ResourceType {
    <#
    .SYNOPSIS
        Maps an EXO recipient type to the §3.3 resource type vocabulary.
    .PARAMETER RecipientTypeDetails
        The EXO RecipientTypeDetails value.
    .EXAMPLE
        ConvertTo-ResourceType -RecipientTypeDetails 'RoomMailbox'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$RecipientTypeDetails = ''
    )

    switch ($RecipientTypeDetails.Trim()) {
        'RoomMailbox' { return 'room' }
        'EquipmentMailbox' { return 'equipment' }
        'RoomList' { return 'roomlist' }
        default { return 'room' }
    }
}

function ConvertTo-ResourceRow {
    <#
    .SYNOPSIS
        Shapes one EXO mailbox or room-list group into the §3.3 list row.
    .DESCRIPTION
        Capacity is the EXO room/equipment capacity and is null when unset;
        location is CustomAttribute1 and null when empty; hidden is true when
        the object is hidden from address lists. Room lists carry their
        membership; rooms and equipment carry an empty member list.
    .PARAMETER Object
        The Get-EXOMailbox or Get-DistributionGroup record.
    .PARAMETER Members
        The Get-DistributionGroupMember records for a room list, or null.
    .EXAMPLE
        ConvertTo-ResourceRow -Object $room -Members $null
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Object,

        [Parameter()]
        [object]$Members
    )

    $id = [string]$Object.ExchangeObjectId
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Object.PrimarySmtpAddress
    }

    $capacity = $null
    $rawCapacity = $Object.Capacity
    if ($null -ne $rawCapacity -and ([string]$rawCapacity).Trim().Length -gt 0) {
        $parsedCapacity = 0
        if ([int]::TryParse([string]$rawCapacity, [ref]$parsedCapacity)) {
            $capacity = $parsedCapacity
        }
    }

    $location = $null
    $rawLocation = [string]$Object.CustomAttribute1
    if ($rawLocation.Trim().Length -gt 0) {
        $location = $rawLocation.Trim()
    }

    $name = $null
    if (([string]$Object.DisplayName).Trim().Length -gt 0) {
        $name = [string]$Object.DisplayName
    }

    $memberRows = [System.Collections.Generic.List[object]]::new()
    foreach ($member in @($Members)) {
        if ($null -eq $member) {
            continue
        }
        $memberName = $null
        if (([string]$member.DisplayName).Trim().Length -gt 0) {
            $memberName = [string]$member.DisplayName
        }
        $memberRows.Add([pscustomobject]@{
            name               = $memberName
            primarySmtpAddress = [string]$member.PrimarySmtpAddress
        })
    }

    return [pscustomobject]@{
        id                 = $id
        name               = $name
        primarySmtpAddress = [string]$Object.PrimarySmtpAddress
        capacity           = $capacity
        location           = $location
        type               = ConvertTo-ResourceType -RecipientTypeDetails ([string]$Object.RecipientTypeDetails)
        hidden             = ($Object.HiddenFromAddressListsEnabled -eq $true)
        members            = @($memberRows)
    }
}

function Get-ResourceMembersSafe {
    <#
    .SYNOPSIS
        Reads one room list's membership, surviving a failed member read.
    .DESCRIPTION
        A room list whose member read fails yields an empty member list so one
        unavailable slice cannot fail the list. Only Get- cmdlets are issued.
    .PARAMETER Identity
        The room list identity (ExchangeObjectId or primary SMTP address).
    .EXAMPLE
        Get-ResourceMembersSafe -Identity 'rl-1'
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Identity
    )

    try {
        return @(Get-DistributionGroupMember -Identity $Identity -ResultSize Unlimited -ErrorAction Stop)
    }
    catch {
        Write-Verbose "Room list membership unavailable for '$Identity': $($_.Exception.Message)"
        return @()
    }
}

function Test-ResourceFilter {
    <#
    .SYNOPSIS
        Applies the §3.3 list filters to one shaped row.
    .PARAMETER Row
        The ConvertTo-ResourceRow result.
    .PARAMETER Search
        Case-insensitive substring match against name and primary SMTP.
    .EXAMPLE
        Test-ResourceFilter -Row $row -Search 'board'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [Parameter()]
        [string]$Search = ''
    )

    if ($Search.Trim().Length -gt 0) {
        $needle = $Search.Trim().ToLowerInvariant()
        $haystack = ("{0} {1}" -f $Row.name, $Row.primarySmtpAddress).ToLowerInvariant()
        if (-not $haystack.Contains($needle)) {
            return $false
        }
    }
    return $true
}

function Get-Resources {
    <#
    .SYNOPSIS
        Lists tenant resource mailboxes live from Exchange Online with §3.3 columns.
    .DESCRIPTION
        Reads rooms, equipment, or room lists in one filtered cursor page. Rooms
        and equipment come from Get-EXOMailbox filtered by RecipientTypeDetails;
        room lists come from Get-DistributionGroup filtered to 'RoomList' groups
        (SPEC §11 item 3) and carry their membership. Only Get- cmdlets are
        issued; nothing is written to the tenant and nothing is mirrored to disk.
    .PARAMETER TenantId
        Tenant the resources belong to. Carried through to the result envelope.
    .PARAMETER Kind
        Resource kind: rooms, equipment, or roomlists.
    .PARAMETER Search
        Case-insensitive substring match against name and primary SMTP.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-Resources -TenantId 'tenant-a' -Kind 'rooms' -Top 50
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('rooms', 'equipment', 'roomlists')]
        [string]$Kind,

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [ValidateRange(1, 999)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $objects = [System.Collections.Generic.List[object]]::new()
    if ($Kind -eq 'roomlists') {
        $groups = @(Get-DistributionGroup -Filter "RecipientTypeDetails -eq 'RoomList'" -ResultSize Unlimited -Properties DisplayName, PrimarySmtpAddress, RecipientTypeDetails, HiddenFromAddressListsEnabled, ExchangeObjectId)
        foreach ($group in $groups) {
            if ($null -eq $group) {
                continue
            }
            $identity = [string]$group.ExchangeObjectId
            if ($identity.Trim().Length -eq 0) {
                $identity = [string]$group.PrimarySmtpAddress
            }
            $objects.Add([pscustomobject]@{
                Object  = $group
                Members = Get-ResourceMembersSafe -Identity $identity
            })
        }
    }
    else {
        $recipientType = if ($Kind -eq 'equipment') { 'EquipmentMailbox' } else { 'RoomMailbox' }
        $mailboxes = @(Get-EXOMailbox -Filter "RecipientTypeDetails -eq '$recipientType'" -ResultSize Unlimited -Properties DisplayName, PrimarySmtpAddress, RecipientTypeDetails, Capacity, CustomAttribute1, HiddenFromAddressListsEnabled, ExchangeObjectId)
        foreach ($mailbox in $mailboxes) {
            if ($null -eq $mailbox) {
                continue
            }
            $objects.Add([pscustomobject]@{
                Object  = $mailbox
                Members = $null
            })
        }
    }

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $objects) {
        $row = ConvertTo-ResourceRow -Object $entry.Object -Members $entry.Members
        if (Test-ResourceFilter -Row $row -Search $Search) {
            $rows.Add($row)
        }
    }

    $ordered = @($rows)
    $offset = ConvertFrom-ResourcesCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-ResourcesCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        kind        = $Kind
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Read-ResourcesJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Get-Resources parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then surfaces the
        optional payload filters. The envelope carries references only; secrets
        are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-ResourcesJob -Path './run/resources-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Resources job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Resources job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Resources job is missing required field: tenantId'
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
        Kind     = [string]$filters['kind']
        Search   = [string]$filters['search']
        Top      = Get-ResourcesJobInt -Value $filters['top'] -Default 100
        Cursor   = [string]$filters['cursor']
    }
}

function Get-ResourcesJobInt {
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

function ConvertTo-ResourcesCursor {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-ResourcesCursor {
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
        Write-Verbose "Ignoring undecodable resources cursor and starting at the first page."
    }
    return 0
}
