# Start-MailboxRestore.ps1 — EPIC-024 mailbox restore worker (SPEC §2 US-4, §3.4,
# §4.2, §5, §9; §11 item 3; T-0467).
#
# Restore is destructive-adjacent, so it follows the EPIC-006 gated-executor
# contract (T-0108) rather than the CheckId-bound registry path — restore is not
# a registry command and cannot travel Invoke-RemediationApply (same contract
# as Restore-Mailbox.ps1, T-0388): a plan preview is produced before any write,
# -DryRun reports the intended change without writing, -Confirmed is re-checked
# here so a job that skips confirmation cannot apply, every apply captures
# before/after item counts, and every apply emits exactly one audit record.
#
# Scope resolution (SPEC §11 item 3): a whole-mailbox restore is the default and
# the only path that does not require a target; item-level restore (scope
# 'items'/'date') is accepted only when a target is explicitly named. The
# RestoreJob state is returned on stdout for the BFF to persist through the
# repository (T-0461); this worker never touches the portal database.
#
# The supervisor connects EXO in the child process after materializing the
# tenant credential (T-0011) before invoking this file, so no secret handling
# lives here. Progress events flow on stderr; audit records flow to the app
# audit sink through the -WriteAudit seam.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-MailboxRestoreUtcNow {
    [CmdletBinding()]
    [OutputType([string])]
    param()

    return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}

function Write-MailboxRestoreProgress {
    [CmdletBinding()]
    [OutputType([void])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$JobId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('planned', 'running', 'completed', 'failed')]
        [string]$State,

        [Parameter()]
        [string]$Message = ''
    )

    $progressEvent = [ordered]@{
        schemaVersion = 'v1'
        jobType       = 'mailbox-restore'
        jobId         = $JobId
        tenantId      = $TenantId
        section       = 'mailbox-restore'
        state         = $State
        message       = $Message
        emittedAt     = (Get-MailboxRestoreUtcNow)
    }
    [Console]::Error.WriteLine(($progressEvent | ConvertTo-Json -Depth 5 -Compress))
}

function Assert-MailboxRestoreScope {
    [CmdletBinding()]
    [OutputType([void])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('mailbox', 'items', 'date')]
        [string]$Scope,

        [Parameter()]
        [string]$Target = ''
    )

    if ($Scope -ne 'mailbox' -and [string]::IsNullOrWhiteSpace($Target)) {
        throw "mailbox.restore_target_required: scope '$Scope' requires an explicit target"
    }
}

function Get-MailboxRestoreMailboxState {
    <#
    .SYNOPSIS
        Reads the mailbox identity and recovery state for a restore.
    .DESCRIPTION
        Looks the mailbox up in the soft-deleted set first, then live. A
        mailbox found in neither is refused with a structured not-found error
        instead of restoring blindly.
    .PARAMETER MailboxId
        Mailbox identity (ExchangeObjectId, GUID, or primary SMTP).
    .EXAMPLE
        Get-MailboxRestoreMailboxState -MailboxId 'mbx-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId
    )

    $deleted = $null
    try {
        $deleted = Get-EXOMailbox -SoftDeletedMailbox -Identity $MailboxId -ErrorAction Stop
    }
    catch {
        $deleted = $null
    }
    if ($null -ne $deleted) {
        return ConvertTo-MailboxRestoreState -Mailbox $deleted -State 'softDeleted'
    }

    $live = $null
    try {
        $live = Get-EXOMailbox -Identity $MailboxId -ErrorAction Stop
    }
    catch {
        $live = $null
    }
    if ($null -ne $live) {
        return ConvertTo-MailboxRestoreState -Mailbox $live -State 'active'
    }

    throw "mailbox.restore_not_found: mailbox '$MailboxId' was not found within the recovery window"
}

