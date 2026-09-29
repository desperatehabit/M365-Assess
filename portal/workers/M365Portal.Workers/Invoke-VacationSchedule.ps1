# Invoke-VacationSchedule.ps1 — EPIC-020 vacation mode enable/revert worker (SPEC §4.3, §5, §6, §8, §9; T-0386).
#
# Enables OoO + forwarding at the window start and reverts at the window end
# (or immediately for End now). A revert of an already-reverted mailbox is a
# structured no-op with no EXO write, mirroring the convert no-op. A failed
# revert is recorded as failed and raises an alert rather than silently ending.
#
# Gating (EPIC-006 contract, T-0107): vacation applies are not registry CheckId
# commands, so they cannot travel the CheckId-bound executor path. They follow
# the same contract instead — the BFF confirms the plan before dispatch,
# -DryRun reports the intended change without writing, -Confirmed is re-checked
# here so a job that skips confirmation cannot apply, every apply captures
# before/after, and every apply emits one audit record plus one
# MailboxOperation row (T-0382). The supervisor connects EXO in the child
# process after materializing the tenant credential in-process; this file never
# touches secrets.

function Test-VacationScheduleInput {
    <#
    .SYNOPSIS
        Validates one planned vacation enable/revert.
    .DESCRIPTION
        Mirrors the BFF route validation so the worker refuses the same rows
        the BFF would: missing mailbox, unparseable or inverted window, missing
        OoO message for enable, and malformed forwarding target. Returns the
        error list; empty is valid.
    .PARAMETER MailboxId
        Mailbox the schedule belongs to.
    .PARAMETER StartsAt
        Window start (ISO-8601).
    .PARAMETER EndsAt
        Window end (ISO-8601).
    .PARAMETER OooMessage
        Out-of-office message, required for enable.
    .PARAMETER ForwardTo
        Forwarding target, or empty for OoO-only.
    .PARAMETER Phase
        'enable' or 'revert'.
    .EXAMPLE
        Test-VacationScheduleInput -MailboxId 'mbx-1' -StartsAt '2026-10-01T00:00:00Z' -EndsAt '2026-10-08T00:00:00Z' -OooMessage 'Out.' -Phase 'enable'
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()]
        [string]$MailboxId = '',

        [Parameter()]
        [string]$StartsAt = '',

        [Parameter()]
        [string]$EndsAt = '',

        [Parameter()]
        [string]$OooMessage = '',

        [Parameter()]
        [string]$ForwardTo = '',

        [Parameter()]
        [ValidateSet('enable', 'revert')]
        [string]$Phase = 'enable'
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace($MailboxId)) {
        $errors.Add('mailboxId is required')
    }
    $start = [datetime]::MinValue
    $end = [datetime]::MinValue
    try {
        $start = [datetime]::Parse($StartsAt)
    }
    catch {
        $errors.Add("startsAt '$StartsAt' must be a valid ISO-8601 timestamp")
    }
    try {
        $end = [datetime]::Parse($EndsAt)
    }
    catch {
        $errors.Add("endsAt '$EndsAt' must be a valid ISO-8601 timestamp")
    }
    if ($errors.Count -eq 0 -and $end -le $start) {
        $errors.Add('endsAt must be after startsAt')
    }
    if ($Phase -eq 'enable' -and [string]::IsNullOrWhiteSpace($OooMessage)) {
        $errors.Add('oooMessage is required for enable')
    }
    if (-not [string]::IsNullOrWhiteSpace($ForwardTo) -and $ForwardTo.Trim() -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
        $errors.Add("forwardTo '$($ForwardTo.Trim())' must be a valid SMTP address")
    }
    return @($errors)
}

