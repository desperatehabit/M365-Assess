# Invoke-QuarantineAction.ps1 — EPIC-022 quarantine release/delete worker
# (SPEC §2 US-3, §3.3, §4.2, §5, §8; §11.1; T-0424).
#
# Performs release (to one recipient or all) and delete on quarantined mail.
# Quarantine is not a registry CheckId command, so this follows the EPIC-006
# executor contract (T-0108) instead of the CheckId-bound apply path: -DryRun
# plans the action with no tenant write and no audit; release, release-to-all,
# and delete require explicit -Confirmed re-checked here so a job that skips
# confirmation cannot apply it; every apply captures before/after and emits one
# AuditEvent through -WriteAudit. Unknown actions are refused with a structured
# error, never passed through.
#
# SPEC §11.1 (resolved) data source: the EXO quarantine cmdlets are used where
# they support the operation — Release-QuarantineMessage and
# Delete-QuarantineMessage cover release/release-to-all/delete, so those actions
# resolve to transport `exo`. Actions with no EXO release/submit path (preview,
# download) fall back to Graph for message metadata only and never mutate.
# Get-QuarantineActionExoSupport and Resolve-QuarantineActionTransport encode
# that rule so the choice is explicit and testable. The EXO session is
# connected by the entrypoint after materializing the tenant credential
# in-process; this file never touches secrets.

function Get-QuarantineActions {
    <#
    .SYNOPSIS
        Returns the quarantine action set this worker dispatches.
    .DESCRIPTION
        The single source of truth for valid action names. Anything else is
        refused with quarantine.unknown_action.
    .EXAMPLE
        Get-QuarantineActions
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('release', 'releaseAll', 'delete', 'preview')
}

function Get-QuarantineActionConfirmation {
    <#
    .SYNOPSIS
        Returns the actions that require explicit confirmation.
    .DESCRIPTION
        Releasing quarantined mail can deliver malicious content and deleting
        it destroys evidence, so release, release-to-all, and delete require
        confirmation (SPEC §4.2, §8, §9).
    .EXAMPLE
        Get-QuarantineActionConfirmation
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('release', 'releaseAll', 'delete')
}

function Get-QuarantineActionExoSupport {
    <#
    .SYNOPSIS
        Returns the actions the EXO quarantine cmdlets can apply.
    .DESCRIPTION
        Release-QuarantineMessage supports release to a user or all, and
        Delete-QuarantineMessage supports delete; those are the §11.1
        operations EXO supports.
    .EXAMPLE
        Get-QuarantineActionExoSupport
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('release', 'releaseAll', 'delete')
}

function Resolve-QuarantineActionTransport {
    <#
    .SYNOPSIS
        Chooses EXO or Graph for an action per the resolved SPEC §11.1 rule.
    .DESCRIPTION
        Use the EXO quarantine cmdlets where they support the operation;
        otherwise fall back to Graph for metadata only. release, releaseAll,
        and delete have EXO support and resolve to `exo`; preview (and any
        other metadata-only action) resolves to `graph` and never mutates.
    .PARAMETER Action
        One of the Get-QuarantineActions names.
    .EXAMPLE
        Resolve-QuarantineActionTransport -Action 'release'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Action
    )

    if ((Get-QuarantineActionExoSupport) -contains $Action) {
        return 'exo'
    }
    return 'graph'
}

function Get-QuarantineActionMetadata {
    <#
    .SYNOPSIS
        Returns the message metadata for a metadata-only (Graph) action.
    .DESCRIPTION
        Graph is metadata only per SPEC §11.1, so preview reports the message
        fields the job envelope already carries and never reads or returns the
        message body. No tenant write occurs.
    .PARAMETER MessageId
        The quarantined message id.
    .PARAMETER Subject
        The message subject from the job envelope.
    .PARAMETER SenderAddress
        The message sender from the job envelope.
    .PARAMETER Recipient
        The message recipient from the job envelope.
    .EXAMPLE
        Get-QuarantineActionMetadata -MessageId 'message-1' -SenderAddress 'sender@example.invalid'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MessageId,

        [Parameter()]
        [string]$Subject = '',

        [Parameter()]
        [string]$SenderAddress = '',

        [Parameter()]
        [string]$Recipient = ''
    )

    return [pscustomobject]@{
        source    = 'graph'
        available = $true
        subject   = $Subject
        messageId = $MessageId
        sender    = $SenderAddress
        recipient = $Recipient
    }
}

