# Set-RetentionTag.ps1 — EPIC-020 retention tag assignment worker (SPEC §4.4, §5, §6, §11.3; T-0387).
#
# Covers per-mailbox assign and bulk assign of a retention tag/policy to
# mailboxes. Policies and tags are read live from EXO; only the assignment
# record persists locally (retention_tag_assignments). Supports DryRun (plan
# preview mode returning the affected mailboxes without mutating). A mailbox
# that already carries the tag is a per-row no-op: success with no EXO write
# for that row, before equal to after.
#
# Gating (EPIC-006 contract, T-0107): assignment is not a registry-bound
# command, so it cannot travel the registry-bound executor path. It follows
# the same contract instead — the BFF confirms the plan before dispatch
# (dryRun plans only), -DryRun reports the intended change without writing,
# -Confirmed is re-checked here so a job that skips confirmation cannot apply,
# every apply captures before/after, and every apply emits one audit record
# per mailbox plus the RetentionTagAssignment/MailboxOperation row. The
# supervisor connects EXO in the child process after materializing the tenant
# credential in-process; this file never touches secrets.

function Test-SetRetentionTagAssignInput {
    <#
    .SYNOPSIS
        Validates one planned retention tag assignment.
    .DESCRIPTION
        Mirrors the BFF route validation so the worker refuses the same rows
        the BFF would: missing tag id, missing mailbox identities, and bulk
        batches larger than the service limit. Returns the error list; empty
        is valid.
    .PARAMETER TagId
        Planned retention tag identity.
    .PARAMETER MailboxIds
        Planned mailbox identities.
    .EXAMPLE
        Test-SetRetentionTagAssignInput -TagId 'tag-1' -MailboxIds @('mbx-1')
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()]
        [string]$TagId = '',

        [Parameter()]
        [string[]]$MailboxIds = @()
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace($TagId)) {
        $errors.Add('tagId is required for assign')
    }
    $resolved = @($MailboxIds | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($resolved.Count -eq 0) {
        $errors.Add('at least one mailboxId is required for assign')
    }
    if ($resolved.Count -gt 200) {
        $errors.Add('at most 200 mailboxes per bulk assignment')
    }
    return @($errors)
}

function Get-SetRetentionTagCurrent {
    <#
    .SYNOPSIS
        Reads the current retention assignment of one live mailbox.
    .DESCRIPTION
        Projects the EXO mailbox retention fields into the before-snapshot
        shape so previews and audit records compare the same vocabulary.
    .PARAMETER Mailbox
        The live EXO mailbox object.
    .EXAMPLE
        Get-SetRetentionTagCurrent -Mailbox $existing
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [object]$Mailbox
    )

    $mailboxId = [string]$Mailbox.ExchangeObjectId
    if ([string]::IsNullOrWhiteSpace($mailboxId)) {
        $mailboxId = [string]$Mailbox.Identity
    }
    return @{
        id              = $mailboxId
        displayName     = [string]$Mailbox.DisplayName
        retentionPolicy = [string]$Mailbox.RetentionPolicy
    }
}

function Read-SetRetentionTagJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-SetRetentionTag parameters.
    .DESCRIPTION
        Validates the envelope carries a tenant, an action, and a tag, then
        returns the mailbox identities, policy reference, confirmation, and
        dry-run flag. The envelope carries references and planned values only.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-SetRetentionTagJob -Path './run/retention-job.json'
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
    if (-not $json.action) {
        throw "job envelope '$Path' is missing mandatory 'action'"
    }
    if (-not $json.tagId) {
        throw "job envelope '$Path' is missing mandatory 'tagId'"
    }

    $mailboxIds = @()
    if ($json.mailboxIds) {
        $mailboxIds = @($json.mailboxIds | ForEach-Object { [string]$_ })
    }
    elseif ($json.mailboxId) {
        $mailboxIds = @([string]$json.mailboxId)
    }

    return @{
        TenantId   = [string]$json.tenantId
        Action     = [string]$json.action
        TagId      = [string]$json.tagId
        PolicyId   = if ($json.policyId) { [string]$json.policyId } else { '' }
        MailboxId  = if ($json.mailboxId) { [string]$json.mailboxId } else { '' }
        MailboxIds = $mailboxIds
        Confirmed  = [bool]($json.confirmed -eq $true)
        DryRun     = [bool]($json.dryRun -eq $true)
    }
}