function Get-VacationMailboxState {
    <#
    .SYNOPSIS
        Captures the OoO + forwarding snapshot used for before/after.
    .PARAMETER MailboxId
        Mailbox identity to read.
    .EXAMPLE
        Get-VacationMailboxState -MailboxId 'mbx-1'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId
    )

    $autoReply = Get-MailboxAutoReplyConfiguration -Identity $MailboxId
    $mailbox = Get-Mailbox -Identity $MailboxId
    if (-not $autoReply -or -not $mailbox) {
        throw "NotFound: Mailbox '$MailboxId' not found"
    }
    return @{
        id                           = $MailboxId
        autoReplyState               = [string]$autoReply.AutoReplyState
        internalMessage              = [string]$autoReply.InternalMessage
        externalMessage              = [string]$autoReply.ExternalMessage
        forwardingAddress            = [string]$mailbox.ForwardingAddress
        forwardingSmtpAddress        = [string]$mailbox.ForwardingSmtpAddress
        deliverToMailboxAndForward   = [bool]$mailbox.DeliverToMailboxAndForward
    }
}

function Test-VacationRevertedState {
    <#
    .SYNOPSIS
        Reports whether OoO is already off with no forwarding set.
    .PARAMETER State
        Snapshot from Get-VacationMailboxState.
    .EXAMPLE
        Test-VacationRevertedState -State $before
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [hashtable]$State
    )

    $oooOff = [string]$State['autoReplyState'] -ne 'Enabled'
    $noForwarding = [string]::IsNullOrWhiteSpace([string]$State['forwardingAddress']) -and
        [string]::IsNullOrWhiteSpace([string]$State['forwardingSmtpAddress'])
    return ($oooOff -and $noForwarding)
}

function Read-VacationScheduleJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-VacationSchedule parameters.
    .DESCRIPTION
        Validates the envelope carries a tenant, schedule, and phase, then
        returns the schedule window, OoO message, forwarding target, expiry
        bound, confirmation, and dry-run flag. The envelope carries references
        and planned values only.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-VacationScheduleJob -Path './run/vacation-job.json'
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
    if (-not $json.scheduleId) {
        throw "job envelope '$Path' is missing mandatory 'scheduleId'"
    }
    if (-not $json.phase) {
        throw "job envelope '$Path' is missing mandatory 'phase'"
    }

    return @{
        TenantId   = [string]$json.tenantId
        ScheduleId = [string]$json.scheduleId
        Phase      = [string]$json.phase
        MailboxId  = if ($json.mailboxId) { [string]$json.mailboxId } else { '' }
        StartsAt   = if ($json.startsAt) { [string]$json.startsAt } else { '' }
        EndsAt     = if ($json.endsAt) { [string]$json.endsAt } else { '' }
        OooMessage = if ($json.oooMessage) { [string]$json.oooMessage } else { '' }
        ForwardTo  = if ($json.forwardTo) { [string]$json.forwardTo } else { '' }
        NotAfter   = if ($json.notAfter) { [string]$json.notAfter } else { '' }
        Confirmed  = [bool]($json.confirmed -eq $true)
        DryRun     = [bool]($json.dryRun -eq $true)
    }
}

