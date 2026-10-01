# Update-UserLicense.ps1 — EPIC-033 per-user licence assign/remove worker
# (SPEC §3.4, §4.3, §5, §8, §9; T-0645).
#
# Applies one licence change per user against Graph (`assignLicense` with
# addLicenses for assign and removeLicenses for remove), capturing before/after
# and emitting one LicenseChange and one AuditEvent per row through injected
# seams. Gating follows the EPIC-006 contract (T-0107/T-0108): a removal is the
# risky direction (a user may depend on the licence, SPEC §9), so it requires
# explicit confirmation; -DryRun reports the intended change and writes nothing;
# bulk stops on the first failure by default and -ContinueOnFailure overrides it.
# The Graph session is connected by the supervisor after materializing the tenant
# credential in-process; this file never touches secrets.

function Get-LicenseChangeActions {
    <#
    .SYNOPSIS
        Returns the licence change actions this worker dispatches.
    .DESCRIPTION
        The single source of truth for valid action names; anything else is
        refused with licensing.unknown_action.
    .EXAMPLE
        Get-LicenseChangeActions
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('assign', 'remove')
}

function Get-LicenseChangeConfirmation {
    <#
    .SYNOPSIS
        Returns the licence actions that require explicit confirmation.
    .DESCRIPTION
        Removing a licence can break a user who depends on it (SPEC §9), so a
        live removal requires confirmation before apply.
    .EXAMPLE
        Get-LicenseChangeConfirmation
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('remove')
}

