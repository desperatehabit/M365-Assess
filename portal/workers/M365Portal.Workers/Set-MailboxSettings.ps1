# Set-MailboxSettings.ps1 — EPIC-020 mailbox settings worker (SPEC §2 US-3, §3.2, §4.1, §5, §6, §9; T-0383).
#
# Applies quota, archive (including auto-expanding), litigation and retention
# holds, locale, recipient limits, calendar processing, and hide-from-GAL
# settings to one EXO mailbox. Supports DryRun (plan preview mode returning
# diff without mutating). Settings that already match are a structured no-op:
# success with noop set, no EXO write, before equal to after.
#
# Gating (EPIC-006 contract, T-0107): settings are not registry CheckId
# commands, so they cannot travel the CheckId-bound executor path. They follow
# the same contract instead — the BFF confirms the plan before dispatch
# (dryRun plans only), -DryRun reports the intended change without writing,
# -Confirmed is re-checked here so a job that skips confirmation cannot apply,
# enabling or expanding archive and changing a hold are risk-flagged
# (requiresConfirmation) and refuse apply without -Confirmed, every apply
# captures before/after, and every apply emits one MailboxOperation row plus
# one audit record. The supervisor connects EXO in the child process after
# materializing the tenant credential in-process; this file never touches
# secrets.

function Get-MailboxSettingsFieldList {
    <#
    .SYNOPSIS
        Returns the mailbox settings fields this worker accepts.
    .DESCRIPTION
        Mirrors MAILBOX_SETTINGS_FIELDS in portal/bff/src/routes/mailboxes.ts.
        A field outside this catalogue is a validation failure, never a
        silent skip.
    .EXAMPLE
        Get-MailboxSettingsFieldList
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @(
        'issueWarningQuota', 'prohibitSendQuota', 'prohibitSendReceiveQuota',
        'archiveEnabled', 'autoExpandingArchiveEnabled',
        'litigationHoldEnabled', 'litigationHoldDurationDays', 'retentionHoldEnabled',
        'locale', 'maxSendSizeKB', 'maxReceiveSizeKB', 'maxRecipientsPerMessage',
        'calendarAutomateProcessing', 'calendarAllowConflicts',
        'hiddenFromAddressListsEnabled'
    )
}

function Test-MailboxSettingsInput {
    <#
    .SYNOPSIS
        Validates one planned mailbox settings change.
    .DESCRIPTION
        Mirrors the BFF route validation so the worker refuses the same rows
        the BFF would: unknown fields, malformed quotas, non-boolean flags,
        out-of-range durations and limits, malformed locales, and unsupported
        calendar processing modes. Returns the error list; empty is valid.
    .PARAMETER Settings
        Planned settings as a hashtable of field name to desired value.
    .EXAMPLE
        Test-MailboxSettingsInput -Settings @{ prohibitSendQuota = '50 GB' }
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()]
        [object]$Settings
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    if ($Settings -isnot [System.Collections.IDictionary]) {
        $errors.Add('settings must be an object of mailbox setting fields')
        return @($errors)
    }
    $allowed = Get-MailboxSettingsFieldList
    foreach ($key in @($Settings.Keys)) {
        $name = [string]$key
        if (-not $allowed.Contains($name)) {
            $errors.Add("unknown mailbox setting '$name'; settable: $($allowed -join ', ')")
        }
    }
    if ($errors.Count -gt 0) {
        return @($errors)
    }
    if ($Settings.Count -eq 0) {
        $errors.Add('settings must include at least one mailbox setting')
        return @($errors)
    }

    foreach ($field in @('issueWarningQuota', 'prohibitSendQuota', 'prohibitSendReceiveQuota')) {
        if ($Settings.Contains($field)) {
            $raw = [string]$Settings[$field]
            if ([string]::IsNullOrWhiteSpace($raw) -or -not (Test-MailboxSettingsQuota -Value $raw)) {
                $errors.Add("$field '$raw' must be a size like '50 GB' or 'Unlimited'")
            }
        }
    }
    foreach ($field in @('archiveEnabled', 'autoExpandingArchiveEnabled', 'litigationHoldEnabled', 'retentionHoldEnabled', 'calendarAllowConflicts', 'hiddenFromAddressListsEnabled')) {
        if ($Settings.Contains($field)) {
            $raw = $Settings[$field]
            if ($raw -isnot [bool]) {
                try {
                    $null = [System.Convert]::ToBoolean($raw)
                }
                catch {
                    $errors.Add("$field must be a boolean")
                }
            }
        }
    }
    if ($Settings.Contains('litigationHoldDurationDays')) {
        $raw = $Settings['litigationHoldDurationDays']
        $days = 0
        if ($raw -is [int]) {
            $days = $raw
        }
        elseif ($raw -is [long] -or $raw -is [double]) {
            $days = [int]$raw
        }
        else {
            $days = -1
        }
        if ($days -lt 1 -or $days -gt 36500) {
            $errors.Add('litigationHoldDurationDays must be an integer between 1 and 36500')
        }
    }
    if ($Settings.Contains('locale')) {
        if ([string]$Settings['locale'] -notmatch '^[A-Za-z]{2}(-[A-Za-z]{2})?$') {
            $errors.Add("locale '$($Settings['locale'])' must look like 'en-US'")
        }
    }
    foreach ($field in @('maxSendSizeKB', 'maxReceiveSizeKB', 'maxRecipientsPerMessage')) {
        if ($Settings.Contains($field)) {
            $raw = $Settings[$field]
            $number = 0
            if ($raw -is [int] -or $raw -is [long] -or $raw -is [double]) {
                $number = [long]$raw
            }
            if ($number -lt 1) {
                $errors.Add("$field must be a positive integer")
            }
        }
    }
    if ($Settings.Contains('calendarAutomateProcessing')) {
        $raw = [string]$Settings['calendarAutomateProcessing']
        if (@('None', 'AutoUpdate', 'AutoAccept') -notcontains $raw) {
            $errors.Add("calendarAutomateProcessing '$raw' must be one of: None, AutoUpdate, AutoAccept")
        }
    }
    return @($errors)
}