function ConvertTo-MailboxRestoreState {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Mailbox,

        [Parameter(Mandatory)]
        [ValidateSet('softDeleted', 'active')]
        [string]$State
    )

    $id = [string]$Mailbox.ExchangeObjectId
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Mailbox.Guid
    }
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Mailbox.PrimarySmtpAddress
    }

    $displayName = [string]$Mailbox.DisplayName
    if ($displayName.Trim().Length -eq 0) {
        $displayName = $id
    }

    return [pscustomobject]@{
        id                 = $id
        displayName        = $displayName
        primarySmtpAddress = [string]$Mailbox.PrimarySmtpAddress
        state              = $State
    }
}

function Get-MailboxRestoreItemCount {
    <#
    .SYNOPSIS
        Reads the item count used for the restore before/after audit.
    .DESCRIPTION
        Returns the mailbox item count, or null when EXO does not report one.
        A count failure never blocks the restore; the audit records null.
    .PARAMETER MailboxId
        Mailbox identity to read statistics for.
    .EXAMPLE
        Get-MailboxRestoreItemCount -MailboxId 'mbx-1'
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId
    )

    try {
        $stats = Get-EXOMailboxStatistics -Identity $MailboxId -ErrorAction Stop
        if ($null -ne $stats -and $null -ne $stats.ItemCount) {
            return [int]$stats.ItemCount
        }
    }
    catch {
        return $null
    }
    return $null
}

function New-MailboxRestorePlan {
    <#
    .SYNOPSIS
        Builds the mailbox-restore plan preview without writing.
    .DESCRIPTION
        Resolves the mailbox recovery state, reads the current item count for
        the before snapshot, and describes the intended restore and where it
        lands. A whole-mailbox restore is the default; item-level scopes
        require an explicit target.
    .PARAMETER TenantId
        Tenant the mailbox belongs to. Carried through to the plan.
    .PARAMETER MailboxId
        Mailbox identity (ExchangeObjectId, GUID, or primary SMTP).
    .PARAMETER Scope
        'mailbox' (whole mailbox), 'items' (targeted items), or 'date'.
    .PARAMETER Target
        Target mailbox for item-level scopes. Required when Scope is not 'mailbox'.
    .PARAMETER Query
        Optional item filter for scope 'items'.
    .PARAMETER StartDate
        Optional window start for scope 'date'.
    .PARAMETER EndDate
        Optional window end for scope 'date'.
    .EXAMPLE
        New-MailboxRestorePlan -TenantId 'tenant-a' -MailboxId 'mbx-1' -Scope 'mailbox'
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
        [ValidateSet('mailbox', 'items', 'date')]
        [string]$Scope = 'mailbox',

        [Parameter()]
        [string]$Target = '',

        [Parameter()]
        [string]$Query = '',

        [Parameter()]
        [string]$StartDate = '',

        [Parameter()]
        [string]$EndDate = ''
    )

    Assert-MailboxRestoreScope -Scope $Scope -Target $Target

    $mailboxKey = $MailboxId.Trim()
    $state = Get-MailboxRestoreMailboxState -MailboxId $mailboxKey
    $beforeCount = Get-MailboxRestoreItemCount -MailboxId $mailboxKey

    $targetValue = $null
    if (-not [string]::IsNullOrWhiteSpace($Target)) {
        $targetValue = $Target.Trim()
    }
    $queryValue = $null
    if (-not [string]::IsNullOrWhiteSpace($Query)) {
        $queryValue = $Query.Trim()
    }

    $afterState = 'restored'
    if ($Scope -eq 'mailbox') {
        $afterState = 'active'
    }

    $before = @{
        id                 = [string]$state.id
        displayName        = [string]$state.displayName
        primarySmtpAddress = [string]$state.primarySmtpAddress
        state              = [string]$state.state
        itemCount          = $beforeCount
    }
    $after = @{
        id                 = [string]$state.id
        displayName        = [string]$state.displayName
        primarySmtpAddress = [string]$state.primarySmtpAddress
        state              = $afterState
        itemCount          = $null
    }

    $diff = [System.Collections.Generic.List[string]]::new()
    if ($Scope -eq 'mailbox') {
        $diff.Add("Restore mailbox '$($state.displayName)' ($mailboxKey) in place") | Out-Null
    }
    elseif ($Scope -eq 'date') {
        $window = "$StartDate to $EndDate"
        $diff.Add("Restore items received in window $window from '$mailboxKey' into target '$targetValue'") | Out-Null
    }
    else {
        $diff.Add("Restore items from '$mailboxKey' into target '$targetValue'") | Out-Null
        if ($null -ne $queryValue) {
            $diff.Add("Item filter: $queryValue") | Out-Null
        }
    }

    return [pscustomobject]@{
        action               = 'restore'
        tenantId             = $TenantId
        mailboxId            = $mailboxKey
        scope                = $Scope
        target               = $targetValue
        query                = $queryValue
        startDate            = if ($StartDate.Trim().Length -gt 0) { $StartDate.Trim() } else { $null }
        endDate              = if ($EndDate.Trim().Length -gt 0) { $EndDate.Trim() } else { $null }
        before               = $before
        after                = $after
        diff                 = $diff.ToArray()
        valid                = $true
        dryRun               = $true
        requiresConfirmation = $true
    }
}

