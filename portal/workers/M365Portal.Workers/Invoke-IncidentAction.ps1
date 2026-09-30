# Invoke-IncidentAction.ps1 — EPIC-028 incident triage actions worker (SPEC §2 US-3,
# §4.1, §6, §7, §8, §9, §11 item 1; T-0546).
#
# Executes one triage action against a Graph security incident: assign, status,
# classify, or comment. Per SPEC §11 item 1 (adopted), status and classification
# write back to the tenant through PATCH /v1.0/security/incidents/{id} where the
# Graph API supports those fields; assignee and comments are portal-only and
# persist as state changes and notes (T-0541) — the worker reports them so the
# BFF can persist them, and never issues a Graph write for them.
#
# Gating (EPIC-006 contract): -DryRun reports the intended change with no
# tenant write, and resolving an incident (status → resolved) requires
# -Confirmed so a change can never silently auto-resolve; the check is re-run
# here so a job that skips confirmation cannot apply. Every applied or failed
# action emits one audit record through -WriteAudit with from/to/by/reason.
# The Graph session is connected by the supervisor after materializing the
# tenant credential in-process; this file never touches secrets.

. (Join-Path -Path $PSScriptRoot -ChildPath 'Get-IncidentDetail.ps1')

function Get-IncidentActions {
    <#
    .SYNOPSIS
        Returns the triage action set this worker dispatches.
    .DESCRIPTION
        The single source of truth for valid action names. Anything else is
        refused with incidents.unknown_action.
    .EXAMPLE
        Get-IncidentActions
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('assign', 'status', 'classify', 'comment')
}

function Get-IncidentActionWriteBackActions {
    <#
    .SYNOPSIS
        Returns the triage actions whose field the Graph API supports for write-back.
    .DESCRIPTION
        SPEC §11 item 1 (adopted): only status and classification write back
        where the Graph/Defender API supports them. Assignee and comments are
        read-only here and persist portal-side.
    .EXAMPLE
        Get-IncidentActionWriteBackActions
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('status', 'classify')
}

function Get-IncidentActionConfirmation {
    <#
    .SYNOPSIS
        Returns the action values that require explicit confirmation.
    .DESCRIPTION
        Resolving an incident hides it from open-incident views, so a status
        change to resolved always requires confirmation — a triage change can
        never silently auto-resolve (SPEC §9).
    .EXAMPLE
        Get-IncidentActionConfirmation
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('resolved')
}

$script:IncidentActionStatusByKey = @{
    'active'     = 'active'
    'redirected' = 'redirected'
    'resolved'   = 'resolved'
}

$script:IncidentActionClassificationByKey = @{
    'truepositive'                 = 'truePositive'
    'falsepositive'                = 'falsePositive'
    'informationalexpectedactivity' = 'informationalExpectedActivity'
    'benignpositive'               = 'benignPositive'
}

function ConvertTo-IncidentActionStatus {
    <#
    .SYNOPSIS
        Maps a requested status onto the Graph incident status vocabulary.
    .DESCRIPTION
        Accepts the Graph-supported incident status values case-insensitively
        and returns the canonical casing for the write-back body. Unknown
        values are refused rather than silently coerced.
    .PARAMETER Value
        The requested status.
    .EXAMPLE
        ConvertTo-IncidentActionStatus -Value 'Resolved'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Value
    )

    $key = $Value.Trim().ToLowerInvariant()
    if ($script:IncidentActionStatusByKey.ContainsKey($key)) {
        return $script:IncidentActionStatusByKey[$key]
    }
    throw "incidents.unknown_value: unknown status '$Value'; expected one of: active, redirected, resolved"
}

function ConvertTo-IncidentActionClassification {
    <#
    .SYNOPSIS
        Maps a requested classification onto the Graph classification vocabulary.
    .DESCRIPTION
        Accepts the Graph-supported incident classification values
        case-insensitively and returns the canonical casing for the write-back
        body. Unknown values are refused rather than silently coerced.
    .PARAMETER Value
        The requested classification.
    .EXAMPLE
        ConvertTo-IncidentActionClassification -Value 'falsePositive'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Value
    )

    $key = $Value.Trim().ToLowerInvariant()
    if ($script:IncidentActionClassificationByKey.ContainsKey($key)) {
        return $script:IncidentActionClassificationByKey[$key]
    }
    throw "incidents.unknown_value: unknown classification '$Value'; expected one of: truePositive, falsePositive, informationalExpectedActivity, benignPositive"
}