function Test-MailboxSettingsQuota {
    <#
    .SYNOPSIS
        Tests whether a quota value matches the EXO size shape.
    .PARAMETER Value
        The quota value to test, e.g. '50 GB' or 'Unlimited'.
    .EXAMPLE
        Test-MailboxSettingsQuota -Value '50 GB'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [string]$Value
    )

    $trimmed = ([string]$Value).Trim()
    if ($trimmed -ieq 'unlimited') {
        return $true
    }
    return $trimmed -match '^\d+(\.\d+)?\s*(MB|GB|TB)$'
}

function ConvertTo-MailboxSizeKB {
    <#
    .SYNOPSIS
        Normalizes an EXO size string to whole kilobytes for diffing.
    .DESCRIPTION
        Prefers the trailing byte count EXO appends ("35 MB (36,700,160
        bytes)"); otherwise parses the leading number and unit. Returns null
        for 'Unlimited' and unparseable values so the diff falls back to a
        raw comparison.
    .PARAMETER Value
        The EXO size value.
    .EXAMPLE
        ConvertTo-MailboxSizeKB -Value '35 MB (36,700,160 bytes)'
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
    $text = ([string]$Value).Trim()
    if ($text -ieq 'unlimited') {
        return $null
    }
    $bytesMatch = [regex]::Match($text, '\(([\d,]+)\s*bytes\)')
    if ($bytesMatch.Success) {
        $bytes = [long](($bytesMatch.Groups[1].Value) -replace ',', '')
        return [long][Math]::Floor($bytes / 1024)
    }
    $sizeMatch = [regex]::Match($text, '^([\d.]+)\s*(KB|MB|GB|TB)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($sizeMatch.Success) {
        $number = [double]$sizeMatch.Groups[1].Value
        $unit = $sizeMatch.Groups[2].Value.ToUpperInvariant()
        $multiplier = switch ($unit) {
            'KB' { 1 }
            'MB' { 1024 }
            'GB' { 1048576 }
            'TB' { 1073741824 }
            default { 1 }
        }
        return [long][Math]::Floor($number * $multiplier)
    }
    if ($text -match '^\d+$') {
        return [long][Math]::Floor([long]$text / 1024)
    }
    return $null
}

