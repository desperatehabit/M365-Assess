# Get-Mailboxes.ps1 — EPIC-020 mailbox list and detail read (SPEC §3.1, §3.7, §5, §6).
#
# Live EXO reads only: mailbox objects are never mirrored, so every call reads
# Get-EXOMailbox / Get-EXOMailboxStatistics directly and shapes rows to the
# §3.1 columns (display name, primary SMTP, type, quota used, archive, hold,
# forwarding, last activity). Filtering and cursor paging happen over that
# single read. The detail read adds settings, permissions, calendar
# permissions, and inbox rules for the §3.1 off-canvas view. Only Get- cmdlets
# are issued; nothing is written to the tenant. The caller (child entrypoint)
# runs with the EXO session the supervisor connected after materializing the
# tenant credential in-process; this file never touches secrets.

function ConvertFrom-ExoByteSize {
    <#
    .SYNOPSIS
        Parses an EXO byte-quantified size into bytes.
    .DESCRIPTION
        EXO renders sizes as '1.2 GB (1,288,490,188 bytes)' while mocks and
        some properties yield plain numbers. The parenthesised byte count wins
        when present; an unparsable value returns null instead of throwing.
    .PARAMETER Value
        The size value to parse.
    .EXAMPLE
        ConvertFrom-ExoByteSize -Value '1.2 GB (1288490188 bytes)'
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return $null
    }
    $text = [string]$Value
    if ($text.Trim().Length -eq 0 -or $text.Trim() -eq 'Unlimited') {
        return $null
    }
    $match = [regex]::Match($text, '\(([\d,]+)\s*bytes\)')
    if ($match.Success) {
        return [long]($match.Groups[1].Value -replace ',', '')
    }
    $parsed = 0L
    if ([long]::TryParse($text.Trim(), [ref]$parsed)) {
        return $parsed
    }
    return $null
}

function ConvertTo-MailboxType {
    <#
    .SYNOPSIS
        Maps RecipientTypeDetails to the §3.1 mailbox type vocabulary.
    .PARAMETER RecipientTypeDetails
        The EXO RecipientTypeDetails value.
    .EXAMPLE
        ConvertTo-MailboxType -RecipientTypeDetails 'SharedMailbox'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$RecipientTypeDetails = ''
    )

    switch ($RecipientTypeDetails.Trim()) {
        'UserMailbox' { return 'user' }
        'SharedMailbox' { return 'shared' }
        'RoomMailbox' { return 'room' }
        'EquipmentMailbox' { return 'equipment' }
        default { return 'user' }
    }
}

function ConvertTo-MailboxRow {
    <#
    .SYNOPSIS
        Shapes one EXO mailbox plus its statistics into the §3.1 list row.
    .DESCRIPTION
        Hold is true when litigation hold is enabled or an in-place hold is
        present; forwarding is true when a forwarding address is set; archive
        is true unless ArchiveStatus is None. Quota percent is derived from
        used bytes over ProhibitSendQuota and is null when either is unknown.
    .PARAMETER Mailbox
        The Get-EXOMailbox record.
    .PARAMETER Statistics
        The Get-EXOMailboxStatistics record, or null when unavailable.
    .EXAMPLE
        ConvertTo-MailboxRow -Mailbox $mailbox -Statistics $stats
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Mailbox,

        [Parameter()]
        [object]$Statistics
    )

    $id = [string]$Mailbox.ExchangeObjectId
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Mailbox.PrimarySmtpAddress
    }

    $usedBytes = $null
    $usedDisplay = $null
    $lastActivity = $null
    if ($null -ne $Statistics) {
        $usedBytes = ConvertFrom-ExoByteSize -Value $Statistics.TotalItemSize
        $rawUsed = [string]$Statistics.TotalItemSize
        if ($rawUsed.Trim().Length -gt 0) {
            $usedDisplay = $rawUsed.Trim()
        }
        $rawLogon = [string]$Statistics.LastLogonTime
        if ($rawLogon.Trim().Length -gt 0) {
            $lastActivity = $rawLogon.Trim()
        }
    }

    $limitBytes = ConvertFrom-ExoByteSize -Value $Mailbox.ProhibitSendQuota
    $quotaPercent = $null
    if ($null -ne $usedBytes -and $null -ne $limitBytes -and $limitBytes -gt 0) {
        $quotaPercent = [System.Math]::Round(([double]$usedBytes / [double]$limitBytes) * 100, 1)
    }

    $hold = $false
    if ($Mailbox.LitigationHoldEnabled -eq $true -or @($Mailbox.InPlaceHolds).Count -gt 0) {
        $hold = $true
    }

    $forwardingTo = $null
    $rawForward = [string]$Mailbox.ForwardingSmtpAddress
    if ($rawForward.Trim().Length -eq 0) {
        $rawForward = [string]$Mailbox.ForwardingAddress
    }
    if ($rawForward.Trim().Length -gt 0) {
        $forwardingTo = $rawForward.Trim()
    }

    $archive = $false
    $archiveStatus = [string]$Mailbox.ArchiveStatus
    if ($archiveStatus.Trim().Length -gt 0 -and $archiveStatus.Trim() -ne 'None') {
        $archive = $true
    }

    $displayName = $null
    if (([string]$Mailbox.DisplayName).Trim().Length -gt 0) {
        $displayName = [string]$Mailbox.DisplayName
    }

    return [pscustomobject]@{
        id                          = $id
        displayName                 = $displayName
        primarySmtpAddress          = [string]$Mailbox.PrimarySmtpAddress
        type                        = ConvertTo-MailboxType -RecipientTypeDetails ([string]$Mailbox.RecipientTypeDetails)
        quotaUsed                   = $usedDisplay
        quotaUsedBytes              = $usedBytes
        quotaPercent                = $quotaPercent
        archive                     = $archive
        hold                        = $hold
        forwarding                  = ($null -ne $forwardingTo)
        forwardingTo                = $forwardingTo
        deliverToMailboxAndForward  = ($Mailbox.DeliverToMailboxAndForward -eq $true)
        lastActivity                = $lastActivity
    }
}

