# Invoke-QuarantineBulk.ps1 — EPIC-022 capped bulk quarantine release/delete
# worker (SPEC §3.3, §4.2, §8, §9; resolved §11.2; T-0425).
#
# Applies a capped selection of quarantine actions with explicit confirmation.
# A batch larger than the cap is refused before any release or delete — never
# truncated. Each item runs through the T-0424 typed executor
# Invoke-QuarantineAction, so every release/delete goes through the EPIC-006
# gate (T-0107) with a QuarantineAction and an AuditEvent carrying actor,
# message, and recipient. A failure on one message is reported per message and
# never aborts the rest. -DryRun plans the batch with no tenant write and no
# audit.

if (-not (Get-Command Invoke-QuarantineAction -CommandType Function -ErrorAction SilentlyContinue)) {
    . (Join-Path -Path $PSScriptRoot -ChildPath 'Invoke-QuarantineAction.ps1')
}

function Get-QuarantineBulkCap {
    <#
    .SYNOPSIS
        Returns the default per-action bulk cap.
    .DESCRIPTION
        The cap bounds one bulk request so a selection cannot release or delete
        an unbounded number of messages (SPEC §9 risk "quarantine volume";
        resolved §11.2). The route may configure a smaller positive cap.
    .EXAMPLE
        Get-QuarantineBulkCap
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param()

    return 100
}

function Get-QuarantineBulkActions {
    <#
    .SYNOPSIS
        Returns the quarantine actions this bulk worker dispatches.
    .DESCRIPTION
        The single source of truth for valid bulk action names. Anything else is
        refused with quarantine.unknown_action.
    .EXAMPLE
        Get-QuarantineBulkActions
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('release', 'releaseAll', 'delete')
}

function Invoke-QuarantineBulk {
    <#
    .SYNOPSIS
        Executes or previews a capped bulk quarantine release/delete.
    .DESCRIPTION
        Validates the action, the selection, the cap, and confirmation before
        any write. -DryRun returns the plan with no EXO write and no audit.
        Otherwise each message is applied through Invoke-QuarantineAction in its
        own trap, so a failure is reported per message without aborting the
        rest; the returned auditEvents carry one record per applied message.
    .PARAMETER TenantId
        Tenant the messages belong to.
    .PARAMETER Action
        One of the Get-QuarantineBulkActions names.
    .PARAMETER Messages
        Planned message objects with messageId, recipient, sender, and subject.
    .PARAMETER Cap
        Per-action cap. Zero or less falls back to Get-QuarantineBulkCap.
    .PARAMETER DryRun
        Report the intended batch without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for the whole batch.
    .PARAMETER Actor
        Caller identity recorded on each audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on each audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-QuarantineBulk -TenantId 'tenant-a' -Action 'delete' -Messages $messages -Confirmed
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [string]$Action,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [array]$Messages,

        [Parameter()]
        [int]$Cap = 0,

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [switch]$Confirmed,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    if ($Cap -le 0) {
        $Cap = Get-QuarantineBulkCap
    }

    $known = Get-QuarantineBulkActions
    if (-not $known.Contains($Action)) {
        throw "quarantine.unknown_action: unknown bulk quarantine action '$Action'; expected one of: $($known -join ', ')"
    }

    $count = @($Messages).Count
    if ($count -eq 0) {
        throw 'quarantine.validation_failed: bulk selection is empty'
    }
    if ($count -gt $Cap) {
        throw "quarantine.bulk_cap_exceeded: bulk selection of $count exceeds the cap of $Cap; nothing was released or deleted"
    }
    if (-not $DryRun -and -not $Confirmed) {
        throw "quarantine.confirm_required: bulk $Action of $count message(s) requires explicit confirmation"
    }

    $plan = [pscustomobject]@{
        action               = $Action
        count                = $count
        cap                  = $Cap
        dryRun               = $DryRun
        requiresConfirmation = $true
        messages             = @($Messages)
    }
    if ($DryRun) {
        return $plan
    }

    $results = [System.Collections.Generic.List[object]]::new()
    $auditEvents = [System.Collections.Generic.List[object]]::new()
    # Invoke-QuarantineAction also names its audit seam parameter $WriteAudit, so
    # capture ours under a distinct name; the nested scriptblock runs in its scope.
    $forwardAudit = $WriteAudit
    foreach ($entry in @($Messages)) {
        $messageId = [string]$entry.messageId
        $recipient = [string]$entry.recipient
        $senderAddress = [string]$entry.sender
        $subject = [string]$entry.subject
        $auditRecipient = $(if ($Action -eq 'releaseAll') { $null } else { $recipient })
        try {
            $invokeParams = @{
                TenantId      = $TenantId
                MessageId     = $messageId
                Action        = $Action
                Recipient     = $recipient
                SenderAddress = $senderAddress
                Subject       = $subject
                Confirmed     = $true
                Actor         = $Actor
                CorrelationId = $CorrelationId
                WriteAudit    = {
                    param($AuditEvent)
                    $auditEvents.Add($AuditEvent)
                    if ($forwardAudit) { & $forwardAudit $AuditEvent }
                }
            }
            $item = Invoke-QuarantineAction @invokeParams
            # Invoke-QuarantineAction reports an apply failure as a returned record
            # rather than a throw; only a thrown validation error reaches the catch.
            $itemFailed = ($null -ne $item -and $null -ne $item.PSObject.Properties['status'] -and $item.status -eq 'failed')
            $results.Add([pscustomobject]@{
                messageId = $messageId
                recipient = $auditRecipient
                status    = $(if ($itemFailed) { 'failed' } else { 'succeeded' })
                result    = $item
                error     = $(if ($itemFailed) { $item.error } else { $null })
            })
        }
        catch {
            $results.Add([pscustomobject]@{
                messageId = $messageId
                recipient = $auditRecipient
                status    = 'failed'
                error     = $_.Exception.Message
            })
        }
    }

    $failed = @($results | Where-Object { $_.status -eq 'failed' }).Count
    return [pscustomobject]@{
        success     = ($failed -eq 0)
        action      = $Action
        count       = $count
        cap         = $Cap
        failedCount = $failed
        results     = @($results)
        auditEvents = @($auditEvents)
    }
}

function Read-QuarantineBulkJob {
    <#
    .SYNOPSIS
        Reads a bulk quarantine job envelope into Invoke-QuarantineBulk parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        action, the planned messages, and the confirmation/dry-run flags. The
        envelope carries references only; secrets are never present and never
        needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-QuarantineBulkJob -Path './run/quarantine-bulk-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Quarantine bulk job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Quarantine bulk job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Quarantine bulk job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $action = [string]$payload['action']
    if ([string]::IsNullOrWhiteSpace($action)) {
        throw 'Quarantine bulk job is missing required field: payload.action'
    }

    $messages = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in @($payload['messages'])) {
        if ($null -ne $entry) {
            $messages.Add($entry)
        }
    }
    if ($messages.Count -eq 0) {
        throw 'Quarantine bulk job is missing required field: payload.messages'
    }

    return @{
        TenantId      = $tenantId
        Action        = $action
        Messages      = @($messages)
        Cap           = [int]$payload['cap']
        DryRun        = ($payload['dryRun'] -eq $true)
        Confirmed     = ($payload['confirm'] -eq $true)
        Actor         = [string]$payload['actor']
        CorrelationId = [string]$job['correlationId']
    }
}