function Get-MailboxCalendarProcessingState {
    <#
    .SYNOPSIS
        Reads calendar processing mode and conflict policy.
    .DESCRIPTION
        Returns mode and allowConflicts, or nulls when the cmdlet is
        unavailable or the read fails, so settings diffing still works.
    .PARAMETER MailboxId
        The target mailbox identity.
    .EXAMPLE
        Get-MailboxCalendarProcessingState -MailboxId 'mbx-2'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId
    )

    $state = @{ mode = $null; allowConflicts = $null }
    if (-not (Get-Command Get-CalendarProcessing -ErrorAction SilentlyContinue)) {
        return $state
    }
    try {
        $calendar = Get-CalendarProcessing -Identity $MailboxId -ErrorAction SilentlyContinue
        if ($null -eq $calendar) {
            return $state
        }
        if ($null -ne $calendar.AutomateProcessing) {
            $state['mode'] = ([string]$calendar.AutomateProcessing).Trim()
        }
        if ($null -ne $calendar.AllowConflicts) {
            $state['allowConflicts'] = [bool]$calendar.AllowConflicts
        }
        return $state
    }
    catch {
        return $state
    }
}

function Get-MailboxSettingsState {
    <#
    .SYNOPSIS
        Reads the current settable settings for diffing.
    .DESCRIPTION
        GETs the live mailbox and shapes the worker catalogue fields.
        Calendar and regional values are read when their cmdlets are
        available; otherwise the field reads null and is still diffable. A
        missing mailbox returns null so the caller can fail with NotFound.
    .PARAMETER MailboxId
        The target mailbox identity.
    .EXAMPLE
        Get-MailboxSettingsState -MailboxId 'mbx-2'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId
    )

    $mailbox = Get-EXOMailbox -Identity $MailboxId
    if ($null -eq $mailbox) {
        return $null
    }

    $archiveEnabled = $false
    if ($null -ne $mailbox.ArchiveStatus) {
        $archiveEnabled = ([string]$mailbox.ArchiveStatus).Trim() -ieq 'active'
    }
    elseif ($null -ne $mailbox.ArchiveGuid -and -not [string]::IsNullOrWhiteSpace([string]$mailbox.ArchiveGuid)) {
        $archiveEnabled = ([string]$mailbox.ArchiveGuid).Trim() -ine '00000000-0000-0000-0000-000000000000'
    }

    $holdDays = $null
    if ($null -ne $mailbox.LitigationHoldDuration) {
        $durationText = ([string]$mailbox.LitigationHoldDuration).Trim()
        $daysMatch = [regex]::Match($durationText, '^(\d+)')
        if ($daysMatch.Success) {
            $holdDays = [int]$daysMatch.Groups[1].Value
        }
    }

    $calendarState = Get-MailboxCalendarProcessingState -MailboxId $MailboxId
    $calendarMode = $calendarState['mode']
    $calendarConflicts = $calendarState['allowConflicts']

    return [ordered]@{
        id                              = if ([string]::IsNullOrWhiteSpace([string]$mailbox.ExchangeObjectId)) { $MailboxId } else { [string]$mailbox.ExchangeObjectId }
        displayName                     = [string]$mailbox.DisplayName
        issueWarningQuota               = [string]$mailbox.IssueWarningQuota
        prohibitSendQuota               = [string]$mailbox.ProhibitSendQuota
        prohibitSendReceiveQuota        = [string]$mailbox.ProhibitSendReceiveQuota
        archiveEnabled                  = [bool]$archiveEnabled
        autoExpandingArchiveEnabled     = if ($null -eq $mailbox.AutoExpandingArchiveEnabled) { $false } else { [bool]$mailbox.AutoExpandingArchiveEnabled }
        litigationHoldEnabled           = if ($null -eq $mailbox.LitigationHoldEnabled) { $false } else { [bool]$mailbox.LitigationHoldEnabled }
        litigationHoldDurationDays      = $holdDays
        retentionHoldEnabled            = if ($null -eq $mailbox.RetentionHoldEnabled) { $false } else { [bool]$mailbox.RetentionHoldEnabled }
        locale                          = $null
        maxSendSizeKB                   = ConvertTo-MailboxSizeKB -Value $mailbox.MaxSendSize
        maxReceiveSizeKB                = ConvertTo-MailboxSizeKB -Value $mailbox.MaxReceiveSize
        maxRecipientsPerMessage         = if ($null -eq $mailbox.RecipientLimits) { $null } else { [long]$mailbox.RecipientLimits }
        calendarAutomateProcessing      = $calendarMode
        calendarAllowConflicts          = $calendarConflicts
        hiddenFromAddressListsEnabled   = if ($null -eq $mailbox.HiddenFromAddressListsEnabled) { $false } else { [bool]$mailbox.HiddenFromAddressListsEnabled }
    }
}