function Test-MailboxFilter {
    <#
    .SYNOPSIS
        Applies the §3.1 list filters to one shaped row.
    .PARAMETER Row
        The ConvertTo-MailboxRow result.
    .PARAMETER Search
        Case-insensitive substring match against display name and primary SMTP.
    .PARAMETER Type
        Keeps user, shared, room, equipment, or all when empty.
    .PARAMETER Hold
        'true' keeps held mailboxes, 'false' the rest, empty both.
    .PARAMETER Forwarding
        'true' keeps forwarded mailboxes, 'false' the rest, empty both.
    .PARAMETER Archive
        'true' keeps archive-enabled mailboxes, 'false' the rest, empty both.
    .PARAMETER QuotaPercent
        Keeps mailboxes at or above this quota percent. 0 disables.
    .PARAMETER InactiveDays
        Keeps mailboxes whose last activity is older than this many days, or
        never active. 0 disables.
    .EXAMPLE
        Test-MailboxFilter -Row $row -Type 'shared'
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
        [string]$Hold = '',

        [Parameter()]
        [string]$Forwarding = '',

        [Parameter()]
        [string]$Archive = '',

        [Parameter()]
        [int]$QuotaPercent = 0,

        [Parameter()]
        [int]$InactiveDays = 0
    )

    if ($Search.Trim().Length -gt 0) {
        $needle = $Search.Trim().ToLowerInvariant()
        $haystack = ("{0} {1}" -f $Row.displayName, $Row.primarySmtpAddress).ToLowerInvariant()
        if (-not $haystack.Contains($needle)) {
            return $false
        }
    }
    if ($Type.Trim().Length -gt 0 -and $Row.type -ne $Type.Trim().ToLowerInvariant()) {
        return $false
    }
    if ($Hold.Trim().Length -gt 0) {
        $want = $Hold.Trim().ToLowerInvariant() -eq 'true'
        if ([bool]$Row.hold -ne $want) {
            return $false
        }
    }
    if ($Forwarding.Trim().Length -gt 0) {
        $want = $Forwarding.Trim().ToLowerInvariant() -eq 'true'
        if ([bool]$Row.forwarding -ne $want) {
            return $false
        }
    }
    if ($Archive.Trim().Length -gt 0) {
        $want = $Archive.Trim().ToLowerInvariant() -eq 'true'
        if ([bool]$Row.archive -ne $want) {
            return $false
        }
    }
    if ($QuotaPercent -gt 0) {
        if ($null -eq $Row.quotaPercent -or [double]$Row.quotaPercent -lt [double]$QuotaPercent) {
            return $false
        }
    }
    if ($InactiveDays -gt 0) {
        $cutoff = (Get-Date).ToUniversalTime().AddDays(-$InactiveDays)
        if ($Row.lastActivity) {
            $seen = [datetime]$Row.lastActivity
            if ($seen.ToUniversalTime() -ge $cutoff) {
                return $false
            }
        }
    }
    return $true
}

function Get-MailboxStatisticsSafe {
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Identity
    )

    try {
        return Get-EXOMailboxStatistics -Identity $Identity -ErrorAction Stop
    }
    catch {
        Write-Verbose "Mailbox statistics unavailable for '$Identity': $($_.Exception.Message)"
        return $null
    }
}

