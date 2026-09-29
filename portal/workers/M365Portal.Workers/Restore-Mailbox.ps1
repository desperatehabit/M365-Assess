# Restore-Mailbox.ps1 — EPIC-020 soft-deleted mailbox view plus restore worker (SPEC §3 nav, §5, §11.4; T-0388).
#
# The list is a read-only projection over soft-deleted mailboxes: every call
# reads Get-EXOMailbox -SoftDeletedMailbox live and shapes the identity and
# deletion metadata needed to choose a restore. Restore is the single gated
# write here (Undo-SoftDeletedMailbox). Supports DryRun (plan preview mode
# returning diff without mutating).
#
# Gating (EPIC-006 contract, T-0107): restore is not a registry CheckId
# command, so it cannot travel the CheckId-bound executor path. It follows
# the same contract instead — the BFF confirms the plan before dispatch
# (dryRun plans only), -DryRun reports the intended change without writing,
# -Confirmed is re-checked here so a job that skips confirmation cannot apply,
# every apply captures before/after, and every apply emits one audit record.
# A mailbox not in the soft-deleted set is refused with a structured NotFound
# error the BFF maps to a 4xx; it is never restored blindly. The supervisor
# connects EXO in the child process after materializing the tenant credential
# in-process; this file never touches secrets.

function ConvertTo-DeletedMailboxRow {
    <#
    .SYNOPSIS
        Shapes one soft-deleted EXO mailbox into the restore-picker row.
    .DESCRIPTION
        Keeps the identity (id, display name, primary SMTP, recipient type)
        and the deletion metadata (deleted-at timestamp, days left before the
        30-day soft-delete retention purges the mailbox) the restore picker
        needs. Days-until-purge is null when EXO reports no deletion time.
    .PARAMETER Mailbox
        The Get-EXOMailbox -SoftDeletedMailbox record.
    .EXAMPLE
        ConvertTo-DeletedMailboxRow -Mailbox $mailbox
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Mailbox
    )

    $id = [string]$Mailbox.ExchangeObjectId
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Mailbox.Guid
    }
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Mailbox.PrimarySmtpAddress
    }

    $displayName = $null
    if (([string]$Mailbox.DisplayName).Trim().Length -gt 0) {
        $displayName = [string]$Mailbox.DisplayName
    }

    $deletedAt = $null
    $rawDeleted = $Mailbox.WhenSoftDeleted
    if ($null -eq $rawDeleted) {
        $rawDeleted = $Mailbox.WhenDeleted
    }
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
        id                   = $id
        displayName          = $displayName
        primarySmtpAddress   = [string]$Mailbox.PrimarySmtpAddress
        mailboxType          = [string]$Mailbox.RecipientTypeDetails
        deletedAt            = $deletedAt
        daysUntilPurge       = $daysUntilPurge
    }
}

function Get-DeletedMailboxState {
    <#
    .SYNOPSIS
        Reads one soft-deleted mailbox for the restore before snapshot.
    .DESCRIPTION
        Looks the identity up in the soft-deleted set only. A mailbox that is
        live (or unknown) returns null so the caller can refuse the restore
        with a structured error instead of restoring blindly.
    .PARAMETER MailboxId
        Mailbox identity (ExchangeObjectId, GUID, or primary SMTP).
    .EXAMPLE
        Get-DeletedMailboxState -MailboxId 'mbx-deleted-1'
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId
    )

    try {
        $found = Get-EXOMailbox -SoftDeletedMailbox -Identity $MailboxId -ErrorAction Stop
        if ($null -eq $found) {
            return $null
        }
        return ConvertTo-DeletedMailboxRow -Mailbox $found
    }
    catch {
        return $null
    }
}

function ConvertTo-DeletedMailboxesCursor {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-DeletedMailboxesCursor {
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
        Write-Verbose 'Ignoring undecodable deleted-mailboxes cursor and starting at the first page.'
    }
    return 0
}