function Compare-MailboxSettings {
    <#
    .SYNOPSIS
        Diffs planned settings against current state.
    .DESCRIPTION
        Only requested fields whose normalized value would change produce a
        diff line; matching fields keep the current value in after. Size
        quotas compare in kilobytes so '50 GB' matches EXO's byte-count form.
    .PARAMETER Before
        Current state from Get-MailboxSettingsState.
    .PARAMETER Settings
        Planned settings as a hashtable of field name to desired value.
    .EXAMPLE
        Compare-MailboxSettings -Before $before -Settings @{ prohibitSendQuota = '50 GB' }
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [object]$Before,

        [Parameter(Mandatory)]
        [object]$Settings
    )

    $after = @{}
    foreach ($property in @($Before.Keys)) {
        $after[$property] = $Before[$property]
    }
    $diff = [System.Collections.Generic.List[string]]::new()

    foreach ($key in @($Settings.Keys)) {
        $name = [string]$key
        $wanted = $Settings[$key]
        switch ($name) {
            { $_ -in @('issueWarningQuota', 'prohibitSendQuota', 'prohibitSendReceiveQuota') } {
                $wantedText = ([string]$wanted).Trim()
                $currentKB = ConvertTo-MailboxSizeKB -Value $Before.$name
                $wantedKB = ConvertTo-MailboxSizeKB -Value $wantedText
                $changed = if ($null -eq $currentKB -or $null -eq $wantedKB) {
                    ([string]$Before.$name).Trim() -ine $wantedText
                }
                else {
                    $currentKB -ne $wantedKB
                }
                if ($changed) {
                    $after[$name] = $wantedText
                    $diff.Add("Set ${name}: $($Before.$name) -> $wantedText")
                }
            }
            { $_ -in @('archiveEnabled', 'autoExpandingArchiveEnabled', 'litigationHoldEnabled', 'retentionHoldEnabled', 'calendarAllowConflicts', 'hiddenFromAddressListsEnabled') } {
                $wantedBool = [bool]$wanted
                if ([bool]$Before.$name -ne $wantedBool) {
                    $after[$name] = $wantedBool
                    $diff.Add("Set ${name}: $($Before.$name) -> $wantedBool")
                }
            }
            'litigationHoldDurationDays' {
                if ($Before.$name -ne [int]$wanted) {
                    $after[$name] = [int]$wanted
                    $diff.Add("Set ${name}: $($Before.$name) -> $wanted")
                }
            }
            'locale' {
                $wantedLocale = ([string]$wanted).Trim()
                if ([string]$Before.$name -ine $wantedLocale) {
                    $after[$name] = $wantedLocale
                    $diff.Add("Set ${name}: $($Before.$name) -> $wantedLocale")
                }
            }
            { $_ -in @('maxSendSizeKB', 'maxReceiveSizeKB', 'maxRecipientsPerMessage') } {
                if ($Before.$name -ne [long]$wanted) {
                    $after[$name] = [long]$wanted
                    $diff.Add("Set ${name}: $($Before.$name) -> $wanted")
                }
            }
            'calendarAutomateProcessing' {
                $wantedMode = ([string]$wanted).Trim()
                if ([string]$Before.$name -ine $wantedMode) {
                    $after[$name] = $wantedMode
                    $diff.Add("Set ${name}: $($Before.$name) -> $wantedMode")
                }
            }
        }
    }

    return @{ After = $after; Diff = @($diff) }
}

function Test-MailboxSettingsConfirmation {
    <#
    .SYNOPSIS
        Tests whether planned settings need explicit confirmation.
    .DESCRIPTION
        Enabling or expanding archive and changing a hold are risk-flagged
        (SPEC §9): the plan carries requiresConfirmation and the apply
        refuses without -Confirmed.
    .PARAMETER Settings
        Planned settings as a hashtable of field name to desired value.
    .EXAMPLE
        Test-MailboxSettingsConfirmation -Settings @{ archiveEnabled = $true }
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [object]$Settings
    )

    if ($Settings -isnot [System.Collections.IDictionary]) {
        return $false
    }
    if ($Settings.Contains('archiveEnabled') -and [bool]$Settings['archiveEnabled']) {
        return $true
    }
    if ($Settings.Contains('autoExpandingArchiveEnabled') -and [bool]$Settings['autoExpandingArchiveEnabled']) {
        return $true
    }
    if ($Settings.Contains('litigationHoldEnabled') -or $Settings.Contains('retentionHoldEnabled')) {
        return $true
    }
    return $false
}

