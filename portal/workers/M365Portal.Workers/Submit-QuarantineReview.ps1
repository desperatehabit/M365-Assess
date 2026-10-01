# Submit-QuarantineReview.ps1 — EPIC-022 quarantine submit-for-review worker
# (SPEC §2 US-4, §3.3, §4.2 step 4, §5, §6, §8; resolved §11.1; T-0426).
#
# Submits a quarantined message to Microsoft for review and tracks its state.
# Per resolved §11.1 the EXO quarantine cmdlets are used where they support the
# operation and Graph otherwise: the message content is read with the EXO
# Export-QuarantineMessage cmdlet, and the submission and its status go to the
# Graph threat-submission API (the split CIPP uses), so export resolves to
# `exo` and submit/refresh resolve to `graph`. A new submission emits one
# AuditEvent through -WriteAudit; -Refresh reads the live submission state back
# and never writes or audits. The EXO and Graph sessions are connected by the
# entrypoint after materializing the tenant credential in-process; this file
# never touches secrets.

function Get-QuarantineSubmitStatuses {
    <#
    .SYNOPSIS
        Returns the review states this worker reports.
    .DESCRIPTION
        The canonical tracked states the BFF stores on the QuarantineAction.
        `pending` is the queued/unknown state; `inReview`, `reviewed`, and
        `rejected` mirror the live Microsoft submission state (SPEC §4.2 step 4).
    .EXAMPLE
        Get-QuarantineSubmitStatuses
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('pending', 'inReview', 'reviewed', 'released', 'rejected')
}

function Get-QuarantineSubmitCategories {
    <#
    .SYNOPSIS
        Returns the submission categories the Graph threat-submission API accepts.
    .DESCRIPTION
        The category is the reviewer's classification of the quarantined message.
        Anything else is refused before the message is exported.
    .EXAMPLE
        Get-QuarantineSubmitCategories
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('notJunk', 'spam', 'phishing', 'malware')
}

function Get-QuarantineSubmitExoSupport {
    <#
    .SYNOPSIS
        Returns the submit operations the EXO quarantine cmdlets perform.
    .DESCRIPTION
        Export-QuarantineMessage supplies the message content the submission
        needs, so `export` is the EXO-supported step. The submission and its
        status are Graph operations.
    .EXAMPLE
        Get-QuarantineSubmitExoSupport
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('export')
}

function Resolve-QuarantineSubmitTransport {
    <#
    .SYNOPSIS
        Chooses EXO or Graph for a submit operation per the resolved §11.1 rule.
    .DESCRIPTION
        Use the EXO quarantine cmdlets where they support the operation;
        otherwise Graph. Export has EXO support and resolves to `exo`; submit
        and refresh are Graph threat-submission operations and resolve to
        `graph`. Any other operation resolves to `graph` (metadata only).
    .PARAMETER Operation
        One of export, submit, or refresh.
    .EXAMPLE
        Resolve-QuarantineSubmitTransport -Operation 'submit'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Operation
    )

    if ((Get-QuarantineSubmitExoSupport) -contains $Operation) {
        return 'exo'
    }
    return 'graph'
}

function ConvertTo-QuarantineSubmitStatus {
    <#
    .SYNOPSIS
        Maps a Microsoft submission status onto a tracked review state.
    .DESCRIPTION
        The Graph threat-submission API reports a status per submission; map it
        to the tracked vocabulary so a refresh updates the QuarantineAction
        without a second vocabulary. Unknown values stay `pending`.
    .PARAMETER Value
        The raw status string from the submission API.
    .EXAMPLE
        ConvertTo-QuarantineSubmitStatus -Value 'succeeded'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [AllowEmptyString()]
        [string]$Value = ''
    )

    $map = @{
        'pending'            = 'pending'
        'notstarted'         = 'pending'
        'running'            = 'inReview'
        'inprogress'         = 'inReview'
        'inreview'           = 'inReview'
        'useractionrequired' = 'inReview'
        'succeeded'          = 'reviewed'
        'succeededwitherrors' = 'reviewed'
        'completed'          = 'reviewed'
        'reviewed'           = 'reviewed'
        'failed'             = 'rejected'
        'rejected'           = 'rejected'
    }

    $normalized = ([string]$Value).Trim().ToLowerInvariant() -replace '[^a-z0-9]', ''
    if ($map.ContainsKey($normalized)) {
        return $map[$normalized]
    }
    return 'pending'
}