function New-MailboxRestoreAuditEvent {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$JobId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId,

        [Parameter()]
        [string]$Scope = 'mailbox',

        [Parameter()]
        [string]$TargetName = '',

        [Parameter()]
        [object]$Before,

        [Parameter()]
        [object]$After,

        [Parameter()]
        [string]$Actor = ''
    )

    $audit = @{
        id        = [guid]::NewGuid().ToString()
        tenantId  = $TenantId
        jobId     = $JobId
        action    = 'mailbox.restore'
        targetId  = $MailboxId
        scope     = $Scope
        timestamp = (Get-MailboxRestoreUtcNow)
        before    = $Before
        after     = $After
    }
    if ($TargetName.Trim().Length -gt 0) {
        $audit['targetName'] = $TargetName
    }
    if ($Actor.Trim().Length -gt 0) {
        $audit['actor'] = $Actor
    }
    return $audit
}

function Invoke-MailboxRestoreCommand {
    <#
    .SYNOPSIS
        Issues the single EXO restore command for a resolved plan.
    .DESCRIPTION
        A whole-mailbox restore undoes the soft-delete (Undo-SoftDeletedMailbox).
        Item-level scopes create a restore request into the named target
        (New-MailboxRestoreRequest). This is the only tenant write in the
        worker and it is never reached on preview.
    .PARAMETER Plan
        The plan produced by New-MailboxRestorePlan.
    .EXAMPLE
        Invoke-MailboxRestoreCommand -Plan $plan
    #>
    [CmdletBinding()]
    [OutputType([void])]
    param(
        [Parameter(Mandatory)]
        [object]$Plan
    )

    if ([string]$Plan.scope -eq 'mailbox') {
        $null = Undo-SoftDeletedMailbox -SoftDeletedMailbox ([string]$Plan.mailboxId)
        return
    }

    $requestParams = @{
        SourceStoreMailbox    = [string]$Plan.mailboxId
        TargetMailbox         = [string]$Plan.target
        AllowLegacyDNMismatch = $true
    }
    $null = New-MailboxRestoreRequest @requestParams
}