function Read-SetMailboxSettingsJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-SetMailboxSettings parameters.
    .DESCRIPTION
        Validates the envelope carries a tenant and a mailbox identity, then
        returns the planned settings, confirmation, and dry-run flag. The
        envelope carries references and planned values only.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-SetMailboxSettingsJob -Path './run/mailbox-settings-job.json'
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
    if (-not $json.mailboxId) {
        throw "job envelope '$Path' is missing mandatory 'mailboxId'"
    }

    $settings = @{}
    if ($null -ne $json.settings) {
        foreach ($property in @($json.settings.PSObject.Properties)) {
            $settings[$property.Name] = $property.Value
        }
    }

    return @{
        TenantId  = [string]$json.tenantId
        MailboxId = [string]$json.mailboxId
        Settings  = $settings
        Confirmed = [bool]($json.confirmed -eq $true)
        DryRun    = [bool]($json.dryRun -eq $true)
    }
}

function Invoke-SetMailboxSettings {
    <#
    .SYNOPSIS
        Executes or previews mailbox settings changes with before/after capture.
    .DESCRIPTION
        -DryRun returns the plan with no EXO write. Without -DryRun,
        -Confirmed is required or the apply is refused. Settings that already
        match return a structured no-op with no EXO write. Every apply emits
        one MailboxOperation row and one auditEvent with before/after for the
        app audit sink.
    .PARAMETER TenantId
        Tenant the mailbox belongs to. Carried through to the result envelope.
    .PARAMETER MailboxId
        Mailbox identity for the settings change.
    .PARAMETER Settings
        Planned settings as a hashtable of field name to desired value.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for apply; the BFF confirms the plan before dispatch.
    .EXAMPLE
        Invoke-SetMailboxSettings -TenantId 'tenant-a' -MailboxId 'mbx-2' -Settings @{ prohibitSendQuota = '50 GB' } -Confirmed -DryRun
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

        [Parameter(Mandatory)]
        [object]$Settings,

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false
    )

    $failures = @(Test-MailboxSettingsInput -Settings $Settings)
    if ($failures.Count -gt 0) {
        throw "ValidationFailed: $($failures -join '; ')"
    }

    $mailboxKey = $MailboxId.Trim()
    $before = Get-MailboxSettingsState -MailboxId $mailboxKey
    if ($null -eq $before) {
        throw "NotFound: Mailbox '$mailboxKey' not found"
    }
    $targetName = [string]$before.displayName
    if ([string]::IsNullOrWhiteSpace($targetName)) {
        $targetName = $mailboxKey
    }

    $compared = Compare-MailboxSettings -Before $before -Settings $Settings
    $after = $compared['After']
    $diff = @($compared['Diff'])
    $requiresConfirmation = Test-MailboxSettingsConfirmation -Settings $Settings

    $plan = [pscustomobject]@{
        action               = 'settings'
        mailboxId            = $mailboxKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = $diff
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = [bool]$requiresConfirmation
    }

    if ($diff.Count -eq 0) {
        if ($DryRun) {
            return $plan
        }
        $operationId = [guid]::NewGuid().ToString()
        $timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        return [pscustomobject]@{
            plan       = $plan
            result     = @{ id = [string]$before.id; noop = $true }
            operation  = @{
                id        = $operationId
                tenantId  = $TenantId
                mailboxId = [string]$before.id
                operation = 'mailbox.settings'
                before    = $before
                after     = $after
                state     = 'noop'
                by        = $null
                at        = $timestamp
            }
            auditEvent = @{
                id         = [guid]::NewGuid().ToString()
                tenantId   = $TenantId
                action     = 'mailbox.settings'
                targetId   = [string]$before.id
                targetName = $targetName
                timestamp  = $timestamp
                before     = $before
                after      = $after
                note       = 'settings already match; no change applied'
            }
            noop       = $true
            success    = $true
        }
    }

    if ($DryRun) {
        return $plan
    }

    if (-not $Confirmed) {
        throw "mailbox.confirm_required: settings for '$mailboxKey' require explicit confirmation"
    }

    $mailboxParams = @{ Identity = $mailboxKey }
    if ($Settings -is [System.Collections.IDictionary]) {
        if ($Settings.Contains('issueWarningQuota')) {
            $mailboxParams['IssueWarningQuota'] = ([string]$Settings['issueWarningQuota']).Trim()
        }
        if ($Settings.Contains('prohibitSendQuota')) {
            $mailboxParams['ProhibitSendQuota'] = ([string]$Settings['prohibitSendQuota']).Trim()
        }
        if ($Settings.Contains('prohibitSendReceiveQuota')) {
            $mailboxParams['ProhibitSendReceiveQuota'] = ([string]$Settings['prohibitSendReceiveQuota']).Trim()
        }
        if ($Settings.Contains('litigationHoldEnabled')) {
            $mailboxParams['LitigationHoldEnabled'] = [bool]$Settings['litigationHoldEnabled']
        }
        if ($Settings.Contains('litigationHoldDurationDays')) {
            $mailboxParams['LitigationHoldDuration'] = "$([int]$Settings['litigationHoldDurationDays']).00:00:00"
        }
        if ($Settings.Contains('retentionHoldEnabled')) {
            $mailboxParams['RetentionHoldEnabled'] = [bool]$Settings['retentionHoldEnabled']
        }
        if ($Settings.Contains('maxSendSizeKB')) {
            $mailboxParams['MaxSendSize'] = "$([long]$Settings['maxSendSizeKB']) KB"
        }
        if ($Settings.Contains('maxReceiveSizeKB')) {
            $mailboxParams['MaxReceiveSize'] = "$([long]$Settings['maxReceiveSizeKB']) KB"
        }
        if ($Settings.Contains('maxRecipientsPerMessage')) {
            $mailboxParams['RecipientLimits'] = [int]$Settings['maxRecipientsPerMessage']
        }
        if ($Settings.Contains('hiddenFromAddressListsEnabled')) {
            $mailboxParams['HiddenFromAddressListsEnabled'] = [bool]$Settings['hiddenFromAddressListsEnabled']
        }
        if ($Settings.Contains('autoExpandingArchiveEnabled')) {
            $mailboxParams['AutoExpandingArchiveEnabled'] = [bool]$Settings['autoExpandingArchiveEnabled']
        }
    }
    if ($mailboxParams.Count -gt 1) {
        $null = Set-Mailbox @mailboxParams
    }

    if ($Settings -is [System.Collections.IDictionary] -and $Settings.Contains('archiveEnabled') -and [bool]$Settings['archiveEnabled'] -and -not [bool]$before.archiveEnabled) {
        $null = Enable-Mailbox -Identity $mailboxKey -Archive
    }

    if ($Settings -is [System.Collections.IDictionary] -and $Settings.Contains('locale')) {
        $null = Set-MailboxRegionalConfiguration -Identity $mailboxKey -Language ([string]$Settings['locale']).Trim()
    }

    $calendarParams = @{ Identity = $mailboxKey }
    if ($Settings -is [System.Collections.IDictionary]) {
        if ($Settings.Contains('calendarAutomateProcessing')) {
            $calendarParams['AutomateProcessing'] = ([string]$Settings['calendarAutomateProcessing']).Trim()
        }
        if ($Settings.Contains('calendarAllowConflicts')) {
            $calendarParams['AllowConflicts'] = [bool]$Settings['calendarAllowConflicts']
        }
    }
    if ($calendarParams.Count -gt 1) {
        $null = Set-CalendarProcessing @calendarParams
    }

    $refreshed = Get-MailboxSettingsState -MailboxId $mailboxKey
    if ($null -ne $refreshed) {
        $after = @{}
        foreach ($property in @($refreshed.Keys)) {
            $after[$property] = $refreshed[$property]
        }
    }

    $plan = [pscustomobject]@{
        action               = 'settings'
        mailboxId            = $mailboxKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = $diff
        valid                = $true
        dryRun               = $false
        requiresConfirmation = [bool]$requiresConfirmation
    }

    $operationId = [guid]::NewGuid().ToString()
    $timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    return [pscustomobject]@{
        plan       = $plan
        result     = @{ id = [string]$before.id; displayName = $targetName }
        operation  = @{
            id        = $operationId
            tenantId  = $TenantId
            mailboxId = [string]$before.id
            operation = 'mailbox.settings'
            before    = $before
            after     = $after
            state     = 'applied'
            by        = $null
            at        = $timestamp
        }
        auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = 'mailbox.settings'
            targetId   = [string]$before.id
            targetName = $targetName
            timestamp  = $timestamp
            before     = $before
            after      = $after
        }
        success    = $true
    }
}
