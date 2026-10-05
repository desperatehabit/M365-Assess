# Get-MailboxPermissions.ps1 — EPIC-027 mailbox/calendar permission report read
# (EPIC-027 SPEC.md §2 US-5, §3.5, §6; T-0529).
#
# Live EXO reads only: for every tenant mailbox it reads mailbox permissions
# (FullAccess via Get-MailboxPermission, SendAs via Get-RecipientPermission,
# SendOnBehalf via GrantSendOnBehalfTo) and calendar folder permissions
# (Get-EXOMailboxFolderPermission on \Calendar), flattens them into the §3.3
# report rows (principal, access rights, automap, inherited), and returns one
# cursor page. Only Get- cmdlets are issued; nothing is written to the tenant.
# The caller (child entrypoint) runs with the EXO session the supervisor
# connected after materializing the tenant credential in-process; this file
# never touches secrets.

function ConvertTo-MailboxPermissionsCursor {
    <#
    .SYNOPSIS
        Encodes a row offset into the opaque report cursor.
    .PARAMETER Offset
        Zero-based row offset into the filtered permission set.
    .EXAMPLE
        ConvertTo-MailboxPermissionsCursor -Offset 100
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

function ConvertFrom-MailboxPermissionsCursor {
    <#
    .SYNOPSIS
        Decodes the opaque report cursor back into a row offset.
    .DESCRIPTION
        An undecodable cursor restarts at the first page instead of failing
        the read; the report is read-only, so a bad cursor must not be fatal.
    .PARAMETER Cursor
        The cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        ConvertFrom-MailboxPermissionsCursor -Cursor 'MTAw'
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
        Write-Verbose "Ignoring undecodable mailbox-permissions cursor and starting at the first page."
    }
    return 0
}

