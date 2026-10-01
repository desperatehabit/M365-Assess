# Invoke-AlertAction.ps1 — EPIC-028 alert triage actions worker (SPEC §2 US-4,
# §3.3, §4.1, §6, §7, §8, §11 item 1; T-0548).
#
# Executes one triage action against a Microsoft Graph security alert
# (security/alerts_v2): status, assign, comment, or create-incident. Per SPEC
# §11 item 1 (adopted), a field writes back only where the Graph/Defender API
# supports it: alerts_v2 accepts PATCH of status, assignedTo, and comments, so
# those three write back. create-incident is a Graph write only for sources
# that support promotion (Defender and MDO); for any other source it is refused
# with alerts.unsupported_action before any write is issued.
#
# Gating (EPIC-006 contract): -DryRun reports the intended change with no
# tenant write, and resolving an alert or creating an incident requires
# -Confirmed so a change can never silently auto-resolve or open an incident;
# the check is re-run here so a job that skips confirmation cannot apply.
# Every applied or failed action emits one audit record through -WriteAudit
# with from/to/by/reason. The Graph session is connected by the supervisor
# after materializing the tenant credential in-process; this file never
# touches secrets.

. (Join-Path -Path $PSScriptRoot -ChildPath 'Get-Alerts.ps1')

function Get-AlertActions {
    <#
    .SYNOPSIS
        Returns the triage action set this worker dispatches.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('status', 'assign', 'comment', 'create-incident')
}

function Get-AlertActionWriteBackActions {
    <#
    .SYNOPSIS
        Returns the actions whose field the Graph alerts_v2 API supports.
    .DESCRIPTION
        alerts_v2 accepts PATCH of status, assignedTo, and comments. create-incident
        is a separate Graph write and is source-gated instead.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('status', 'assign', 'comment')
}

function Get-AlertCreateIncidentSources {
    <#
    .SYNOPSIS
        Returns the alert sources that support promoting an alert to an incident.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('defender', 'mdo')
}

function Test-AlertActionSupported {
    <#
    .SYNOPSIS
        Reports whether an action is supported for an alert's source.
    .DESCRIPTION
        create-incident appears only for Defender/MDO alerts; every other action
        is supported for every source.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Source,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Action
    )

    if ($Action -ne 'create-incident') { return $true }
    return (Get-AlertCreateIncidentSources) -contains $Source
}

$script:AlertActionStatusByKey = @{
    'new'        = 'new'
    'inprogress' = 'inProgress'
    'resolved'   = 'resolved'
}

function ConvertTo-AlertActionStatus {
    <#
    .SYNOPSIS
        Maps a requested status onto the Graph alerts_v2 status vocabulary.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Value
    )

    $key = ConvertTo-AlertKey -Value $Value
    if ($script:AlertActionStatusByKey.ContainsKey($key)) {
        return $script:AlertActionStatusByKey[$key]
    }
    throw "alerts.unknown_value: unknown status '$Value'; expected one of: new, inProgress, resolved"
}

function ConvertTo-AlertActionAssignee {
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

function Get-AlertActionState {
    <#
    .SYNOPSIS
        Reads the current alert state for before/after capture.
    .DESCRIPTION
        GETs the live alert and shapes the triage comparison fields. A missing
        or unreadable alert returns null so the caller can fail the action with
        a clear error. Only GET requests are issued.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$AlertId
    )

    try {
        $alert = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/security/alerts_v2/$AlertId"
    }
    catch {
        return $null
    }
    if ($null -eq $alert -or [string](Get-AlertPropertyValue -Object $alert -Names @('id')) -eq '') {
        return $null
    }

    $comments = @()
    if ($null -ne $alert.comments) {
        $comments = @($alert.comments)
    }

    return @{
        status     = ConvertTo-AlertStatus -Value $alert.status
        assignedTo = ConvertTo-AlertActionAssignee -Value $alert.assignedTo
        source     = ConvertTo-AlertSource -Value (Get-AlertRawSource -Entry $alert)
        severity   = ConvertTo-AlertSeverity -Value $alert.severity
        comments   = $comments
    }
}

function Get-AlertActionFromValue {
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
        'assign' { return [string]$State.assignedTo }
        default { return '' }
    }
}