function Submit-QuarantineReview {
    <#
    .SYNOPSIS
        Submits a quarantined message for review or refreshes its tracked state.
    .DESCRIPTION
        Exports the message content with the EXO quarantine cmdlet and POSTs it
        to the Graph threat-submission API, then maps the returned status onto
        the tracked vocabulary. -Refresh reads the live submission state back
        instead of re-submitting. A submission emits one AuditEvent through
        -WriteAudit; a refresh is a read and emits none. Apply failures are
        returned, not thrown; only missing inputs and an invalid category throw.
    .PARAMETER TenantId
        Tenant the message belongs to. Carried through to the audit event.
    .PARAMETER MessageId
        The quarantined message id.
    .PARAMETER Recipient
        Recipient address the submission names. Required for a new submission.
    .PARAMETER Category
        Submission category: notJunk, spam, phishing, or malware.
    .PARAMETER Refresh
        Read the live submission state instead of submitting again.
    .PARAMETER SubmissionId
        The submission to read; required with -Refresh.
    .PARAMETER Actor
        Caller identity recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Submit-QuarantineReview -TenantId 'tenant-a' -MessageId 'message-1' -Recipient 'user@example.invalid'
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

        [Parameter()]
        [string]$Recipient = '',

        [Parameter()]
        [ValidateSet('notJunk', 'spam', 'phishing', 'malware')]
        [string]$Category = 'spam',

        [Parameter()]
        [switch]$Refresh,

        [Parameter()]
        [string]$SubmissionId = '',

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    if ($Refresh) {
        if ([string]::IsNullOrWhiteSpace($SubmissionId)) {
            throw 'quarantine.validation_failed: submissionId is required to refresh a submission'
        }
        $transport = Resolve-QuarantineSubmitTransport -Operation 'refresh'
        $uri = "/beta/security/threatSubmission/emailThreats/$SubmissionId"
        $live = Invoke-MgGraphRequest -Method GET -Uri $uri
        return [pscustomobject]@{
            success      = $true
            action       = 'submit'
            messageId    = $MessageId
            submissionId = $SubmissionId
            status       = (ConvertTo-QuarantineSubmitStatus -Value ([string]$live.status))
            transport    = $transport
            refreshed    = $true
            refreshedAt  = [DateTime]::UtcNow.ToString('o')
        }
    }

    if ([string]::IsNullOrWhiteSpace($Recipient)) {
        throw 'quarantine.validation_failed: recipient is required to submit a message for review'
    }

    $transport = Resolve-QuarantineSubmitTransport -Operation 'submit'
    $exportTransport = Resolve-QuarantineSubmitTransport -Operation 'export'
    $submittedAt = [DateTime]::UtcNow.ToString('o')
    $auditEvent = @{
        id            = [guid]::NewGuid().ToString()
        tenantId      = $TenantId
        action        = 'quarantine.action.submit'
        messageId     = $MessageId
        recipient     = $Recipient
        timestamp     = $submittedAt
        actor         = $Actor
        correlationId = $CorrelationId
        result        = $null
        error         = $null
    }

    try {
        $export = Export-QuarantineMessage -Identity $MessageId
        $eml = [string]$export.Eml
        if ([string]::IsNullOrWhiteSpace($eml)) {
            throw 'quarantine.submit_failed: could not export the quarantined message'
        }

        $body = @{
            '@odata.type'         = '#microsoft.graph.security.emailContentThreatSubmission'
            category              = $Category
            recipientEmailAddress = $Recipient
            fileContent           = $eml
        } | ConvertTo-Json -Depth 5 -Compress

        $response = Invoke-MgGraphRequest -Method POST -Uri '/beta/security/threatSubmission/emailThreats' -Body $body
        $submissionId = if ($response -and $response.id) { [string]$response.id } else { [guid]::NewGuid().ToString() }

        $auditEvent['result'] = 'success'
        $null = & $WriteAudit $auditEvent

        return [pscustomobject]@{
            success         = $true
            action          = 'submit'
            messageId       = $MessageId
            submissionId    = $submissionId
            status          = (ConvertTo-QuarantineSubmitStatus -Value ([string]$response.status))
            transport       = $transport
            exportTransport = $exportTransport
            submittedAt     = $submittedAt
            auditEvent      = $auditEvent
        }
    }
    catch {
        $message = $_.Exception.Message
        $auditEvent['result'] = 'failure'
        $auditEvent['error'] = $message
        $null = & $WriteAudit $auditEvent
        return [pscustomobject]@{
            success    = $false
            action     = 'submit'
            messageId  = $MessageId
            status     = 'pending'
            transport  = $transport
            error      = $message
            auditEvent = $auditEvent
        }
    }
}

function Read-QuarantineSubmitJob {
    <#
    .SYNOPSIS
        Reads a submit-for-review job envelope into Submit-QuarantineReview parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        message id, recipient, category, refresh flag, and submission id. The
        envelope carries references only; secrets are never present and never
        needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-QuarantineSubmitJob -Path './run/quarantine-submit-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Quarantine submit job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Quarantine submit job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Quarantine submit job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $messageId = [string]$payload['messageId']
    if ([string]::IsNullOrWhiteSpace($messageId)) {
        throw 'Quarantine submit job is missing required field: payload.messageId'
    }

    $category = [string]$payload['category']
    if ([string]::IsNullOrWhiteSpace($category)) {
        $category = 'spam'
    }

    return @{
        TenantId      = $tenantId
        MessageId     = $messageId
        Recipient     = [string]$payload['recipient']
        Category      = $category
        Refresh       = ($payload['refresh'] -eq $true)
        SubmissionId  = [string]$payload['submissionId']
        Actor         = [string]$payload['actor']
        CorrelationId = [string]$job['correlationId']
    }
}