function Get-MailboxPermissions {
    <#
    .SYNOPSIS
        Lists tenant mailbox and calendar permissions live from Exchange Online.
    .DESCRIPTION
        Pages Get-EXOMailbox once, reads each mailbox's FullAccess, SendAs,
        SendOnBehalf, and calendar folder permissions, shapes the §3.3 report
        rows, applies the optional scope and search filters, and returns one
        cursor page. Only Get- cmdlets are issued; nothing is written to the
        tenant and nothing is mirrored to disk.
    .PARAMETER TenantId
        Tenant the permissions belong to. Carried through to the result envelope.
    .PARAMETER Scope
        'mailbox' or 'calendar' restricts the report to one permission family;
        empty returns both.
    .PARAMETER MailboxId
        Restricts the read to one mailbox (ExchangeObjectId, primary SMTP, or
        alias). Empty reads every tenant mailbox. A mailbox that does not exist
        fails the read rather than returning an empty report.
    .PARAMETER Search
        Case-insensitive substring match against mailbox display name, primary
        SMTP, and principal.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-MailboxPermissions -TenantId 'tenant-a' -Scope 'calendar' -Top 50
    .EXAMPLE
        Get-MailboxPermissions -TenantId 'tenant-a' -MailboxId 'support@example.invalid'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [ValidateSet('', 'mailbox', 'calendar')]
        [string]$Scope = '',

        [Parameter()]
        [string]$MailboxId = '',

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [ValidateRange(1, 999)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $mailboxProperties = @('DisplayName', 'PrimarySmtpAddress', 'RecipientTypeDetails', 'GrantSendOnBehalfTo', 'ExchangeObjectId', 'Alias')
    $mailboxKey = $MailboxId.Trim()
    if ($mailboxKey.Length -gt 0) {
        # Per-mailbox read: look up only the requested mailbox so one mailbox's
        # permissions are never returned for another. The identity match below is
        # a second guard in case a lookup ever returns more than the one mailbox.
        $allMailboxes = @(Get-EXOMailbox -Identity $mailboxKey -Properties $mailboxProperties -ErrorAction Stop | Where-Object {
            [string]$_.ExchangeObjectId -eq $mailboxKey -or
            [string]$_.PrimarySmtpAddress -eq $mailboxKey -or
            [string]$_.Alias -eq $mailboxKey
        })
        if ($allMailboxes.Count -eq 0) {
            throw "NotFound: Mailbox '$mailboxKey' not found"
        }
    }
    else {
        $allMailboxes = @(Get-EXOMailbox -ResultSize Unlimited -Properties $mailboxProperties)
    }

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($mailbox in $allMailboxes) {
        if ($null -eq $mailbox) {
            continue
        }
        $mailboxId = [string]$mailbox.ExchangeObjectId
        if ($mailboxId.Trim().Length -eq 0) {
            $mailboxId = [string]$mailbox.PrimarySmtpAddress
        }
        $displayName = [string]$mailbox.DisplayName
        $primarySmtp = [string]$mailbox.PrimarySmtpAddress

        if ($Scope -eq '' -or $Scope -eq 'mailbox') {
            try {
                $fullAccess = Get-MailboxPermission -Identity $primarySmtp -ErrorAction Stop |
                    Where-Object {
                        $_.User -notlike 'NT AUTHORITY\*' -and
                        $_.User -notlike 'S-1-5-*' -and
                        $_.IsInherited -eq $false -and
                        $_.AccessRights -contains 'FullAccess'
                    }
                foreach ($perm in @($fullAccess)) {
                    $rows.Add([pscustomobject]@{
                        mailboxId            = $mailboxId
                        mailboxDisplayName   = $displayName
                        mailboxPrimarySmtp   = $primarySmtp
                        scope                = 'mailbox'
                        permissionType       = 'FullAccess'
                        principal            = [string]$perm.User
                        accessRights         = @($perm.AccessRights)
                        automap              = ($perm.AutoMapping -ne $false)
                        inherited             = [bool]$perm.IsInherited
                    })
                }
            }
            catch {
                Write-Verbose "FullAccess permissions unavailable for '$mailboxId': $($_.Exception.Message)"
            }
            try {
                $sendAs = Get-RecipientPermission -Identity $primarySmtp -ErrorAction Stop |
                    Where-Object {
                        $_.Trustee -notlike 'NT AUTHORITY\*' -and
                        $_.Trustee -notlike 'S-1-5-*'
                    }
                foreach ($perm in @($sendAs)) {
                    $rows.Add([pscustomobject]@{
                        mailboxId            = $mailboxId
                        mailboxDisplayName   = $displayName
                        mailboxPrimarySmtp   = $primarySmtp
                        scope                = 'mailbox'
                        permissionType       = 'SendAs'
                        principal            = [string]$perm.Trustee
                        accessRights         = @('SendAs')
                        automap              = $false
                        inherited             = $false
                    })
                }
            }
            catch {
                Write-Verbose "SendAs permissions unavailable for '$mailboxId': $($_.Exception.Message)"
            }
            foreach ($delegate in @($mailbox.GrantSendOnBehalfTo)) {
                if ([string]$delegate.Trim().Length -gt 0) {
                    $rows.Add([pscustomobject]@{
                        mailboxId            = $mailboxId
                        mailboxDisplayName   = $displayName
                        mailboxPrimarySmtp   = $primarySmtp
                        scope                = 'mailbox'
                        permissionType       = 'SendOnBehalf'
                        principal            = [string]$delegate
                        accessRights         = @('SendOnBehalf')
                        automap              = $false
                        inherited             = $false
                    })
                }
            }
        }

        if ($Scope -eq '' -or $Scope -eq 'calendar') {
            try {
                $calendar = Get-EXOMailboxFolderPermission -Identity "${primarySmtp}:\Calendar" -ErrorAction Stop
                foreach ($entry in @($calendar)) {
                    $rows.Add([pscustomobject]@{
                        mailboxId            = $mailboxId
                        mailboxDisplayName   = $displayName
                        mailboxPrimarySmtp   = $primarySmtp
                        scope                = 'calendar'
                        permissionType       = 'Calendar'
                        principal            = [string]$entry.User
                        accessRights         = @($entry.AccessRights)
                        automap              = $false
                        inherited             = $false
                    })
                }
            }
            catch {
                Write-Verbose "Calendar permissions unavailable for '$mailboxId': $($_.Exception.Message)"
            }
        }
    }

    $ordered = @($rows)
    if ($Search.Trim().Length -gt 0) {
        $needle = $Search.Trim().ToLowerInvariant()
        $ordered = @($ordered | Where-Object {
            ("{0} {1} {2}" -f $_.mailboxDisplayName, $_.mailboxPrimarySmtp, $_.principal).ToLowerInvariant().Contains($needle)
        })
    }

    $offset = ConvertFrom-MailboxPermissionsCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-MailboxPermissionsCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Read-MailboxPermissionsJob {
    <#
    .SYNOPSIS
        Reads a feature job envelope file into Get-MailboxPermissions parameters.
    .DESCRIPTION
        Validates the tenant id and carries the optional scope, search, and
        pagination fields. The envelope carries references only; secrets are
        never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-MailboxPermissionsJob -Path './run/mailbox-permissions-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Mailbox permissions job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Mailbox permissions job is missing required field: tenantId'
    }

    return @{
        TenantId  = $tenantId
        Scope     = [string]$job['scope']
        MailboxId = [string]$job['mailboxId']
        Search    = [string]$job['search']
        Top       = Get-MailboxPermissionsJobInt -Value $job['top'] -Default 100
        Cursor    = [string]$job['cursor']
    }
}

function Get-MailboxPermissionsJobInt {
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
