# Set-Mailbox.ps1 — EPIC-020 shared-mailbox create/convert worker (SPEC §4.1, §5, §6, §11.1; T-0382).
#
# Covers create (New-Mailbox -Shared) and convert (Set-Mailbox -Type Shared).
# Supports DryRun (plan preview mode returning diff without mutating). A
# convert of an already-shared mailbox is a structured no-op: success with
# noop set, no EXO write, before equal to after.
#
# Gating (EPIC-006 contract, T-0107): create/convert are not registry CheckId
# commands, so they cannot travel the CheckId-bound executor path. They follow
# the same contract instead — the BFF confirms the plan before dispatch (dryRun
# plans only), -DryRun reports the intended change without writing, -Confirmed
# is re-checked here so a job that skips confirmation cannot apply, every
# apply captures before/after, and every apply emits one audit record. The
# supervisor connects EXO in the child process after materializing the tenant
# credential in-process; this file never touches secrets.

function Get-SetMailboxAlias {
    <#
    .SYNOPSIS
        Derives an EXO alias from a shared-mailbox display name.
    .DESCRIPTION
        Strips characters EXO rejects in an alias and lowercases the result so
        the create body is always well-formed when the caller omits -Alias.
    .PARAMETER DisplayName
        The planned shared-mailbox display name.
    .EXAMPLE
        Get-SetMailboxAlias -DisplayName 'Support Desk'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$DisplayName
    )

    $alias = ([string]$DisplayName).Trim().ToLowerInvariant() -replace '[^a-z0-9._-]', ''
    if ([string]::IsNullOrWhiteSpace($alias)) {
        return 'shared'
    }
    return $alias
}

function Test-SharedMailboxCreateInput {
    <#
    .SYNOPSIS
        Validates one planned shared-mailbox create.
    .DESCRIPTION
        Mirrors the BFF route validation so the worker refuses the same rows
        the BFF would: missing display name, alias characters EXO rejects, and
        malformed primary SMTP addresses. Returns the error list; empty is valid.
    .PARAMETER DisplayName
        Planned display name.
    .PARAMETER Alias
        Planned alias, or empty when the worker should derive one.
    .PARAMETER PrimarySmtpAddress
        Planned primary SMTP address, or empty for EXO default.
    .EXAMPLE
        Test-SharedMailboxCreateInput -DisplayName 'Support Desk' -Alias 'support'
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()]
        [string]$DisplayName = '',

        [Parameter()]
        [string]$Alias = '',

        [Parameter()]
        [string]$PrimarySmtpAddress = ''
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace($DisplayName)) {
        $errors.Add('displayName is required for create')
    }
    if (-not [string]::IsNullOrWhiteSpace($Alias) -and $Alias.Trim() -cnotmatch '^[A-Za-z0-9._-]+$') {
        $errors.Add("alias '$($Alias.Trim())' may only contain letters, digits, dot, underscore, and hyphen")
    }
    if (-not [string]::IsNullOrWhiteSpace($PrimarySmtpAddress) -and $PrimarySmtpAddress.Trim() -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
        $errors.Add("primarySmtpAddress '$($PrimarySmtpAddress.Trim())' must be a valid SMTP address")
    }
    return @($errors)
}

function Get-SetMailboxTypeName {
    <#
    .SYNOPSIS
        Maps EXO RecipientTypeDetails to the EPIC-020 mailbox type vocabulary.
    .PARAMETER RecipientTypeDetails
        The EXO RecipientTypeDetails value.
    .EXAMPLE
        Get-SetMailboxTypeName -RecipientTypeDetails 'SharedMailbox'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$RecipientTypeDetails = ''
    )

    switch ($RecipientTypeDetails.Trim()) {
        'SharedMailbox' { return 'shared' }
        'RoomMailbox' { return 'room' }
        'EquipmentMailbox' { return 'equipment' }
        default { return 'user' }
    }
}

function Read-SetMailboxJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-SetMailbox parameters.
    .DESCRIPTION
        Validates the envelope carries a tenant and an action, then returns the
        mailbox identity, planned create values, confirmation, and dry-run flag.
        The envelope carries references and planned values only.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-SetMailboxJob -Path './run/mailbox-job.json'
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

    return @{
        TenantId           = [string]$json.tenantId
        Action             = [string]$json.action
        MailboxId          = if ($json.mailboxId) { [string]$json.mailboxId } else { '' }
        DisplayName        = if ($json.displayName) { [string]$json.displayName } else { '' }
        Alias              = if ($json.alias) { [string]$json.alias } else { '' }
        PrimarySmtpAddress = if ($json.primarySmtpAddress) { [string]$json.primarySmtpAddress } else { '' }
        Confirmed          = [bool]($json.confirmed -eq $true)
        DryRun             = [bool]($json.dryRun -eq $true)
    }
}