function Invoke-AlertAction {
    <#
    .SYNOPSIS
        Executes one alert triage action live against Graph.
    .DESCRIPTION
        Dispatches status, assign, comment, or create-incident. status, assign,
        and comment write back through PATCH where alerts_v2 supports them;
        create-incident writes through POST /security/incidents and is refused
        with alerts.unsupported_action for sources that do not support it.
        -DryRun returns the intended change with no tenant write. Resolving an
        alert or creating an incident requires -Confirmed. Returns an
        applied/planned/failed result with from/to, before/after, and the
        created incident id for create-incident. Apply failures are returned,
        not thrown; unknown actions, unknown values, unsupported actions, and
        missing confirmation throw.
    .PARAMETER TenantId
        Tenant the alert belongs to. Carried through to the result envelope.
    .PARAMETER AlertId
        The target Graph security alert id.
    .PARAMETER Action
        One of the Get-AlertActions names.
    .PARAMETER Value
        The new status, assignee, or incident title. Required for status,
        assign, and create-incident.
    .PARAMETER Comment
        The comment body. Required for comment.
    .PARAMETER Reason
        The triage reason recorded on the audit event and state change.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation; mandatory when the action resolves the alert or
        creates an incident.
    .PARAMETER Actor
        Caller identity recorded on the audit event and note.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-AlertAction -TenantId 'tenant-a' -AlertId 'alert-1' -Action 'status' -Value 'resolved' -Confirmed -Reason 'Handled'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$AlertId,

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

    $known = Get-AlertActions
    if (-not $known.Contains($Action)) {
        throw "alerts.unknown_action: unknown alert action '$Action'; expected one of: $($known -join ', ')"
    }

    $writeBack = $Action -in @(Get-AlertActionWriteBackActions)
    $normalized = ''
    switch ($Action) {
        'status' {
            if ([string]::IsNullOrWhiteSpace($Value)) {
                throw 'alerts.value_required: status requires a value of new, inProgress, or resolved'
            }
            $normalized = ConvertTo-AlertActionStatus -Value $Value
            if ($normalized -eq 'resolved' -and -not $DryRun -and -not $Confirmed) {
                throw 'alerts.confirm_required: resolving an alert requires explicit confirmation'
            }
        }
        'assign' {
            if ([string]::IsNullOrWhiteSpace($Value)) {
                throw 'alerts.value_required: assign requires an assignee value'
            }
            $normalized = $Value.Trim()
        }
        'comment' {
            if ([string]::IsNullOrWhiteSpace($Comment)) {
                throw 'alerts.comment_required: comment requires a body'
            }
        }
        'create-incident' {
            if ([string]::IsNullOrWhiteSpace($Value)) {
                throw 'alerts.value_required: create-incident requires an incident title'
            }
            if (-not $DryRun -and -not $Confirmed) {
                throw 'alerts.confirm_required: creating an incident requires explicit confirmation'
            }
        }
    }

    $before = Get-AlertActionState -AlertId $AlertId
    if ($null -eq $before) {
        return [pscustomobject]@{
            tenantId   = $TenantId
            alertId    = $AlertId
            action     = $Action
            status     = 'failed'
            writeBack  = $false
            from       = ''
            to         = $normalized
            before     = $null
            after      = $null
            note       = $null
            incidentId = $null
            error      = "alert '$AlertId' was not found in tenant '$TenantId'"
        }
    }

    if (-not (Test-AlertActionSupported -Source $before.source -Action $Action)) {
        throw "alerts.unsupported_action: action '$Action' is not supported for source '$($before.source)'"
    }

    $from = Get-AlertActionFromValue -Action $Action -State $before
    $note = $null
    if ($Action -eq 'comment') {
        $note = @{ body = $Comment.Trim(); author = $Actor }
    }

    if ($DryRun) {
        return [pscustomobject]@{
            tenantId   = $TenantId
            alertId    = $AlertId
            action     = $Action
            status     = 'planned'
            writeBack  = $writeBack
            from       = $from
            to         = $normalized
            before     = $before
            after      = $null
            note       = $note
            incidentId = $null
            error      = $null
        }
    }

    $createdIncidentId = $null
    try {
        switch ($Action) {
            'status' {
                $body = @{ status = $normalized }
                $null = Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/security/alerts_v2/$AlertId" -Body ($body | ConvertTo-Json -Depth 5)
            }
            'assign' {
                $body = @{ assignedTo = $normalized }
                $null = Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/security/alerts_v2/$AlertId" -Body ($body | ConvertTo-Json -Depth 5)
            }
            'comment' {
                $comments = @($before.comments) + $Comment.Trim()
                $body = @{ comments = @($comments) }
                $null = Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/security/alerts_v2/$AlertId" -Body ($body | ConvertTo-Json -Depth 5)
            }
            'create-incident' {
                $body = @{
                    displayName    = $normalized
                    severity       = $before.severity
                    status         = 'active'
                    classification = 'unknown'
                    alerts         = @(@{ id = $AlertId })
                }
                $created = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/security/incidents' -Body ($body | ConvertTo-Json -Depth 5)
                if ($null -ne $created -and $created.id) {
                    $createdIncidentId = [string]$created.id
                }
            }
        }
    }
    catch {
        $message = $_.Exception.Message
        $null = & $WriteAudit @{
            tenantId      = $TenantId
            action        = "alerts.action:$Action"
            alertId       = $AlertId
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
            tenantId   = $TenantId
            alertId    = $AlertId
            action     = $Action
            status     = 'failed'
            writeBack  = $false
            from       = $from
            to         = $normalized
            before     = $before
            after      = $null
            note       = $note
            incidentId = $null
            error      = $message
        }
    }

    $after = $before
    if ($writeBack) {
        $after = Get-AlertActionState -AlertId $AlertId
        if ($null -eq $after) {
            $after = $before
        }
    }

    $null = & $WriteAudit @{
        tenantId      = $TenantId
        action        = "alerts.action:$Action"
        alertId       = $AlertId
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
        tenantId   = $TenantId
        alertId    = $AlertId
        action     = $Action
        status     = 'applied'
        writeBack  = $writeBack
        from       = $from
        to         = $normalized
        before     = $before
        after      = $after
        note       = $note
        incidentId = $createdIncidentId
        error      = $null
    }
}

function Read-AlertActionJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-AlertAction parameters.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Alert action job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Alert action job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Alert action job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $alertId = [string]$payload['alertId']
    if ([string]::IsNullOrWhiteSpace($alertId)) {
        throw 'Alert action job is missing required field: payload.alertId'
    }
    $action = [string]$payload['action']
    if ([string]::IsNullOrWhiteSpace($action)) {
        throw 'Alert action job is missing required field: payload.action'
    }

    return @{
        TenantId      = $tenantId
        AlertId       = $alertId
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