function Invoke-VacationSchedule {
    <#
    .SYNOPSIS
        Enables or reverts vacation OoO + forwarding with before/after capture.
    .DESCRIPTION
        -DryRun returns the plan with no EXO write. Without -DryRun, -Confirmed
        is required or the apply is refused. Enable past -NotAfter is an
        expired skip with no write, so a stale scheduler refire can never
        re-enable OoO. Revert of an already-reverted mailbox is a structured
        no-op with no EXO write. Every apply emits one auditEvent and one
        mailboxOperation. A failed revert is returned — not thrown — as
        success false with scheduleState failed, an alertEvent, and a failure
        audit, so the failure is recorded and raises an alert instead of
        silently ending.
    .PARAMETER TenantId
        Tenant the mailbox belongs to. Carried through to the result envelope.
    .PARAMETER Phase
        'enable' applies OoO + forwarding; 'revert' disables them.
    .PARAMETER ScheduleId
        Vacation schedule id. Carried through to audit, operation, and alert.
    .PARAMETER MailboxId
        Mailbox identity.
    .PARAMETER StartsAt
        Window start (ISO-8601).
    .PARAMETER EndsAt
        Window end (ISO-8601).
    .PARAMETER OooMessage
        Out-of-office message for enable.
    .PARAMETER ForwardTo
        Forwarding target for enable; empty for OoO-only.
    .PARAMETER NotAfter
        Apply bound from the scheduler envelope; enable past it is skipped.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for apply; the BFF confirms the plan before dispatch.
    .PARAMETER RaiseAlert
        Seam: scriptblock (alertEvent) -> void. Invoked on revert failure.
    .EXAMPLE
        Invoke-VacationSchedule -TenantId 'tenant-a' -Phase 'revert' -ScheduleId 'vac-1' -MailboxId 'mbx-1' -StartsAt '2026-10-01T00:00:00Z' -EndsAt '2026-10-08T00:00:00Z' -Confirmed
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('enable', 'revert')]
        [string]$Phase,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$ScheduleId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId,

        [Parameter()]
        [string]$StartsAt = '',

        [Parameter()]
        [string]$EndsAt = '',

        [Parameter()]
        [string]$OooMessage = '',

        [Parameter()]
        [string]$ForwardTo = '',

        [Parameter()]
        [string]$NotAfter = '',

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false,

        [Parameter()]
        [scriptblock]$RaiseAlert
    )

    if (-not $RaiseAlert) {
        $RaiseAlert = { param($alertEvent) $null = $alertEvent }
    }

    $failures = @(Test-VacationScheduleInput -MailboxId $MailboxId -StartsAt $StartsAt -EndsAt $EndsAt -OooMessage $OooMessage -ForwardTo $ForwardTo -Phase $Phase)
    if ($failures.Count -gt 0) {
        throw "ValidationFailed: $($failures -join '; ')"
    }

    $mailboxKey = $MailboxId.Trim()
    $message = $OooMessage.Trim()
    $forwardTarget = $ForwardTo.Trim()
    $timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

    $before = Get-VacationMailboxState -MailboxId $mailboxKey
    $diff = [System.Collections.Generic.List[string]]::new()

    if ($Phase -eq 'enable') {
        if (-not [string]::IsNullOrWhiteSpace($NotAfter) -and [datetime]::UtcNow -gt [datetime]::Parse($NotAfter)) {
            $diff.Add("Window for mailbox '$mailboxKey' already ended; enable skipped with no change applied")
            $plan = [pscustomobject]@{
                action               = $Phase
                scheduleId           = $ScheduleId
                mailboxId            = $mailboxKey
                targetName           = $mailboxKey
                before               = $before
                after                = $before
                diff                 = @($diff)
                valid                = $true
                dryRun               = $DryRun
                requiresConfirmation = $false
            }
            if ($DryRun) {
                return $plan
            }
            return [pscustomobject]@{
                plan             = $plan
                result           = @{ id = $mailboxKey; expired = $true }
                auditEvent       = @{
                    id         = [guid]::NewGuid().ToString()
                    tenantId   = $TenantId
                    action     = 'vacation.enable'
                    targetId   = $ScheduleId
                    targetName = $mailboxKey
                    timestamp  = $timestamp
                    before     = $before
                    after      = $before
                    note       = 'window already ended; enable skipped'
                }
                expired          = $true
                scheduleState    = 'ended'
                success          = $true
            }
        }

        $after = $before.Clone()
        $after['autoReplyState'] = 'Enabled'
        $after['internalMessage'] = $message
        $after['externalMessage'] = $message
        if ($forwardTarget.Length -gt 0) {
            $after['forwardingSmtpAddress'] = $forwardTarget
            $after['deliverToMailboxAndForward'] = $true
        }
        $diff.Add("Enable OoO for mailbox '$mailboxKey' with forwarding to '$forwardTarget'")

        $alreadyEnabled = [string]$before['autoReplyState'] -eq 'Enabled' -and
            [string]$before['internalMessage'] -eq $message -and
            [string]$before['forwardingSmtpAddress'] -eq $forwardTarget
        if ($alreadyEnabled) {
            $diff.Add("OoO for mailbox '$mailboxKey' is already enabled with the same message; no change applied")
            $plan = [pscustomobject]@{
                action               = $Phase
                scheduleId           = $ScheduleId
                mailboxId            = $mailboxKey
                targetName           = $mailboxKey
                before               = $before
                after                = $before.Clone()
                diff                 = @($diff)
                valid                = $true
                dryRun               = $DryRun
                requiresConfirmation = $false
            }
            if ($DryRun) {
                return $plan
            }
            return [pscustomobject]@{
                plan             = $plan
                result           = @{ id = $mailboxKey; noop = $true }
                auditEvent       = @{
                    id         = [guid]::NewGuid().ToString()
                    tenantId   = $TenantId
                    action     = 'vacation.enable'
                    targetId   = $ScheduleId
                    targetName = $mailboxKey
                    timestamp  = $timestamp
                    before     = $before
                    after      = $before
                    note       = 'already enabled; no change applied'
                }
                mailboxOperation = @{
                    id        = [guid]::NewGuid().ToString()
                    tenantId  = $TenantId
                    mailboxId = $mailboxKey
                    operation = 'enable'
                    before    = $before
                    after     = $before
                    state     = 'noop'
                    at        = $timestamp
                }
                noop             = $true
                scheduleState    = 'active'
                success          = $true
            }
        }

        $plan = [pscustomobject]@{
            action               = $Phase
            scheduleId           = $ScheduleId
            mailboxId            = $mailboxKey
            targetName           = $mailboxKey
            before               = $before
            after                = $after
            diff                 = @($diff)
            valid                = $true
            dryRun               = $DryRun
            requiresConfirmation = $false
        }
        if ($DryRun) {
            return $plan
        }
        if (-not $Confirmed) {
            throw "mailbox.confirm_required: action '$Phase' requires explicit confirmation"
        }

        $null = Set-MailboxAutoReplyConfiguration -Identity $mailboxKey -AutoReplyState Enabled -InternalMessage $message -ExternalMessage $message
        if ($forwardTarget.Length -gt 0) {
            $null = Set-Mailbox -Identity $mailboxKey -ForwardingSmtpAddress $forwardTarget -DeliverToMailboxAndForward $true
        }
        $after = Get-VacationMailboxState -MailboxId $mailboxKey

        return [pscustomobject]@{
            plan             = [pscustomobject]@{
                action               = $Phase
                scheduleId           = $ScheduleId
                mailboxId            = $mailboxKey
                targetName           = $mailboxKey
                before               = $before
                after                = $after
                diff                 = @($diff)
                valid                = $true
                dryRun               = $false
                requiresConfirmation = $false
            }
            result           = @{ id = $mailboxKey }
            auditEvent       = @{
                id         = [guid]::NewGuid().ToString()
                tenantId   = $TenantId
                action     = 'vacation.enable'
                targetId   = $ScheduleId
                targetName = $mailboxKey
                timestamp  = $timestamp
                before     = $before
                after      = $after
            }
            mailboxOperation = @{
                id        = [guid]::NewGuid().ToString()
                tenantId  = $TenantId
                mailboxId = $mailboxKey
                operation = 'enable'
                before    = $before
                after     = $after
                state     = 'applied'
                at        = $timestamp
            }
            scheduleState    = 'active'
            success          = $true
        }
    }

    $after = $before.Clone()
    $after['autoReplyState'] = 'Disabled'
    $after['forwardingAddress'] = ''
    $after['forwardingSmtpAddress'] = ''
    $after['deliverToMailboxAndForward'] = $false
    $diff.Add("Revert OoO and forwarding for mailbox '$mailboxKey'")

    $plan = [pscustomobject]@{
        action               = $Phase
        scheduleId           = $ScheduleId
        mailboxId            = $mailboxKey
        targetName           = $mailboxKey
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = $false
    }
    if ($DryRun) {
        return $plan
    }
    if (-not $Confirmed) {
        throw "mailbox.confirm_required: action '$Phase' requires explicit confirmation"
    }

    if (Test-VacationRevertedState -State $before) {
        $diff.Add("Mailbox '$mailboxKey' is already reverted; no change applied")
        $plan = [pscustomobject]@{
            action               = $Phase
            scheduleId           = $ScheduleId
            mailboxId            = $mailboxKey
            targetName           = $mailboxKey
            before               = $before
            after                = $before.Clone()
            diff                 = @($diff)
            valid                = $true
            dryRun               = $false
            requiresConfirmation = $false
        }
        return [pscustomobject]@{
            plan             = $plan
            result           = @{ id = $mailboxKey; noop = $true }
            auditEvent       = @{
                id         = [guid]::NewGuid().ToString()
                tenantId   = $TenantId
                action     = 'vacation.revert'
                targetId   = $ScheduleId
                targetName = $mailboxKey
                timestamp  = $timestamp
                before     = $before
                after      = $before
                note       = 'already reverted; no change applied'
            }
            mailboxOperation = @{
                id        = [guid]::NewGuid().ToString()
                tenantId  = $TenantId
                mailboxId = $mailboxKey
                operation = 'revert'
                before    = $before
                after     = $before
                state     = 'noop'
                at        = $timestamp
            }
            noop             = $true
            scheduleState    = 'ended'
            success          = $true
        }
    }

    try {
        $null = Set-MailboxAutoReplyConfiguration -Identity $mailboxKey -AutoReplyState Disabled
        $null = Set-Mailbox -Identity $mailboxKey -ForwardingAddress $null -ForwardingSmtpAddress $null -DeliverToMailboxAndForward $false
        $after = Get-VacationMailboxState -MailboxId $mailboxKey
    }
    catch {
        $reason = $_.Exception.Message
        $failedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $alertEvent = @{
            kind       = 'vacation.revert'
            severity   = 'High'
            tenantId   = $TenantId
            scheduleId = $ScheduleId
            mailboxId  = $mailboxKey
            reason     = $reason
            timestamp  = $failedAt
        }
        $auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = 'vacation.revert'
            targetId   = $ScheduleId
            targetName = $mailboxKey
            timestamp  = $failedAt
            before     = $before
            after      = $before
            note       = "revert failed: $reason"
        }
        $mailboxOperation = @{
            id        = [guid]::NewGuid().ToString()
            tenantId  = $TenantId
            mailboxId = $mailboxKey
            operation = 'revert'
            before    = $before
            after     = $before
            state     = 'failed'
            at        = $failedAt
        }
        & $RaiseAlert $alertEvent
        return [pscustomobject]@{
            plan             = $plan
            result           = @{ id = $mailboxKey; error = $reason }
            auditEvent       = $auditEvent
            mailboxOperation = $mailboxOperation
            alertEvent       = $alertEvent
            alerted          = $true
            scheduleState    = 'failed'
            success          = $false
        }
    }

    return [pscustomobject]@{
        plan             = [pscustomobject]@{
            action               = $Phase
            scheduleId           = $ScheduleId
            mailboxId            = $mailboxKey
            targetName           = $mailboxKey
            before               = $before
            after                = $after
            diff                 = @($diff)
            valid                = $true
            dryRun               = $false
            requiresConfirmation = $false
        }
        result           = @{ id = $mailboxKey }
        auditEvent       = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = 'vacation.revert'
            targetId   = $ScheduleId
            targetName = $mailboxKey
            timestamp  = $timestamp
            before     = $before
            after      = $after
        }
        mailboxOperation = @{
            id        = [guid]::NewGuid().ToString()
            tenantId  = $TenantId
            mailboxId = $mailboxKey
            operation = 'revert'
            before    = $before
            after     = $after
            state     = 'applied'
            at        = $timestamp
        }
        scheduleState    = 'ended'
        success          = $true
    }
}