function Invoke-SetMailbox {
    <#
    .SYNOPSIS
        Executes or previews shared-mailbox create/convert with before/after capture.
    .DESCRIPTION
        -DryRun returns the plan with no EXO write. Without -DryRun, -Confirmed
        is required or the apply is refused. Convert reads the current mailbox
        first for the before snapshot; an already-shared mailbox returns a
        structured no-op with no EXO write. Every apply emits one auditEvent
        with before/after for the app audit sink and the MailboxOperation row.
    .PARAMETER TenantId
        Tenant the mailbox belongs to. Carried through to the result envelope.
    .PARAMETER Action
        'create' provisions a shared mailbox; 'convert' converts one to shared.
    .PARAMETER MailboxId
        Mailbox identity for convert.
    .PARAMETER DisplayName
        Display name for create.
    .PARAMETER Alias
        Alias for create; derived from the display name when omitted.
    .PARAMETER PrimarySmtpAddress
        Primary SMTP address for create; EXO default when omitted.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for apply; the BFF confirms the plan before dispatch.
    .EXAMPLE
        Invoke-SetMailbox -TenantId 'tenant-a' -Action 'convert' -MailboxId 'mbx-2' -Confirmed -DryRun
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('create', 'convert')]
        [string]$Action,

        [Parameter()]
        [string]$MailboxId = '',

        [Parameter()]
        [string]$DisplayName = '',

        [Parameter()]
        [string]$Alias = '',

        [Parameter()]
        [string]$PrimarySmtpAddress = '',

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false
    )

    $before = $null
    $after = $null
    $targetName = ''
    $mailboxKey = ''
    $diff = [System.Collections.Generic.List[string]]::new()

    if ($Action -eq 'create') {
        $failures = @(Test-SharedMailboxCreateInput -DisplayName $DisplayName -Alias $Alias -PrimarySmtpAddress $PrimarySmtpAddress)
        if ($failures.Count -gt 0) {
            throw "ValidationFailed: $($failures -join '; ')"
        }
        $resolvedAlias = if ([string]::IsNullOrWhiteSpace($Alias)) {
            Get-SetMailboxAlias -DisplayName $DisplayName
        } else {
            $Alias.Trim()
        }
        $targetName = $DisplayName.Trim()
        $after = @{
            displayName        = $DisplayName.Trim()
            alias              = $resolvedAlias
            primarySmtpAddress = $PrimarySmtpAddress.Trim()
            type               = 'shared'
        }
        $diff.Add("Create shared mailbox '$targetName' (alias '$resolvedAlias')")
    }
    else {
        if ([string]::IsNullOrWhiteSpace($MailboxId)) {
            throw 'ValidationFailed: mailboxId is required for convert'
        }
        $mailboxKey = $MailboxId.Trim()
        $existing = Get-EXOMailbox -Identity $mailboxKey
        if (-not $existing) {
            throw "NotFound: Mailbox '$mailboxKey' not found"
        }
        $currentType = Get-SetMailboxTypeName -RecipientTypeDetails ([string]$existing.RecipientTypeDetails)
        $targetName = [string]$existing.DisplayName
        if ([string]::IsNullOrWhiteSpace($targetName)) {
            $targetName = $mailboxKey
        }
        $before = @{
            id                 = [string]$existing.ExchangeObjectId
            displayName        = $targetName
            primarySmtpAddress = [string]$existing.PrimarySmtpAddress
            type               = $currentType
        }
        if ([string]::IsNullOrWhiteSpace([string]$before['id'])) {
            $before['id'] = $mailboxKey
        }

        if ($currentType -eq 'shared') {
            $after = $before.Clone()
            $diff.Add("Mailbox '$targetName' ($mailboxKey) is already shared; no change applied")
            $plan = [pscustomobject]@{
                action               = $Action
                mailboxId            = $mailboxKey
                targetName           = $targetName
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
            return [pscustomobject]@{
                plan       = $plan
                result     = @{ id = $before['id']; type = 'shared'; noop = $true }
                auditEvent = @{
                    id         = [guid]::NewGuid().ToString()
                    tenantId   = $TenantId
                    action     = 'mailbox.convert'
                    targetId   = [string]$before['id']
                    targetName = $targetName
                    timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                    before     = $before
                    after      = $after
                    note       = 'already shared; no change applied'
                }
                noop       = $true
                success    = $true
            }
        }

        $after = $before.Clone()
        $after['type'] = 'shared'
        $diff.Add("Convert mailbox '$targetName' ($mailboxKey) from $currentType to shared")
    }

    $plan = [pscustomobject]@{
        action               = $Action
        mailboxId            = $mailboxKey
        targetName           = $targetName
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
        throw "mailbox.confirm_required: action '$Action' requires explicit confirmation"
    }

    $appliedResult = $null
    if ($Action -eq 'create') {
        $createParams = @{
            Shared      = $true
            Name        = $targetName
            DisplayName = $targetName
            Alias       = [string]$after['alias']
        }
        if ($PrimarySmtpAddress.Trim().Length -gt 0) {
            $createParams['PrimarySmtpAddress'] = $PrimarySmtpAddress.Trim()
        }
        $appliedResult = New-Mailbox @createParams
        $createdId = [string]$appliedResult.ExchangeObjectId
        if ([string]::IsNullOrWhiteSpace($createdId)) {
            $createdId = [string]$appliedResult.Identity
        }
        if ([string]::IsNullOrWhiteSpace($createdId)) {
            $createdId = [string]$appliedResult.PrimarySmtpAddress
        }
        $after = @{
            id                 = $createdId
            displayName        = $targetName
            alias              = [string]$after['alias']
            primarySmtpAddress = [string]$appliedResult.PrimarySmtpAddress
            type               = 'shared'
        }
        $mailboxKey = $createdId
        $appliedResult = @{ id = $createdId; displayName = $targetName; type = 'shared' }
    }
    else {
        $null = Set-Mailbox -Identity $mailboxKey -Type Shared
        $refreshed = Get-EXOMailbox -Identity $mailboxKey
        $after = @{
            id                 = [string]$before['id']
            displayName        = $targetName
            primarySmtpAddress = [string]$refreshed.PrimarySmtpAddress
            type               = 'shared'
        }
        $appliedResult = @{ id = $after['id']; displayName = $targetName; type = 'shared' }
    }

    $plan = [pscustomobject]@{
        action               = $Action
        mailboxId            = $mailboxKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $false
        requiresConfirmation = $false
    }

    return [pscustomobject]@{
        plan       = $plan
        result     = $appliedResult
        auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = "mailbox.$Action"
            targetId   = $mailboxKey
            targetName = $targetName
            timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            before     = $before
            after      = $after
        }
        success    = $true
    }
}