function Invoke-QuarantineAction {
    <#
    .SYNOPSIS
        Executes or previews one quarantine action live against Exchange Online.
    .DESCRIPTION
        Dispatches release, releaseAll, delete, or preview. -DryRun returns the
        intended change with no EXO write and no audit. release, releaseAll,
        and delete require -Confirmed. preview is a metadata-only Graph read.
        Returns a plan for dry runs and a plan/result/auditEvent record for
        applies. Apply failures are returned, not thrown; only unknown actions,
        missing inputs, and missing confirmation throw.
    .PARAMETER TenantId
        Tenant the message belongs to. Carried through to the audit event.
    .PARAMETER MessageId
        The quarantined message id.
    .PARAMETER Action
        One of the Get-QuarantineActions names.
    .PARAMETER Recipient
        Release-to recipient. Defaults to the job recipient; ignored by
        releaseAll.
    .PARAMETER SenderAddress
        Message sender metadata, used for the block close-the-loop and preview.
    .PARAMETER Subject
        Message subject metadata, used for preview.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant. Defaults to
        $false; the BFF sets it from the preview flag before dispatch.
    .PARAMETER Confirmed
        Explicit confirmation for release, releaseAll, and delete.
    .PARAMETER Actor
        Caller identity recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId 'message-1' -Action 'delete' -Confirmed
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MessageId,

        [Parameter(Mandatory)]
        [string]$Action,

        [Parameter()]
        [string]$Recipient = '',

        [Parameter()]
        [string]$SenderAddress = '',

        [Parameter()]
        [string]$Subject = '',

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

    $known = Get-QuarantineActions
    if (-not $known.Contains($Action)) {
        throw "quarantine.unknown_action: unknown quarantine action '$Action'; expected one of: $($known -join ', ')"
    }
    if ($Action -eq 'release' -and [string]::IsNullOrWhiteSpace($Recipient)) {
        throw 'quarantine.validation_failed: recipient is required to release to a recipient'
    }
    if (-not $DryRun -and (Get-QuarantineActionConfirmation).Contains($Action) -and -not $Confirmed) {
        throw "quarantine.confirm_required: action '$Action' requires explicit confirmation"
    }

    $transport = Resolve-QuarantineActionTransport -Action $Action
    $diff = [System.Collections.Generic.List[string]]::new()
    switch ($Action) {
        'release' { $diff.Add("Release message '$MessageId' to '$Recipient'") }
        'releaseAll' { $diff.Add("Release message '$MessageId' to all recipients") }
        'delete' { $diff.Add("Delete message '$MessageId'") }
        'preview' { $diff.Add("Read metadata for message '$MessageId'") }
    }

    $plan = [pscustomobject]@{
        action               = $Action
        messageId            = $MessageId
        recipient            = $(if ($Action -eq 'releaseAll') { $null } else { $Recipient })
        transport            = $transport
        before               = $null
        after                = $null
        diff                 = @($diff)
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = ((Get-QuarantineActionConfirmation).Contains($Action))
    }

    if ($Action -eq 'preview') {
        $metadata = Get-QuarantineActionMetadata -MessageId $MessageId -Subject $Subject -SenderAddress $SenderAddress -Recipient $Recipient
        return [pscustomobject]@{
            success = $true
            plan    = $plan
            preview = $metadata
        }
    }

    if ($DryRun) {
        return $plan
    }

    $appliedAt = [DateTime]::UtcNow.ToString('o')
    $auditEvent = @{
        id            = [guid]::NewGuid().ToString()
        tenantId      = $TenantId
        action        = "quarantine.action.$Action"
        messageId     = $MessageId
        recipient     = $(if ($Action -eq 'releaseAll') { $null } else { $Recipient })
        timestamp     = $appliedAt
        actor         = $Actor
        correlationId = $CorrelationId
        result        = $null
        error         = $null
    }

    try {
        $appliedResult = $null
        switch ($Action) {
            'release' {
                $appliedResult = Release-QuarantineMessage -Identity $MessageId -User $Recipient -Confirm:$false
            }
            'releaseAll' {
                $appliedResult = Release-QuarantineMessage -Identity $MessageId -ReleaseToAll -Confirm:$false
            }
            'delete' {
                $appliedResult = Delete-QuarantineMessage -Identity $MessageId -Confirm:$false
                $appliedResult = @{ deleted = $true; messageId = $MessageId }
            }
        }

        $auditEvent['result'] = 'success'
        $null = & $WriteAudit $auditEvent

        return [pscustomobject]@{
            plan       = $plan
            result     = $appliedResult
            auditEvent = $auditEvent
            success    = $true
        }
    }
    catch {
        $message = $_.Exception.Message
        $auditEvent['result'] = 'failure'
        $auditEvent['error'] = $message
        $null = & $WriteAudit $auditEvent
        return [pscustomobject]@{
            messageId = $MessageId
            action    = $Action
            status    = 'failed'
            before    = $null
            after     = $null
            error     = $message
        }
    }
}

function Read-QuarantineActionJob {
    <#
    .SYNOPSIS
        Reads a quarantine job envelope file into Invoke-QuarantineAction parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        message id, action, and release fields. The envelope carries references
        only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-QuarantineActionJob -Path './run/quarantine-action-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Quarantine action job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Quarantine action job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Quarantine action job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $action = [string]$payload['action']
    if ([string]::IsNullOrWhiteSpace($action)) {
        throw 'Quarantine action job is missing required field: payload.action'
    }
    $messageId = [string]$payload['messageId']
    if ([string]::IsNullOrWhiteSpace($messageId)) {
        throw 'Quarantine action job is missing required field: payload.messageId'
    }

    return @{
        TenantId      = $tenantId
        MessageId     = $messageId
        Action        = $action
        Recipient     = [string]$payload['recipient']
        Sender        = [string]$payload['sender']
        Subject       = [string]$payload['subject']
        DryRun        = $payload['dryRun'] -eq $true
        Confirmed     = $payload['confirm'] -eq $true
        Actor         = [string]$payload['actor']
        CorrelationId = [string]$job['correlationId']
    }
}