function Start-MailboxRestore {
    <#
    .SYNOPSIS
        Previews or applies the restore of a mailbox or targeted items.
    .DESCRIPTION
        -DryRun returns the plan with no EXO write. Without -DryRun, -Confirmed
        is required or the apply is refused. Every apply captures before/after
        item counts and emits one audit record; the returned job record carries
        the before/after counts for the BFF to persist through the repository.
    .PARAMETER TenantId
        Tenant the mailbox belongs to.
    .PARAMETER JobId
        RestoreJob id the BFF created for this run.
    .PARAMETER MailboxId
        Mailbox identity (ExchangeObjectId, GUID, or primary SMTP).
    .PARAMETER Scope
        'mailbox' (whole mailbox), 'items' (targeted items), or 'date'.
    .PARAMETER Target
        Target mailbox for item-level scopes. Required when Scope is not 'mailbox'.
    .PARAMETER Query
        Optional item filter for scope 'items'.
    .PARAMETER StartDate
        Optional window start for scope 'date'.
    .PARAMETER EndDate
        Optional window end for scope 'date'.
    .PARAMETER CreatedBy
        Actor that requested the restore, recorded on the job and audit.
    .PARAMETER DryRun
        Report the intended restore without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for apply; the BFF confirms the plan before dispatch.
    .PARAMETER WriteProgress
        Progress seam; defaults to stderr progress events.
    .PARAMETER WriteAudit
        Audit seam receiving the apply audit event.
    .PARAMETER ExecuteRestore
        Seam: scriptblock (plan) -> void. Defaults to Invoke-MailboxRestoreCommand.
    .EXAMPLE
        Start-MailboxRestore -TenantId 'tenant-a' -JobId 'job-1' -MailboxId 'mbx-1' -Scope 'mailbox' -Confirmed
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$JobId = '',

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId,

        [Parameter()]
        [ValidateSet('mailbox', 'items', 'date')]
        [string]$Scope = 'mailbox',

        [Parameter()]
        [string]$Target = '',

        [Parameter()]
        [string]$Query = '',

        [Parameter()]
        [string]$StartDate = '',

        [Parameter()]
        [string]$EndDate = '',

        [Parameter()]
        [string]$CreatedBy = '',

        [Parameter()]
        [bool]$DryRun = $true,

        [Parameter()]
        [bool]$Confirmed = $false,

        [Parameter()]
        [scriptblock]$WriteProgress = { param($ProgressEvent) Write-MailboxRestoreProgress -JobId $ProgressEvent.jobId -TenantId $ProgressEvent.tenantId -State $ProgressEvent.state -Message $ProgressEvent.message },

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) },

        [Parameter()]
        [scriptblock]$ExecuteRestore
    )

    if ([string]::IsNullOrWhiteSpace($JobId)) {
        $JobId = [guid]::NewGuid().ToString()
    }

    $plan = New-MailboxRestorePlan -TenantId $TenantId -MailboxId $MailboxId -Scope $Scope -Target $Target -Query $Query -StartDate $StartDate -EndDate $EndDate
    $beforeCount = $plan.before['itemCount']

    if ($DryRun) {
        $null = & $WriteProgress @{ jobId = $JobId; tenantId = $TenantId; state = 'planned'; message = 'Restore plan preview; no tenant write.' }
        return [pscustomobject]@{
            success = $true
            dryRun  = $true
            plan    = $plan
            job     = [pscustomobject]@{
                id        = $JobId
                tenantId  = $TenantId
                mailboxId = [string]$plan.mailboxId
                scope     = [string]$plan.scope
                target    = $plan.target
                state     = 'planned'
                result    = @{ before = @{ itemCount = $beforeCount; state = [string]$plan.before['state'] } }
                createdBy = $CreatedBy
            }
        }
    }

    if (-not $Confirmed) {
        throw "mailbox.confirm_required: restore of '$MailboxId' requires explicit confirmation"
    }

    if (-not $ExecuteRestore) {
        $ExecuteRestore = { param($restorePlan) Invoke-MailboxRestoreCommand -Plan $restorePlan }
    }

    $null = & $WriteProgress @{ jobId = $JobId; tenantId = $TenantId; state = 'running'; message = 'Applying the restore.' }

    try {
        $null = & $ExecuteRestore $plan
    }
    catch {
        $null = & $WriteProgress @{ jobId = $JobId; tenantId = $TenantId; state = 'failed'; message = $_.Exception.Message }
        throw
    }

    $afterMailbox = [string]$plan.mailboxId
    if ([string]$plan.scope -ne 'mailbox' -and -not [string]::IsNullOrWhiteSpace([string]$plan.target)) {
        $afterMailbox = [string]$plan.target
    }
    $afterCount = Get-MailboxRestoreItemCount -MailboxId $afterMailbox

    $finalAfter = @{}
    foreach ($key in @($plan.after.Keys)) {
        $finalAfter[$key] = $plan.after[$key]
    }
    $finalAfter['itemCount'] = $afterCount
    $finalPlan = $plan
    $finalPlan.after = $finalAfter
    $finalPlan.dryRun = $false
    $finalPlan.requiresConfirmation = $false

    $targetName = [string]$plan.before['displayName']
    if ([string]$plan.scope -ne 'mailbox' -and -not [string]::IsNullOrWhiteSpace([string]$plan.target)) {
        $targetName = [string]$plan.target
    }

    $audit = New-MailboxRestoreAuditEvent -TenantId $TenantId -JobId $JobId -MailboxId ([string]$plan.mailboxId) -Scope ([string]$plan.scope) -TargetName $targetName -Before $finalPlan.before -After $finalPlan.after -Actor $CreatedBy
    $null = & $WriteAudit $audit

    $result = @{
        before = @{ itemCount = $beforeCount; state = [string]$plan.before['state'] }
        after  = @{ itemCount = $afterCount; state = [string]$finalPlan.after['state'] }
    }

    $null = & $WriteProgress @{ jobId = $JobId; tenantId = $TenantId; state = 'completed'; message = 'Restore completed.' }

    return [pscustomobject]@{
        success    = $true
        dryRun     = $false
        plan       = $finalPlan
        result     = $result
        auditEvent = $audit
        job        = [pscustomobject]@{
            id        = $JobId
            tenantId  = $TenantId
            mailboxId = [string]$plan.mailboxId
            scope     = [string]$plan.scope
            target    = $plan.target
            state     = 'completed'
            result    = $result
            createdBy = $CreatedBy
        }
    }
}