function ConvertTo-IncidentActionStateValue {
    <#
    .SYNOPSIS
        Normalizes a live incident status/classification value for before/after.
    .DESCRIPTION
        Unmappable values fall back to 'unknown' rather than silently coercing
        to an empty state, matching the Get-Incidents normalization.
    .PARAMETER Value
        The raw Graph value.
    .EXAMPLE
        ConvertTo-IncidentActionStateValue -Value 'Active'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [AllowNull()]
        [object]$Value
    )

    if ($Value -is [string] -and -not [string]::IsNullOrWhiteSpace($Value)) {
        $key = $Value.Trim().ToLowerInvariant()
        if ($script:IncidentActionStatusByKey.ContainsKey($key)) {
            return $script:IncidentActionStatusByKey[$key]
        }
        if ($script:IncidentActionClassificationByKey.ContainsKey($key)) {
            return $script:IncidentActionClassificationByKey[$key]
        }
    }
    return 'unknown'
}

function ConvertTo-IncidentActionAssignee {
    <#
    .SYNOPSIS
        Normalizes the live incident assignee for before/after capture.
    .PARAMETER Value
        The raw Graph assignedTo value (a UPN string or null).
    .EXAMPLE
        ConvertTo-IncidentActionAssignee -Value 'analyst-a'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [AllowNull()]
        [object]$Value
    )

    if ($Value -is [string] -and -not [string]::IsNullOrWhiteSpace($Value)) {
        return $Value.Trim()
    }
    return ''
}

function Get-IncidentActionState {
    <#
    .SYNOPSIS
        Reads the current incident state for before/after capture.
    .DESCRIPTION
        GETs the live incident and shapes the triage comparison fields. A
        missing or unreadable incident returns null so the caller can fail
        the action with a clear error. Only GET requests are issued.
    .PARAMETER IncidentId
        The Graph security incident id.
    .EXAMPLE
        Get-IncidentActionState -IncidentId 'incident-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$IncidentId
    )

    try {
        $incident = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/security/incidents/$IncidentId"
    }
    catch {
        return $null
    }
    if ($null -eq $incident -or [string](Get-IncidentDetailProperty -Object $incident -Name 'id') -eq '') {
        return $null
    }
    return [pscustomobject]@{
        status         = ConvertTo-IncidentActionStateValue -Value (Get-IncidentDetailProperty -Object $incident -Name 'status')
        classification = ConvertTo-IncidentActionStateValue -Value (Get-IncidentDetailProperty -Object $incident -Name 'classification')
        assignedTo     = ConvertTo-IncidentActionAssignee -Value (Get-IncidentDetailProperty -Object $incident -Name 'assignedTo')
    }
}

function Get-IncidentActionFromValue {
    <#
    .SYNOPSIS
        Picks the before value for the field an action changes.
    .PARAMETER Action
        The triage action.
    .PARAMETER State
        The captured before state.
    .EXAMPLE
        Get-IncidentActionFromValue -Action 'status' -State $before
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Action,

        [Parameter(Mandatory)]
        [AllowNull()]
        [object]$State
    )

    if ($null -eq $State) {
        return ''
    }
    switch ($Action) {
        'status' { return [string]$State.status }
        'classify' { return [string]$State.classification }
        'assign' { return [string]$State.assignedTo }
        default { return '' }
    }
}