function Get-DeletedMailboxes {
    <#
    .SYNOPSIS
        Lists soft-deleted mailboxes live from Exchange Online.
    .DESCRIPTION
        Pages Get-EXOMailbox -SoftDeletedMailbox once, shapes the
        restore-picker rows, applies the search filter, and returns one
        cursor page. Only Get- cmdlets are issued; nothing is written to the
        tenant and nothing is mirrored to disk.
    .PARAMETER TenantId
        Tenant the mailboxes belong to. Carried through to the result envelope.
    .PARAMETER Search
        Case-insensitive substring match against display name and primary SMTP.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-DeletedMailboxes -TenantId 'tenant-a' -Search 'departed' -Top 50
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

    $allMailboxes = @(Get-EXOMailbox -SoftDeletedMailbox -ResultSize Unlimited -Properties DisplayName, PrimarySmtpAddress, RecipientTypeDetails, WhenSoftDeleted, WhenDeleted, ExchangeGuid, ExchangeObjectId)

    $rows = [System.Collections.Generic.List[object]]::new()
    $needle = $Search.Trim().ToLowerInvariant()
    foreach ($mailbox in @($allMailboxes)) {
        if ($null -eq $mailbox) {
            continue
        }
        $row = ConvertTo-DeletedMailboxRow -Mailbox $mailbox
        if ($needle.Length -gt 0) {
            $haystack = ("{0} {1}" -f $row.displayName, $row.primarySmtpAddress).ToLowerInvariant()
            if (-not $haystack.Contains($needle)) {
                continue
            }
        }
        $rows.Add($row)
    }

    $ordered = @($rows)
    $offset = ConvertFrom-DeletedMailboxesCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-DeletedMailboxesCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Read-RestoreMailboxJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into restore-mailbox parameters.
    .DESCRIPTION
        Validates the envelope carries a tenant and an action, then returns
        the mailbox identity, search paging, confirmation, and dry-run flag.
        The envelope carries references and planned values only.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-RestoreMailboxJob -Path './run/restore-mailbox-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
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
    if (-not $json.action) {
        throw "job envelope '$Path' is missing mandatory 'action'"
    }

    return @{
        TenantId  = [string]$json.tenantId
        Action    = [string]$json.action
        MailboxId = if ($json.mailboxId) { [string]$json.mailboxId } else { '' }
        Search    = if ($json.search) { [string]$json.search } else { '' }
        Top       = if ($json.top) { [int]$json.top } else { 100 }
        Cursor    = if ($json.cursor) { [string]$json.cursor } else { '' }
        Confirmed = [bool]($json.confirmed -eq $true)
        DryRun    = [bool]($json.dryRun -eq $true)
    }
}

function Invoke-RestoreMailbox {
    <#
    .SYNOPSIS
        Previews or applies the restore of one soft-deleted mailbox.
    .DESCRIPTION
        -DryRun returns the plan with no EXO write. Without -DryRun,
        -Confirmed is required or the apply is refused. The mailbox is looked
        up in the soft-deleted set first for the before snapshot; a mailbox
        that is not soft-deleted throws a structured NotFound error the BFF
        maps to a 4xx. Every apply emits one auditEvent with before/after for
        the app audit sink and the MailboxOperation row.
    .PARAMETER TenantId
        Tenant the mailbox belongs to. Carried through to the result envelope.
    .PARAMETER MailboxId
        Soft-deleted mailbox identity (ExchangeObjectId, GUID, or primary SMTP).
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for apply; the BFF confirms the plan before dispatch.
    .EXAMPLE
        Invoke-RestoreMailbox -TenantId 'tenant-a' -MailboxId 'mbx-deleted-1' -Confirmed -DryRun
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId,

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false
    )

    $mailboxKey = $MailboxId.Trim()
    $deleted = Get-DeletedMailboxState -MailboxId $mailboxKey
    if ($null -eq $deleted) {
        throw "NotFound: Mailbox '$mailboxKey' is not in the soft-deleted set; restore is available only for a soft-deleted mailbox"
    }

    $targetName = [string]$deleted.displayName
    if ([string]::IsNullOrWhiteSpace($targetName)) {
        $targetName = $mailboxKey
    }

    $before = @{
        id                 = [string]$deleted.id
        displayName        = $targetName
        primarySmtpAddress = [string]$deleted.primarySmtpAddress
        mailboxType        = [string]$deleted.mailboxType
        state              = 'softDeleted'
    }
    $after = @{
        id                 = [string]$deleted.id
        displayName        = $targetName
        primarySmtpAddress = [string]$deleted.primarySmtpAddress
        mailboxType        = [string]$deleted.mailboxType
        state              = 'active'
    }
    $diff = @("Restore soft-deleted mailbox '$targetName' ($mailboxKey)")

    $plan = [pscustomobject]@{
        action               = 'restore'
        mailboxId            = $mailboxKey
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
        throw "mailbox.confirm_required: restore of '$mailboxKey' requires explicit confirmation"
    }

    $null = Undo-SoftDeletedMailbox -SoftDeletedMailbox $mailboxKey

    $refreshed = $null
    try {
        $refreshed = Get-EXOMailbox -Identity $mailboxKey -ErrorAction Stop
    }
    catch {
        $refreshed = $null
    }
    if ($null -ne $refreshed) {
        $after = @{
            id                 = [string]$before['id']
            displayName        = $targetName
            primarySmtpAddress = [string]$refreshed.PrimarySmtpAddress
            mailboxType        = [string]$refreshed.RecipientTypeDetails
            state              = 'active'
        }
        if ([string]::IsNullOrWhiteSpace([string]$after['primarySmtpAddress'])) {
            $after['primarySmtpAddress'] = [string]$before['primarySmtpAddress']
        }
        if ([string]::IsNullOrWhiteSpace([string]$after['mailboxType'])) {
            $after['mailboxType'] = [string]$before['mailboxType']
        }
    }

    $plan = [pscustomobject]@{
        action               = 'restore'
        mailboxId            = $mailboxKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = $diff
        valid                = $true
        dryRun               = $false
        requiresConfirmation = $false
    }

    return [pscustomobject]@{
        plan       = $plan
        result     = @{ id = $before['id']; displayName = $targetName; state = 'active' }
        auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = 'mailbox.restore'
            targetId   = $mailboxKey
            targetName = $targetName
            timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            before     = $before
            after      = $after
        }
        success    = $true
    }
}