function Get-Mailboxes {
    <#
    .SYNOPSIS
        Lists tenant mailboxes live from Exchange Online with §3.1 columns.
    .DESCRIPTION
        Pages Get-EXOMailbox once, pairs each mailbox with its statistics,
        shapes the §3.1 rows, applies the requested filters, and returns one
        cursor page. Only Get- cmdlets are issued; nothing is written to the
        tenant and nothing is mirrored to disk.
    .PARAMETER TenantId
        Tenant the mailboxes belong to. Carried through to the result envelope.
    .PARAMETER Search
        Case-insensitive substring match against display name and primary SMTP.
    .PARAMETER Type
        Filter by mailbox type: user, shared, room, or equipment.
    .PARAMETER Hold
        'true' keeps held mailboxes, 'false' the rest, empty both.
    .PARAMETER Forwarding
        'true' keeps forwarded mailboxes, 'false' the rest, empty both.
    .PARAMETER Archive
        'true' keeps archive-enabled mailboxes, 'false' the rest, empty both.
    .PARAMETER QuotaPercent
        Keeps mailboxes at or above this quota percent. 0 disables.
    .PARAMETER InactiveDays
        Keeps mailboxes inactive longer than this many days, or never active.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-Mailboxes -TenantId 'tenant-a' -Type 'shared' -Top 50
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
        [ValidateSet('', 'user', 'shared', 'room', 'equipment')]
        [string]$Type = '',

        [Parameter()]
        [ValidateSet('', 'true', 'false')]
        [string]$Hold = '',

        [Parameter()]
        [ValidateSet('', 'true', 'false')]
        [string]$Forwarding = '',

        [Parameter()]
        [ValidateSet('', 'true', 'false')]
        [string]$Archive = '',

        [Parameter()]
        [ValidateRange(0, 100)]
        [int]$QuotaPercent = 0,

        [Parameter()]
        [ValidateRange(0, 3650)]
        [int]$InactiveDays = 0,

        [Parameter()]
        [ValidateRange(1, 999)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $allMailboxes = @(Get-EXOMailbox -ResultSize Unlimited -Properties DisplayName, PrimarySmtpAddress, RecipientTypeDetails, LitigationHoldEnabled, InPlaceHolds, ArchiveStatus, ForwardingAddress, ForwardingSmtpAddress, DeliverToMailboxAndForward, ProhibitSendQuota, HiddenFromAddressListsEnabled, ExchangeObjectId)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($mailbox in @($allMailboxes)) {
        if ($null -eq $mailbox) {
            continue
        }
        $stats = Get-MailboxStatisticsSafe -Identity ([string]$mailbox.ExchangeObjectId)
        if ($null -eq $stats -and ([string]$mailbox.PrimarySmtpAddress).Trim().Length -gt 0) {
            $stats = Get-MailboxStatisticsSafe -Identity ([string]$mailbox.PrimarySmtpAddress)
        }
        $row = ConvertTo-MailboxRow -Mailbox $mailbox -Statistics $stats
        if (Test-MailboxFilter -Row $row -Search $Search -Type $Type -Hold $Hold -Forwarding $Forwarding -Archive $Archive -QuotaPercent $QuotaPercent -InactiveDays $InactiveDays) {
            $rows.Add($row)
        }
    }

    $ordered = @($rows)
    $offset = ConvertFrom-MailboxesCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-MailboxesCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Get-MailboxDetail {
    <#
    .SYNOPSIS
        Reads one mailbox's off-canvas detail live from Exchange Online.
    .DESCRIPTION
        Returns the mailbox settings (the §3.1 row plus hold, archive, quota,
        and GAL-visibility detail) with its permissions, calendar permissions,
        and inbox rules. Permission reads exclude system accounts; a failed
        calendar or rules read yields an empty list so one unavailable slice
        cannot fail the detail. Only Get- cmdlets are issued; nothing is
        written to the tenant.
    .PARAMETER TenantId
        Tenant the mailbox belongs to. Carried through to the result envelope.
    .PARAMETER MailboxId
        Mailbox identity (ExchangeObjectId, primary SMTP, or alias).
    .EXAMPLE
        Get-MailboxDetail -TenantId 'tenant-a' -MailboxId 'shared-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId
    )

    $mailbox = Get-EXOMailbox -Identity $MailboxId -Properties DisplayName, PrimarySmtpAddress, RecipientTypeDetails, LitigationHoldEnabled, InPlaceHolds, ArchiveStatus, ForwardingAddress, ForwardingSmtpAddress, DeliverToMailboxAndForward, ProhibitSendQuota, IssueWarningQuota, HiddenFromAddressListsEnabled, GrantSendOnBehalfTo, ExchangeObjectId -ErrorAction Stop
    $stats = Get-MailboxStatisticsSafe -Identity $MailboxId
    $settings = ConvertTo-MailboxRow -Mailbox $mailbox -Statistics $stats

    $permissions = [System.Collections.Generic.List[object]]::new()
    try {
        $fullAccess = Get-MailboxPermission -Identity $mailbox.PrimarySmtpAddress -ErrorAction Stop |
            Where-Object {
                $_.User -notlike 'NT AUTHORITY\*' -and
                $_.User -notlike 'S-1-5-*' -and
                $_.IsInherited -eq $false -and
                $_.AccessRights -contains 'FullAccess'
            }
        foreach ($perm in @($fullAccess)) {
            $permissions.Add([pscustomobject]@{
                permissionType = 'FullAccess'
                grantedTo      = [string]$perm.User
                accessRights   = @($perm.AccessRights)
                automap        = ($perm.AutoMapping -ne $false)
                inherited      = [bool]$perm.IsInherited
            })
        }
    }
    catch {
        Write-Verbose "FullAccess permissions unavailable for '$MailboxId': $($_.Exception.Message)"
    }
    try {
        $sendAs = Get-RecipientPermission -Identity $mailbox.PrimarySmtpAddress -ErrorAction Stop |
            Where-Object {
                $_.Trustee -notlike 'NT AUTHORITY\*' -and
                $_.Trustee -notlike 'S-1-5-*'
            }
        foreach ($perm in @($sendAs)) {
            $permissions.Add([pscustomobject]@{
                permissionType = 'SendAs'
                grantedTo      = [string]$perm.Trustee
                accessRights   = @('SendAs')
                automap        = $false
                inherited      = $false
            })
        }
    }
    catch {
        Write-Verbose "SendAs permissions unavailable for '$MailboxId': $($_.Exception.Message)"
    }
    foreach ($delegate in @($mailbox.GrantSendOnBehalfTo)) {
        if ([string]$delegate.Trim().Length -gt 0) {
            $permissions.Add([pscustomobject]@{
                permissionType = 'SendOnBehalf'
                grantedTo      = [string]$delegate
                accessRights   = @('SendOnBehalf')
                automap        = $false
                inherited      = $false
            })
        }
    }

    $calendarPermissions = [System.Collections.Generic.List[object]]::new()
    try {
        $calendar = Get-EXOMailboxFolderPermission -Identity "$($mailbox.PrimarySmtpAddress):\Calendar" -ErrorAction Stop
        foreach ($entry in @($calendar)) {
            $calendarPermissions.Add([pscustomobject]@{
                user         = [string]$entry.User
                accessRights = @($entry.AccessRights)
            })
        }
    }
    catch {
        Write-Verbose "Calendar permissions unavailable for '$MailboxId': $($_.Exception.Message)"
    }

    $rules = [System.Collections.Generic.List[object]]::new()
    try {
        $inboxRules = Get-InboxRule -Mailbox $MailboxId -ErrorAction Stop
        foreach ($rule in @($inboxRules)) {
            $rules.Add([pscustomobject]@{
                identity                = [string]$rule.Identity
                name                    = [string]$rule.Name
                enabled                 = ($rule.Enabled -eq $true)
                priority                = $rule.Priority
                forwardTo               = $rule.ForwardTo
                forwardAsAttachmentTo   = $rule.ForwardAsAttachmentTo
                redirectTo              = $rule.RedirectTo
                deleteMessage           = ($rule.DeleteMessage -eq $true)
            })
        }
    }
    catch {
        Write-Verbose "Inbox rules unavailable for '$MailboxId': $($_.Exception.Message)"
    }

    return [pscustomobject]@{
        tenantId            = $TenantId
        mailboxId           = $settings.id
        settings            = $settings
        permissions         = @($permissions)
        calendarPermissions = @($calendarPermissions)
        rules               = @($rules)
        retrievedAt         = (Get-Date -Format 'o')
    }
}

function Read-MailboxesJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Get-Mailboxes parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then merges the
        optional payload filters with explicit overrides. The envelope carries
        references only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-MailboxesJob -Path './run/mailboxes-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Mailboxes job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Mailboxes job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Mailboxes job is missing required field: tenantId'
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
        TenantId     = $tenantId
        MailboxId    = [string]$filters['mailboxId']
        Search       = [string]$filters['search']
        Type         = [string]$filters['type']
        Hold         = [string]$filters['hold']
        Forwarding   = [string]$filters['forwarding']
        Archive      = [string]$filters['archive']
        QuotaPercent = Get-MailboxesJobInt -Value $filters['quotaPercent']
        InactiveDays = Get-MailboxesJobInt -Value $filters['inactiveDays']
        Top          = Get-MailboxesJobInt -Value $filters['top'] -Default 100
        Cursor       = [string]$filters['cursor']
    }
}

function Get-MailboxesJobInt {
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

function ConvertTo-MailboxesCursor {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-MailboxesCursor {
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
        Write-Verbose "Ignoring undecodable mailboxes cursor and starting at the first page."
    }
    return 0
}