function Invoke-IncidentAction {
    <#
    .SYNOPSIS
        Executes one incident triage action live against Graph.
    .DESCRIPTION
        Dispatches assign, status, classify, or comment. Status and
        classification write back through PATCH where the Graph API supports
        them (SPEC §11 item 1); assignee and comments are portal-only and
        persist as state changes and notes (T-0541) — no Graph write is issued
        for them. -DryRun returns the intended change with no tenant write.
        Resolving an incident requires -Confirmed so a change can never
        silently auto-resolve. Returns an applied/planned/failed result with
        from/to, before/after, and (for comments) the note to persist. Apply
        failures are returned, not thrown; unknown actions, unknown values,
        and missing confirmation throw.
    .PARAMETER TenantId
        Tenant the incident belongs to. Carried through to the result envelope.
    .PARAMETER IncidentId
        The target Graph security incident id.
    .PARAMETER Action
        One of the Get-IncidentActions names.
    .PARAMETER Value
        The new status, classification, or assignee. Required for assign,
        status, and classify; refused when empty.
    .PARAMETER Comment
        The comment body. Required for comment; refused when empty.
    .PARAMETER Reason
        The triage reason recorded on the audit event and state change.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation; mandatory when the action resolves the incident.
    .PARAMETER Actor
        Caller identity recorded on the audit event and note.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-IncidentAction -TenantId 'tenant-a' -IncidentId 'incident-1' -Action 'status' -Value 'resolved' -Confirmed -Reason 'Handled'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$IncidentId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Action,

        [Parameter()]
        [string]$Value = '',

        [Parameter()]
        [string]$Comment = '',

        [Parameter()]
        [string]$Reason = '',

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [switch]$Confirmed,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    $known = Get-IncidentActions
    if (-not $known.Contains($Action)) {
        throw "incidents.unknown_action: unknown incident action '$Action'; expected one of: $($known -join ', ')"
    }

    $writeBack = $Action -in @(Get-IncidentActionWriteBackActions)
    $normalized = ''
    switch ($Action) {
        'status' {
            if ([string]::IsNullOrWhiteSpace($Value)) {
                throw 'incidents.value_required: status requires a value of active, redirected, or resolved'
            }
            $normalized = ConvertTo-IncidentActionStatus -Value $Value
            if ((Get-IncidentActionConfirmation).Contains($normalized) -and -not $DryRun -and -not $Confirmed) {
                throw "incidents.confirm_required: resolving an incident requires explicit confirmation"
            }
        }
        'classify' {
            if ([string]::IsNullOrWhiteSpace($Value)) {
                throw "incidents.value_required: classify requires a value of truePositive, falsePositive, informationalExpectedActivity, or benignPositive"
            }
            $normalized = ConvertTo-IncidentActionClassification -Value $Value
        }
        'assign' {
            if ([string]::IsNullOrWhiteSpace($Value)) {
                throw 'incidents.value_required: assign requires an assignee value'
            }
            $normalized = $Value.Trim()
        }
        'comment' {
            if ([string]::IsNullOrWhiteSpace($Comment)) {
                throw 'incidents.comment_required: comment requires a body'
            }
        }
    }

    $before = Get-IncidentActionState -IncidentId $IncidentId
    if ($null -eq $before) {
        return [pscustomobject]@{
            tenantId    = $TenantId
            incidentId  = $IncidentId
            action      = $Action
            status      = 'failed'
            writeBack   = $false
            from        = ''
            to          = $normalized
            before      = $null
            after       = $null
            note        = $null
            error       = "incident '$IncidentId' was not found in tenant '$TenantId'"
        }
    }

    $from = Get-IncidentActionFromValue -Action $Action -State $before
    $note = $null
    if ($Action -eq 'comment') {
        $note = @{ body = $Comment.Trim(); author = $Actor }
    }

    if ($DryRun) {
        return [pscustomobject]@{
            tenantId    = $TenantId
            incidentId  = $IncidentId
            action      = $Action
            status      = 'planned'
            writeBack   = $writeBack
            from        = $from
            to          = $normalized
            before      = $before
            after       = $null
            note        = $note
            error       = $null
        }
    }

    try {
        if ($Action -eq 'status') {
            $body = @{ status = $normalized }
            $null = Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/security/incidents/$IncidentId" -Body ($body | ConvertTo-Json -Depth 5)
        }
        elseif ($Action -eq 'classify') {
            $body = @{ classification = $normalized }
            $null = Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/security/incidents/$IncidentId" -Body ($body | ConvertTo-Json -Depth 5)
        }
    }
    catch {
        $message = $_.Exception.Message
        $null = & $WriteAudit @{
            tenantId      = $TenantId
            action        = "incidents.action:$Action"
            incidentId    = $IncidentId
            result        = 'failure'
            from          = $from
            to            = $normalized
            before        = $before
            after         = $null
            actor         = $Actor
            reason        = $Reason
            correlationId = $CorrelationId
        }
        return [pscustomobject]@{
            tenantId    = $TenantId
            incidentId  = $IncidentId
            action      = $Action
            status      = 'failed'
            writeBack   = $false
            from        = $from
            to          = $normalized
            before      = $before
            after       = $null
            note        = $note
            error       = $message
        }
    }

    $after = $before
    if ($writeBack) {
        $after = Get-IncidentActionState -IncidentId $IncidentId
        if ($null -eq $after) {
            $after = $before
        }
    }

    $null = & $WriteAudit @{
        tenantId      = $TenantId
        action        = "incidents.action:$Action"
        incidentId    = $IncidentId
        result        = 'success'
        from          = $from
        to            = $normalized
        before        = $before
        after         = $after
        actor         = $Actor
        reason        = $Reason
        correlationId = $CorrelationId
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        incidentId  = $IncidentId
        action      = $Action
        status      = 'applied'
        writeBack   = $writeBack
        from        = $from
        to          = $normalized
        before      = $before
        after       = $after
        note        = $note
        error       = $null
    }
}

function Read-IncidentActionJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-IncidentAction parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        incident id, action, payload values, and confirmation flags. The
        envelope carries references only; no secret material is present.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-IncidentActionJob -Path './run/incident-action-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Incident action job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Incident action job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Incident action job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $incidentId = [string]$payload['incidentId']
    if ([string]::IsNullOrWhiteSpace($incidentId)) {
        throw 'Incident action job is missing required field: payload.incidentId'
    }
    $action = [string]$payload['action']
    if ([string]::IsNullOrWhiteSpace($action)) {
        throw 'Incident action job is missing required field: payload.action'
    }

    return @{
        TenantId      = $tenantId
        IncidentId    = $incidentId
        Action        = $action
        Value         = [string]$payload['value']
        Comment       = [string]$payload['comment']
        Reason        = [string]$payload['reason']
        DryRun        = $payload['dryRun'] -eq $true
        Confirmed     = $payload['confirm'] -eq $true
        Actor         = [string]$payload['actor']
        CorrelationId = [string]$job['correlationId']
    }
}