function Get-UserLicenseState {
    <#
    .SYNOPSIS
        Reads a user's current licence assignment state for before/after capture.
    .DESCRIPTION
        GETs the live user and shapes the comparison fields. A missing user
        returns null so the caller can fail the row with a clear error.
    .PARAMETER UserId
        The target user id.
    .EXAMPLE
        Get-UserLicenseState -UserId 'user-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$UserId
    )

    try {
        $user = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/users/$UserId?`$select=id,displayName,userPrincipalName,assignedLicenses"
    }
    catch {
        return $null
    }
    if ($null -eq $user) { return $null }

    $assigned = @()
    if ($user.assignedLicenses) {
        $assigned = @($user.assignedLicenses | ForEach-Object { [string]$_.skuId })
    }

    return [pscustomobject]@{
        id                = [string]$user.id
        displayName       = [string]$user.displayName
        userPrincipalName = [string]$user.userPrincipalName
        assignedLicenses  = $assigned
    }
}

function Test-UserLicenseAssigned {
    <#
    .SYNOPSIS
        True when the SKU is present in the user's assigned licences.
    .PARAMETER State
        A Get-UserLicenseState result (or null).
    .PARAMETER SkuId
        The SKU to test.
    .EXAMPLE
        Test-UserLicenseAssigned -State $state -SkuId 'sku-1'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [AllowNull()]
        [object]$State,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SkuId
    )

    if ($null -eq $State) { return $false }
    $licenses = @()
    if ($null -ne $State.assignedLicenses) { $licenses = @($State.assignedLicenses) }
    return ($licenses -contains $SkuId)
}

function Get-UserLicenseProjection {
    <#
    .SYNOPSIS
        Computes the before/after projection for one user and SKU.
    .PARAMETER Before
        The Get-UserLicenseState read before the change.
    .PARAMETER SkuId
        The SKU being assigned or removed.
    .PARAMETER Action
        assign or remove.
    .EXAMPLE
        Get-UserLicenseProjection -Before $before -SkuId 'sku-1' -Action 'assign'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [AllowNull()]
        [object]$Before,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SkuId,

        [Parameter(Mandatory)]
        [ValidateSet('assign', 'remove')]
        [string]$Action
    )

    $assignedBefore = Test-UserLicenseAssigned -State $Before -SkuId $SkuId
    $assignedAfter = ($Action -eq 'assign')
    $change = 'unchanged'
    if ($assignedBefore -ne $assignedAfter) { $change = $Action }

    return [pscustomobject]@{
        userId = [string]$Before.id
        before = [pscustomobject]@{ assigned = $assignedBefore }
        after  = [pscustomobject]@{ assigned = $assignedAfter }
        change = $change
    }
}

function Invoke-UserLicenseChange {
    <#
    .SYNOPSIS
        Executes one licence assign/remove live against Graph.
    .DESCRIPTION
        Captures before, writes addLicenses/removeLicenses through assignLicense,
        captures after, and emits one LicenseChange and one AuditEvent. -DryRun
        returns the intended change with no Graph write and no records. A live
        removal requires -Confirmed (SPEC §9). Apply failures are returned, not
        thrown; only unknown actions and missing confirmation throw.
    .PARAMETER TenantId
        Tenant the user belongs to. Carried through to the records.
    .PARAMETER UserId
        The target user id.
    .PARAMETER SkuId
        The SKU to assign or remove.
    .PARAMETER Action
        One of the Get-LicenseChangeActions names.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for a removal.
    .PARAMETER Actor
        Caller identity recorded on the records.
    .PARAMETER Reason
        Caller-supplied reason recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteChange
        Seam: scriptblock (change) -> void. Defaults to a no-op.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-UserLicenseChange -TenantId 'tenant-a' -UserId 'user-1' -SkuId 'sku-1' -Action 'assign'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$UserId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SkuId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Action,

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [switch]$Confirmed,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$Reason = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteChange = { param($Change) },

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) },

        [Parameter()]
        [scriptblock]$NewId = { [guid]::NewGuid().ToString() },

        [Parameter()]
        [scriptblock]$Clock = { [DateTime]::UtcNow.ToString('o') }
    )

    $known = Get-LicenseChangeActions
    if (-not ($known -contains $Action)) {
        throw "licensing.unknown_action: unknown licence action '$Action'; expected one of: $($known -join ', ')"
    }
    if ((-not $DryRun) -and ((Get-LicenseChangeConfirmation) -contains $Action) -and (-not $Confirmed)) {
        throw "licensing.confirm_required: action '$Action' requires explicit confirmation"
    }

    $before = Get-UserLicenseState -UserId $UserId
    if ($null -eq $before) {
        return [pscustomobject]@{
            userId     = $UserId
            skuId      = $SkuId
            action     = $Action
            state      = 'failed'
            before     = $null
            after      = $null
            error      = "user '$UserId' was not found"
            change     = $null
            auditEvent = $null
        }
    }

    $projection = Get-UserLicenseProjection -Before $before -SkuId $SkuId -Action $Action

    if ($DryRun) {
        return [pscustomobject]@{
            userId     = $UserId
            skuId      = $SkuId
            action     = $Action
            state      = 'planned'
            before     = $projection.before
            after      = $projection.after
            error      = $null
            change     = $null
            auditEvent = $null
        }
    }

    try {
        if ($Action -eq 'assign') {
            $body = @{ addLicenses = @(@{ skuId = $SkuId; disabledPlans = @() }); removeLicenses = @() }
        }
        else {
            $body = @{ addLicenses = @(); removeLicenses = @($SkuId) }
        }
        $null = Invoke-MgGraphRequest -Method POST -Uri "/v1.0/users/$UserId/assignLicense" -Body ($body | ConvertTo-Json -Depth 6)

        $after = Get-UserLicenseState -UserId $UserId
        if ($null -eq $after) { $after = $before }

        $at = & $Clock
        $change = [pscustomobject]@{
            id       = (& $NewId)
            tenantId = $TenantId
            userId   = $UserId
            skuId    = $SkuId
            action   = $Action
            state    = 'applied'
            by       = $Actor
            at       = $at
        }
        $auditEvent = [pscustomobject]@{
            tenantId      = $TenantId
            action        = 'licensing.change.append'
            userId        = $UserId
            skuId         = $SkuId
            changeAction  = $Action
            result        = 'success'
            before        = $projection.before
            after         = $projection.after
            actor         = $Actor
            reason        = $Reason
            correlationId = $CorrelationId
            timestamp     = $at
            error         = $null
        }
        $null = & $WriteChange $change
        $null = & $WriteAudit $auditEvent

        return [pscustomobject]@{
            userId     = $UserId
            skuId      = $SkuId
            action     = $Action
            state      = 'applied'
            before     = $projection.before
            after      = $projection.after
            error      = $null
            change     = $change
            auditEvent = $auditEvent
        }
    }
    catch {
        $message = $_.Exception.Message
        $at = & $Clock
        $change = [pscustomobject]@{
            id       = (& $NewId)
            tenantId = $TenantId
            userId   = $UserId
            skuId    = $SkuId
            action   = $Action
            state    = 'failed'
            by       = $Actor
            at       = $at
        }
        $auditEvent = [pscustomobject]@{
            tenantId      = $TenantId
            action        = 'licensing.change.append'
            userId        = $UserId
            skuId         = $SkuId
            changeAction  = $Action
            result        = 'failure'
            before        = $projection.before
            after         = $null
            actor         = $Actor
            reason        = $Reason
            correlationId = $CorrelationId
            timestamp     = $at
            error         = $message
        }
        $null = & $WriteChange $change
        $null = & $WriteAudit $auditEvent

        return [pscustomobject]@{
            userId     = $UserId
            skuId      = $SkuId
            action     = $Action
            state      = 'failed'
            before     = $projection.before
            after      = $null
            error      = $message
            change     = $change
            auditEvent = $auditEvent
        }
    }
}

function Invoke-UserLicenseBulk {
    <#
    .SYNOPSIS
        Applies a licence assign/remove across many users.
    .DESCRIPTION
        Iterates the users, executing one change each, and returns a per-row
        result. A failure stops the batch by default (remaining rows are
        `skipped` with error `batch-stopped`); -ContinueOnFailure keeps going.
        Every applied/failed row contributes a LicenseChange and an AuditEvent.
    .PARAMETER TenantId
    .PARAMETER SkuId
    .PARAMETER Action
    .PARAMETER UserIds
    .PARAMETER DryRun
    .PARAMETER Confirmed
    .PARAMETER ContinueOnFailure
    .PARAMETER Actor
    .PARAMETER Reason
    .PARAMETER CorrelationId
    .PARAMETER ExecuteChange
        Seam: scriptblock (userId) -> row. Defaults to Invoke-UserLicenseChange.
    .PARAMETER WriteChange
    .PARAMETER WriteAudit
    .EXAMPLE
        Invoke-UserLicenseBulk -TenantId 'tenant-a' -SkuId 'sku-1' -Action 'assign' -UserIds @('user-1','user-2')
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SkuId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Action,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$UserIds,

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [switch]$Confirmed,

        [Parameter()]
        [switch]$ContinueOnFailure,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$Reason = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$ExecuteChange,

        [Parameter()]
        [scriptblock]$WriteChange = { param($Change) },

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    if (-not $ExecuteChange) {
        $ExecuteChange = {
            param($UserId)
            Invoke-UserLicenseChange -TenantId $TenantId -UserId $UserId -SkuId $SkuId -Action $Action `
                -DryRun:$DryRun -Confirmed:$Confirmed -Actor $Actor -Reason $Reason -CorrelationId $CorrelationId `
                -WriteChange $WriteChange -WriteAudit $WriteAudit
        }
    }

    $rows = [System.Collections.Generic.List[object]]::new()
    $changes = [System.Collections.Generic.List[object]]::new()
    $audits = [System.Collections.Generic.List[object]]::new()
    $stopped = $false

    foreach ($userId in $UserIds) {
        if ($stopped) {
            $rows.Add([pscustomobject]@{
                userId = $userId; skuId = $SkuId; action = $Action; state = 'skipped'
                before = $null; after = $null; error = 'batch-stopped'
            }) | Out-Null
            continue
        }

        try {
            $row = & $ExecuteChange $userId
        }
        catch {
            $row = [pscustomobject]@{
                userId = $userId; skuId = $SkuId; action = $Action; state = 'failed'
                before = $null; after = $null; error = $_.Exception.Message
                change = $null; auditEvent = $null
            }
        }

        $rows.Add($row) | Out-Null
        if ($null -ne $row.change) { $changes.Add($row.change) | Out-Null }
        if ($null -ne $row.auditEvent) { $audits.Add($row.auditEvent) | Out-Null }

        if ($row.state -eq 'failed' -and -not $ContinueOnFailure) { $stopped = $true }
    }

    $summary = [pscustomobject]@{
        total   = $UserIds.Count
        applied = @($rows | Where-Object { $_.state -eq 'applied' }).Count
        planned = @($rows | Where-Object { $_.state -eq 'planned' }).Count
        failed  = @($rows | Where-Object { $_.state -eq 'failed' }).Count
        skipped = @($rows | Where-Object { $_.state -eq 'skipped' }).Count
    }

    return [pscustomobject]@{
        tenantId          = $TenantId
        skuId             = $SkuId
        action            = $Action
        dryRun            = [bool]$DryRun
        continueOnFailure = [bool]$ContinueOnFailure
        stoppedOnFailure  = $stopped
        rows              = @($rows)
        changes           = @($changes)
        auditEvents       = @($audits)
        summary           = $summary
    }
}

function Get-UserLicensePreview {
    <#
    .SYNOPSIS
        Reads the current assignment state for each user (no writes).
    .DESCRIPTION
        Returns one entry per user with the live `assigned` flag for the SKU.
        The BFF turns this into the before/after plan preview shown for
        confirmation; this worker performs no write here.
    .PARAMETER TenantId
    .PARAMETER SkuId
    .PARAMETER UserIds
    .EXAMPLE
        Get-UserLicensePreview -TenantId 'tenant-a' -SkuId 'sku-1' -UserIds @('user-1')
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SkuId,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$UserIds
    )

    $users = [System.Collections.Generic.List[object]]::new()
    foreach ($userId in $UserIds) {
        $state = Get-UserLicenseState -UserId $userId
        if ($null -eq $state) {
            $users.Add([pscustomobject]@{
                userId = $userId; displayName = $null; userPrincipalName = $null
                assigned = $false; found = $false
            }) | Out-Null
            continue
        }
        $users.Add([pscustomobject]@{
            userId            = $state.id
            displayName       = $state.displayName
            userPrincipalName = $state.userPrincipalName
            assigned          = (Test-UserLicenseAssigned -State $state -SkuId $SkuId)
            found             = $true
        }) | Out-Null
    }

    return [pscustomobject]@{
        tenantId = $TenantId
        skuId    = $SkuId
        users    = @($users)
    }
}

function Read-UserLicenseJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope into Update-UserLicense parameters.
    .DESCRIPTION
        Validates the schema version, tenant, operation, SKU, and user list, then
        returns the dispatch fields. The envelope carries references only; no
        secret is ever present and none is needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-UserLicenseJob -Path './run/license-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Licence change job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Licence change job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Licence change job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) { $payload = @{} }

    $operation = [string]$payload['operation']
    if ([string]::IsNullOrWhiteSpace($operation)) { $operation = 'apply' }
    if ($operation -notin @('plan', 'apply')) {
        throw "Licence change job has unsupported operation: $operation"
    }

    $skuId = [string]$payload['skuId']
    if ([string]::IsNullOrWhiteSpace($skuId)) {
        throw 'Licence change job is missing required field: payload.skuId'
    }

    $userIds = @()
    if ($payload.Contains('userIds')) {
        $userIds = @($payload['userIds'] | ForEach-Object { [string]$_ })
    }
    elseif ($payload.Contains('userId')) {
        $userIds = @([string]$payload['userId'])
    }
    $userIds = @($userIds | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($userIds.Count -eq 0) {
        throw 'Licence change job is missing required field: payload.userIds'
    }

    $action = [string]$payload['action']
    if ([string]::IsNullOrWhiteSpace($action)) { $action = 'assign' }
    if ($action -notin @('assign', 'remove')) {
        throw "Licence change job has unsupported action: $action"
    }

    # Prefer the request's correlation id from the payload; the envelope's own id is
    # regenerated per worker call and would not trace back to the caller.
    $correlationId = [string]$payload['correlationId']
    if ([string]::IsNullOrWhiteSpace($correlationId)) { $correlationId = [string]$job['correlationId'] }

    return @{
        TenantId          = $tenantId
        Operation         = $operation
        SkuId             = $skuId
        Action            = $action
        UserIds           = $userIds
        DryRun            = $payload['dryRun'] -eq $true
        Confirmed         = $payload['confirm'] -eq $true
        ContinueOnFailure = $payload['continueOnFailure'] -eq $true
        Actor             = [string]$payload['actor']
        Reason            = [string]$payload['reason']
        CorrelationId     = $correlationId
    }
}