function Read-MailboxRestoreJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Start-MailboxRestore parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        action (plan or apply) with the scoped restore parameters. The envelope
        carries references and planned values only; secrets are never present.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-MailboxRestoreJob -Path './run/mailbox-restore-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Mailbox-restore job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Mailbox-restore job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Mailbox-restore job is missing required field: tenantId'
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
    if ($filters -isnot [System.Collections.IDictionary]) {
        $filters = @{}
    }

    $jobId = ''
    if ($job['jobId']) {
        $jobId = [string]$job['jobId']
    }
    if ($jobId.Trim().Length -eq 0 -and $filters['jobId']) {
        $jobId = [string]$filters['jobId']
    }

    $action = 'plan'
    if ($filters['action']) {
        $action = ([string]$filters['action']).Trim().ToLowerInvariant()
    }
    if (@('plan', 'apply') -notcontains $action) {
        throw "Mailbox-restore job has unsupported action: $action"
    }

    $scope = 'mailbox'
    if ($filters['scope']) {
        $scope = ([string]$filters['scope']).Trim().ToLowerInvariant()
    }
    if (@('mailbox', 'items', 'date') -notcontains $scope) {
        throw "Mailbox-restore job has unsupported scope: $scope"
    }

    return @{
        TenantId  = $tenantId
        JobId     = $jobId
        Action    = $action
        MailboxId = [string]$filters['mailboxId']
        Scope     = $scope
        Target    = [string]$filters['target']
        Query     = [string]$filters['query']
        StartDate = [string]$filters['startDate']
        EndDate   = [string]$filters['endDate']
        CreatedBy = [string]$filters['createdBy']
        Confirmed = [bool]($filters['confirmed'] -eq $true)
        DryRun    = [bool]($filters['dryRun'] -eq $true)
    }
}