function Invoke-SetRetentionTag {
    <#
    .SYNOPSIS
        Executes or previews retention tag assignment with before/after capture.
    .DESCRIPTION
        -DryRun returns the plan listing every affected mailbox with no EXO
        write. Without -DryRun, -Confirmed is required or the apply is
        refused. Each mailbox is read first for the before snapshot; a mailbox
        that already carries the tag is a per-row no-op with no EXO write.
        Every applied row emits one auditEvent with before/after for the app
        audit sink and one RetentionTagAssignment/MailboxOperation row.
    .PARAMETER TenantId
        Tenant the mailboxes belong to. Carried through to the result envelope.
    .PARAMETER Action
        'assign' targets one mailbox; 'assignBulk' targets many.
    .PARAMETER TagId
        Retention tag identity to assign.
    .PARAMETER PolicyId
        Retention policy carrying the tag; applied alongside the tag when set.
    .PARAMETER MailboxId
        Mailbox identity for single assign.
    .PARAMETER MailboxIds
        Mailbox identities for bulk assign.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for apply; the BFF confirms the plan before dispatch.
    .EXAMPLE
        Invoke-SetRetentionTag -TenantId 'tenant-a' -Action 'assign' -TagId 'tag-1' -MailboxId 'mbx-2' -Confirmed -DryRun
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('assign', 'assignBulk')]
        [string]$Action,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TagId,

        [Parameter()]
        [string]$PolicyId = '',

        [Parameter()]
        [string]$MailboxId = '',

        [Parameter()]
        [string[]]$MailboxIds = @(),

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false
    )

    $targets = [System.Collections.Generic.List[string]]::new()
    if ($Action -eq 'assign') {
        if (-not [string]::IsNullOrWhiteSpace($MailboxId)) {
            $targets.Add($MailboxId.Trim())
        }
        foreach ($candidate in $MailboxIds) {
            if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
                $id = ([string]$candidate).Trim()
                if (-not $targets.Contains($id)) {
                    $targets.Add($id)
                }
            }
        }
        if ($targets.Count -ne 1) {
            throw 'ValidationFailed: assign requires exactly one mailboxId'
        }
    }
    else {
        foreach ($candidate in $MailboxIds) {
            if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
                $id = ([string]$candidate).Trim()
                if (-not $targets.Contains($id)) {
                    $targets.Add($id)
                }
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($MailboxId) -and -not $targets.Contains($MailboxId.Trim())) {
            $targets.Add($MailboxId.Trim())
        }
    }

    $failures = @(Test-SetRetentionTagAssignInput -TagId $TagId -MailboxIds @($targets))
    if ($failures.Count -gt 0) {
        throw "ValidationFailed: $($failures -join '; ')"
    }

    $tagKey = $TagId.Trim()
    $policyKey = $PolicyId.Trim()
    $retentionValue = if ($policyKey.Length -gt 0) { $policyKey } else { $tagKey }

    $snapshots = @()
    foreach ($mailboxKey in $targets) {
        $existing = Get-EXOMailbox -Identity $mailboxKey
        if (-not $existing) {
            throw "NotFound: Mailbox '$mailboxKey' not found"
        }
        $before = Get-SetRetentionTagCurrent -Mailbox $existing
        if ([string]::IsNullOrWhiteSpace([string]$before['id'])) {
            $before['id'] = $mailboxKey
        }
        $targetName = [string]$before['displayName']
        if ([string]::IsNullOrWhiteSpace($targetName)) {
            $targetName = $mailboxKey
        }
        $alreadyAssigned = ([string]$before['retentionPolicy'] -eq $retentionValue)
        $after = @{
            id              = [string]$before['id']
            displayName     = $targetName
            retentionPolicy = $retentionValue
            retentionTag    = $tagKey
        }
        if ($alreadyAssigned) {
            $after = $before.Clone()
            $after['retentionTag'] = $tagKey
        }
        $snapshots += @{
            MailboxKey     = $mailboxKey
            TargetName     = $targetName
            Before         = $before
            After          = $after
            AlreadyAssigned = $alreadyAssigned
        }
    }

    $affectedMailboxes = @($snapshots | ForEach-Object { $_['MailboxKey'] })
    $diff = [System.Collections.Generic.List[string]]::new()
    foreach ($snapshot in $snapshots) {
        if ($snapshot['AlreadyAssigned']) {
            $diff.Add("Mailbox '$($snapshot['TargetName'])' ($($snapshot['MailboxKey'])) already carries tag '$tagKey'; no change applied")
        }
        else {
            $diff.Add("Assign retention tag '$tagKey' to mailbox '$($snapshot['TargetName'])' ($($snapshot['MailboxKey']))")
        }
    }

    if ($Action -eq 'assign') {
        $snapshot = $snapshots[0]
        $plan = [pscustomobject]@{
            action               = $Action
            tagId                = $tagKey
            affectedMailboxes    = @($affectedMailboxes)
            before               = $snapshot['Before']
            after                = $snapshot['After']
            diff                 = @($diff)
            valid                = $true
            dryRun               = $DryRun
            requiresConfirmation = $false
        }

        if ($DryRun) {
            return $plan
        }

        if (-not $Confirmed) {
            throw "retention.confirm_required: action '$Action' requires explicit confirmation"
        }

        if ($snapshot['AlreadyAssigned']) {
            return [pscustomobject]@{
                plan             = $plan
                result           = @{ mailboxId = $snapshot['MailboxKey']; tagId = $tagKey; noop = $true }
                mailboxOperation = @{
                    id        = [guid]::NewGuid().ToString()
                    tenantId  = $TenantId
                    mailboxId = $snapshot['MailboxKey']
                    operation = 'retention.assign'
                    before    = $snapshot['Before']
                    after     = $snapshot['After']
                    state     = 'noop'
                }
                auditEvent       = @{
                    id         = [guid]::NewGuid().ToString()
                    tenantId   = $TenantId
                    action     = 'retention.assign'
                    targetId   = $snapshot['MailboxKey']
                    targetName = $snapshot['TargetName']
                    timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                    before     = $snapshot['Before']
                    after      = $snapshot['After']
                    note       = 'already assigned; no change applied'
                }
                noop             = $true
                success          = $true
            }
        }

        $null = Set-Mailbox -Identity $snapshot['MailboxKey'] -RetentionPolicy $retentionValue
        $refreshed = Get-EXOMailbox -Identity $snapshot['MailboxKey']
        $after = Get-SetRetentionTagCurrent -Mailbox $refreshed
        $after['retentionTag'] = $tagKey

        $plan = [pscustomobject]@{
            action               = $Action
            tagId                = $tagKey
            affectedMailboxes    = @($affectedMailboxes)
            before               = $snapshot['Before']
            after                = $after
            diff                 = @($diff)
            valid                = $true
            dryRun               = $false
            requiresConfirmation = $false
        }

        return [pscustomobject]@{
            plan             = $plan
            result           = @{ mailboxId = $snapshot['MailboxKey']; tagId = $tagKey }
            mailboxOperation = @{
                id        = [guid]::NewGuid().ToString()
                tenantId  = $TenantId
                mailboxId = $snapshot['MailboxKey']
                operation = 'retention.assign'
                before    = $snapshot['Before']
                after     = $after
                state     = 'applied'
            }
            auditEvent       = @{
                id         = [guid]::NewGuid().ToString()
                tenantId   = $TenantId
                action     = 'retention.assign'
                targetId   = $snapshot['MailboxKey']
                targetName = $snapshot['TargetName']
                timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                before     = $snapshot['Before']
                after      = $after
            }
            success          = $true
        }
    }

    $plan = [pscustomobject]@{
        action               = $Action
        tagId                = $tagKey
        affectedMailboxes    = @($affectedMailboxes)
        diff                 = @($diff)
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = $false
    }

    if ($DryRun) {
        return $plan
    }

    if (-not $Confirmed) {
        throw "retention.confirm_required: action '$Action' requires explicit confirmation"
    }

    $results = [System.Collections.Generic.List[object]]::new()
    $operations = [System.Collections.Generic.List[object]]::new()
    $auditEvents = [System.Collections.Generic.List[object]]::new()
    foreach ($snapshot in $snapshots) {
        if ($snapshot['AlreadyAssigned']) {
            $results.Add(@{
                mailboxId = $snapshot['MailboxKey']
                status    = 'skipped'
                reason    = 'already assigned; no change applied'
                before    = $snapshot['Before']
                after     = $snapshot['After']
            })
            $operations.Add(@{
                id        = [guid]::NewGuid().ToString()
                tenantId  = $TenantId
                mailboxId = $snapshot['MailboxKey']
                operation = 'retention.assign'
                before    = $snapshot['Before']
                after     = $snapshot['After']
                state     = 'noop'
            })
            continue
        }
        $null = Set-Mailbox -Identity $snapshot['MailboxKey'] -RetentionPolicy $retentionValue
        $refreshed = Get-EXOMailbox -Identity $snapshot['MailboxKey']
        $after = Get-SetRetentionTagCurrent -Mailbox $refreshed
        $after['retentionTag'] = $tagKey
        $results.Add(@{
            mailboxId = $snapshot['MailboxKey']
            status    = 'assigned'
            before    = $snapshot['Before']
            after     = $after
        })
        $operations.Add(@{
            id        = [guid]::NewGuid().ToString()
            tenantId  = $TenantId
            mailboxId = $snapshot['MailboxKey']
            operation = 'retention.assign'
            before    = $snapshot['Before']
            after     = $after
            state     = 'applied'
        })
        $auditEvents.Add(@{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = 'retention.assign'
            targetId   = $snapshot['MailboxKey']
            targetName = $snapshot['TargetName']
            timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            before     = $snapshot['Before']
            after      = $after
        })
    }

    return [pscustomobject]@{
        plan              = $plan
        results           = @($results)
        mailboxOperations = @($operations)
        auditEvents       = @($auditEvents)
        success           = $true
    }
}
