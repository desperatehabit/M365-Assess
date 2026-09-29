# Set-MailboxRule.ps1 — EPIC-020 inbox-rule add/edit/remove worker (SPEC §2 US-5, §3.4, §4.1, §6, §9; T-0385).
#
# Covers create, edit, and delete of per-mailbox inbox rules (New-/Set-/Remove-InboxRule).
# Supports DryRun (plan preview mode returning diff without mutating). An edit that
# changes nothing is a structured no-op: success with noop set, no EXO write,
# before equal to after.
#
# Gating (EPIC-006 contract, T-0107): rule writes are not registry CheckId
# commands, so they cannot travel the CheckId-bound executor path. They follow
# the same contract instead — the BFF confirms the plan before dispatch (dryRun
# plans only), -DryRun reports the intended change without writing, -Confirmed
# is re-checked here so a job that skips confirmation cannot apply, every
# apply captures before/after, and every apply emits one audit record. A
# forwarding-enabling change is security-sensitive (BEC vector, SPEC §9): the
# plan carries the warning with requiresConfirmation so the warning surfaces
# before apply. The supervisor connects EXO in the child process after
# materializing the tenant credential in-process; this file never touches secrets.

function Test-RuleTargetPresent {
    <#
    .SYNOPSIS
        Reports whether an inbox-rule forwarding field carries a target.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return $false
    }
    if ($Value -is [string]) {
        return ([string]$Value).Trim().Length -gt 0
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        return @($Value).Count -gt 0
    }
    return $true
}

function Test-RuleForwardsMail {
    <#
    .SYNOPSIS
        Reports whether a rule snapshot forwards mail to another recipient.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [hashtable]$Rule
    )

    if ($null -eq $Rule) {
        return $false
    }
    return (Test-RuleTargetPresent -Value $Rule['forwardTo']) -or
        (Test-RuleTargetPresent -Value $Rule['forwardAsAttachmentTo']) -or
        (Test-RuleTargetPresent -Value $Rule['redirectTo'])
}

function Test-MailboxRuleChangeSensitive {
    <#
    .SYNOPSIS
        Classifies a rule change as security-sensitive (BEC vector, SPEC §9).
    .DESCRIPTION
        Mirrors the BFF forwarding guard: a forwarding-enabling change (or any
        touch of a rule that forwards or deletes mail) forces the warning path
        with requiresConfirmation so the operator reviews the target before apply.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('create', 'edit', 'delete')]
        [string]$Action,

        [Parameter()]
        [hashtable]$Before,

        [Parameter()]
        [hashtable]$After
    )

    $warning = 'Forwarding change is security-sensitive (BEC vector): review the forwarding target before applying. This change is audited with before/after.'
    $sensitive = { param([string]$Reason) return [pscustomobject]@{
        securitySensitive     = $true
        requiresConfirmation  = $true
        warning               = $warning
        reasons               = @($Reason)
    } }.GetNewClosure()

    if ($Action -eq 'create') {
        if (Test-RuleForwardsMail -Rule $After) {
            return (& $sensitive 'new rule forwards mail to an external target')
        }
        if ($null -ne $After -and $After['deleteMessage'] -eq $true) {
            return (& $sensitive 'new rule deletes matching mail')
        }
        return [pscustomobject]@{ securitySensitive = $false; requiresConfirmation = $false; warning = $null; reasons = @() }
    }

    if ($Action -eq 'delete') {
        if (Test-RuleForwardsMail -Rule $Before) {
            return (& $sensitive 'removed rule forwarded mail to an external target')
        }
        if ($null -ne $Before -and $Before['deleteMessage'] -eq $true) {
            return (& $sensitive 'removed rule deleted matching mail')
        }
        return [pscustomobject]@{ securitySensitive = $false; requiresConfirmation = $false; warning = $null; reasons = @() }
    }

    $beforeForwarded = Test-RuleForwardsMail -Rule $Before
    $afterForwarded = Test-RuleForwardsMail -Rule $After
    if ((-not $beforeForwarded) -and $afterForwarded) {
        return (& $sensitive 'edit enables forwarding on the rule')
    }
    if ($afterForwarded -and $null -ne $Before -and $Before['enabled'] -eq $false -and $After['enabled'] -ne $false) {
        return (& $sensitive 'edit enables a rule that forwards mail')
    }
    $beforeDeletes = ($null -ne $Before -and $Before['deleteMessage'] -eq $true)
    $afterDeletes = ($null -ne $After -and $After['deleteMessage'] -eq $true)
    if ((-not $beforeDeletes) -and $afterDeletes) {
        return (& $sensitive 'edit enables deletion of matching mail')
    }
    if ($beforeForwarded -or $afterForwarded) {
        return (& $sensitive 'edit touches a rule that forwards mail')
    }
    return [pscustomobject]@{ securitySensitive = $false; requiresConfirmation = $false; warning = $null; reasons = @() }
}

function Test-MailboxRuleInput {
    <#
    .SYNOPSIS
        Validates one planned inbox-rule create, edit, or delete.
    .DESCRIPTION
        Mirrors the BFF route validation so the worker refuses the same rows
        the BFF would: create needs a rule name, edit and delete need the rule
        id, and edit needs at least one field to change. Returns the error list;
        empty is valid.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('create', 'edit', 'delete')]
        [string]$Action,

        [Parameter()]
        [string]$MailboxId = '',

        [Parameter()]
        [string]$RuleId = '',

        [Parameter()]
        [string]$Name = '',

        [Parameter()]
        [Nullable[bool]]$Enabled = $null,

        [Parameter()]
        [Nullable[int]]$Priority = $null,

        [Parameter()]
        [string]$ForwardTo = '',

        [Parameter()]
        [string]$ForwardAsAttachmentTo = '',

        [Parameter()]
        [string]$RedirectTo = '',

        [Parameter()]
        [Nullable[bool]]$DeleteMessage = $null
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace($MailboxId)) {
        $errors.Add('mailboxId is required')
    }
    if ($Action -eq 'create' -and [string]::IsNullOrWhiteSpace($Name)) {
        $errors.Add('name is required for create')
    }
    if (($Action -eq 'edit' -or $Action -eq 'delete') -and [string]::IsNullOrWhiteSpace($RuleId)) {
        $errors.Add("ruleId is required for $Action")
    }
    if ($Action -eq 'edit') {
        $hasChange = (-not [string]::IsNullOrWhiteSpace($Name)) -or
            ($null -ne $Enabled) -or
            ($null -ne $Priority) -or
            (-not [string]::IsNullOrWhiteSpace($ForwardTo)) -or
            (-not [string]::IsNullOrWhiteSpace($ForwardAsAttachmentTo)) -or
            (-not [string]::IsNullOrWhiteSpace($RedirectTo)) -or
            ($null -ne $DeleteMessage)
        if (-not $hasChange) {
            $errors.Add('at least one rule field must be supplied for edit')
        }
    }
    if ($null -ne $Priority -and $Priority -lt 0) {
        $errors.Add('priority must be a non-negative integer')
    }
    return @($errors)
}

function ConvertTo-MailboxRuleSnapshot {
    <#
    .SYNOPSIS
        Normalizes an EXO inbox rule to the before/after snapshot shape.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [object]$Rule
    )

    return @{
        identity              = [string]$Rule.Identity
        name                  = [string]$Rule.Name
        enabled               = ($Rule.Enabled -eq $true)
        priority              = $Rule.Priority
        forwardTo             = $Rule.ForwardTo
        forwardAsAttachmentTo = $Rule.ForwardAsAttachmentTo
        redirectTo            = $Rule.RedirectTo
        deleteMessage         = ($Rule.DeleteMessage -eq $true)
    }
}

function Find-MailboxRule {
    <#
    .SYNOPSIS
        Reads one inbox rule for a mailbox, or returns null when absent.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$RuleId
    )

    $rules = @(Get-InboxRule -Mailbox $MailboxId -ErrorAction Stop)
    foreach ($rule in $rules) {
        if ([string]$rule.Identity -eq $RuleId) {
            return $rule
        }
    }
    return $null
}

function Read-SetMailboxRuleJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-SetMailboxRule parameters.
    .DESCRIPTION
        Validates the envelope carries a tenant, an action, and a mailbox, then
        returns the rule identity, planned values, confirmation, and dry-run
        flag. The envelope carries references and planned values only.
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
    if (-not $json.mailboxId) {
        throw "job envelope '$Path' is missing mandatory 'mailboxId'"
    }

    $enabled = $null
    if ($null -ne $json.enabled) {
        $enabled = [bool]$json.enabled
    }
    $priority = $null
    if ($null -ne $json.priority) {
        $priority = [int]$json.priority
    }
    $deleteMessage = $null
    if ($null -ne $json.deleteMessage) {
        $deleteMessage = [bool]$json.deleteMessage
    }

    return @{
        TenantId              = [string]$json.tenantId
        Action                = [string]$json.action
        MailboxId             = [string]$json.mailboxId
        RuleId                = if ($json.ruleId) { [string]$json.ruleId } else { '' }
        Name                  = if ($json.name) { [string]$json.name } else { '' }
        Enabled               = $enabled
        Priority              = $priority
        ForwardTo             = if ($json.forwardTo) { [string]$json.forwardTo } else { '' }
        ForwardAsAttachmentTo = if ($json.forwardAsAttachmentTo) { [string]$json.forwardAsAttachmentTo } else { '' }
        RedirectTo            = if ($json.redirectTo) { [string]$json.redirectTo } else { '' }
        DeleteMessage         = $deleteMessage
        Confirmed             = [bool]($json.confirmed -eq $true)
        DryRun                = [bool]($json.dryRun -eq $true)
    }
}

function Invoke-SetMailboxRule {
    <#
    .SYNOPSIS
        Executes or previews inbox-rule create/edit/delete with before/after capture.
    .DESCRIPTION
        -DryRun returns the plan with no EXO write. Without -DryRun, -Confirmed
        is required or the apply is refused. Edit reads the current rule first
        for the before snapshot; an edit that changes nothing returns a
        structured no-op with no EXO write. Every apply emits one auditEvent
        with before/after for the app audit sink and the MailboxOperation row.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('create', 'edit', 'delete')]
        [string]$Action,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MailboxId,

        [Parameter()]
        [string]$RuleId = '',

        [Parameter()]
        [string]$Name = '',

        [Parameter()]
        [Nullable[bool]]$Enabled = $null,

        [Parameter()]
        [Nullable[int]]$Priority = $null,

        [Parameter()]
        [string]$ForwardTo = '',

        [Parameter()]
        [string]$ForwardAsAttachmentTo = '',

        [Parameter()]
        [string]$RedirectTo = '',

        [Parameter()]
        [Nullable[bool]]$DeleteMessage = $null,

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false
    )

    $failures = @(Test-MailboxRuleInput -Action $Action -MailboxId $MailboxId -RuleId $RuleId -Name $Name -Enabled $Enabled -Priority $Priority -ForwardTo $ForwardTo -ForwardAsAttachmentTo $ForwardAsAttachmentTo -RedirectTo $RedirectTo -DeleteMessage $DeleteMessage)
    if ($failures.Count -gt 0) {
        throw "ValidationFailed: $($failures -join '; ')"
    }
    $mailboxKey = $MailboxId.Trim()

    $before = $null
    $after = $null
    $targetName = ''
    $ruleKey = ''
    $diff = [System.Collections.Generic.List[string]]::new()

    if ($Action -eq 'create') {
        $targetName = $Name.Trim()
        $after = @{
            identity              = $null
            name                  = $targetName
            enabled               = if ($null -ne $Enabled) { [bool]$Enabled } else { $true }
            priority              = $Priority
            forwardTo             = $ForwardTo.Trim()
            forwardAsAttachmentTo = $ForwardAsAttachmentTo.Trim()
            redirectTo            = $RedirectTo.Trim()
            deleteMessage         = ($null -ne $DeleteMessage -and $DeleteMessage -eq $true)
        }
        $diff.Add("Create inbox rule '$targetName' on mailbox '$mailboxKey'")
    }
    else {
        $ruleKey = $RuleId.Trim()
        $existing = Find-MailboxRule -MailboxId $mailboxKey -RuleId $ruleKey
        if ($null -eq $existing) {
            throw "NotFound: Inbox rule '$ruleKey' not found on mailbox '$mailboxKey'"
        }
        $before = ConvertTo-MailboxRuleSnapshot -Rule $existing
        $targetName = [string]$before['name']
        if ([string]::IsNullOrWhiteSpace($targetName)) {
            $targetName = $ruleKey
        }

        if ($Action -eq 'delete') {
            $diff.Add("Remove inbox rule '$targetName' ($ruleKey) from mailbox '$mailboxKey'")
        }
        else {
            $after = $before.Clone()
            if (-not [string]::IsNullOrWhiteSpace($Name)) {
                $after['name'] = $Name.Trim()
            }
            if ($null -ne $Enabled) {
                $after['enabled'] = [bool]$Enabled
            }
            if ($null -ne $Priority) {
                $after['priority'] = $Priority
            }
            if (-not [string]::IsNullOrWhiteSpace($ForwardTo)) {
                $after['forwardTo'] = $ForwardTo.Trim()
            }
            if (-not [string]::IsNullOrWhiteSpace($ForwardAsAttachmentTo)) {
                $after['forwardAsAttachmentTo'] = $ForwardAsAttachmentTo.Trim()
            }
            if (-not [string]::IsNullOrWhiteSpace($RedirectTo)) {
                $after['redirectTo'] = $RedirectTo.Trim()
            }
            if ($null -ne $DeleteMessage) {
                $after['deleteMessage'] = [bool]$DeleteMessage
            }
            foreach ($field in @('name', 'enabled', 'priority', 'forwardTo', 'forwardAsAttachmentTo', 'redirectTo', 'deleteMessage')) {
                if ("$($before[$field])" -ne "$($after[$field])") {
                    $diff.Add("Set $field from '$($before[$field])' to '$($after[$field])' on rule '$targetName' ($ruleKey)")
                }
            }
            if ($diff.Count -eq 0) {
                $diff.Add("Rule '$targetName' ($ruleKey) is already at the requested state; no change applied")
                $guard = Test-MailboxRuleChangeSensitive -Action 'edit' -Before $before -After $after
                $plan = [pscustomobject]@{
                    action               = $Action
                    mailboxId            = $mailboxKey
                    ruleId               = $ruleKey
                    targetName           = $targetName
                    before               = $before
                    after                = $after
                    diff                 = @($diff)
                    valid                = $true
                    dryRun               = $DryRun
                    requiresConfirmation = [bool]$guard.requiresConfirmation
                    securitySensitive    = [bool]$guard.securitySensitive
                    warning              = $guard.warning
                }
                if ($DryRun) {
                    return $plan
                }
                return [pscustomobject]@{
                    plan       = $plan
                    result     = @{ id = $ruleKey; name = $targetName; noop = $true }
                    auditEvent = @{
                        id         = [guid]::NewGuid().ToString()
                        tenantId   = $TenantId
                        action     = 'mailbox.rule.edit'
                        targetId   = $ruleKey
                        targetName = $targetName
                        timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                        before     = $before
                        after      = $after
                        note       = 'already at the requested state; no change applied'
                    }
                    noop       = $true
                    success    = $true
                }
            }
        }
    }

    $guard = Test-MailboxRuleChangeSensitive -Action $Action -Before $before -After $after
    $plan = [pscustomobject]@{
        action               = $Action
        mailboxId            = $mailboxKey
        ruleId               = $ruleKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = [bool]$guard.requiresConfirmation
        securitySensitive    = [bool]$guard.securitySensitive
        warning              = $guard.warning
    }

    if ($DryRun) {
        return $plan
    }

    if (-not $Confirmed) {
        throw "mailbox.rule_confirm_required: action '$Action' requires explicit confirmation"
    }

    $appliedResult = $null
    if ($Action -eq 'create') {
        $createParams = @{
            Mailbox = $mailboxKey
            Name    = $targetName
        }
        if (-not [string]::IsNullOrWhiteSpace($ForwardTo)) {
            $createParams['ForwardTo'] = $ForwardTo.Trim()
        }
        if (-not [string]::IsNullOrWhiteSpace($ForwardAsAttachmentTo)) {
            $createParams['ForwardAsAttachmentTo'] = $ForwardAsAttachmentTo.Trim()
        }
        if (-not [string]::IsNullOrWhiteSpace($RedirectTo)) {
            $createParams['RedirectTo'] = $RedirectTo.Trim()
        }
        if ($null -ne $DeleteMessage -and $DeleteMessage -eq $true) {
            $createParams['DeleteMessage'] = $true
        }
        if ($null -ne $Enabled) {
            $createParams['Enabled'] = [bool]$Enabled
        }
        if ($null -ne $Priority) {
            $createParams['Priority'] = [int]$Priority
        }
        $created = New-InboxRule @createParams
        $ruleKey = [string]$created.Identity
        if ([string]::IsNullOrWhiteSpace($ruleKey)) {
            $relisted = @(Get-InboxRule -Mailbox $mailboxKey -ErrorAction Stop) |
                Where-Object { [string]$_.Name -eq $targetName } |
                Select-Object -First 1
            if ($null -ne $relisted) {
                $ruleKey = [string]$relisted.Identity
            }
        }
        $after['identity'] = $ruleKey
        $appliedResult = @{ id = $ruleKey; name = $targetName }
    }
    elseif ($Action -eq 'edit') {
        $editParams = @{ Identity = $ruleKey }
        if (-not [string]::IsNullOrWhiteSpace($Name)) {
            $editParams['Name'] = $Name.Trim()
        }
        if ($null -ne $Enabled) {
            $editParams['Enabled'] = [bool]$Enabled
        }
        if ($null -ne $Priority) {
            $editParams['Priority'] = [int]$Priority
        }
        if (-not [string]::IsNullOrWhiteSpace($ForwardTo)) {
            $editParams['ForwardTo'] = $ForwardTo.Trim()
        }
        if (-not [string]::IsNullOrWhiteSpace($ForwardAsAttachmentTo)) {
            $editParams['ForwardAsAttachmentTo'] = $ForwardAsAttachmentTo.Trim()
        }
        if (-not [string]::IsNullOrWhiteSpace($RedirectTo)) {
            $editParams['RedirectTo'] = $RedirectTo.Trim()
        }
        if ($null -ne $DeleteMessage) {
            $editParams['DeleteMessage'] = [bool]$DeleteMessage
        }
        $null = Set-InboxRule @editParams
        $refreshed = Find-MailboxRule -MailboxId $mailboxKey -RuleId $ruleKey
        if ($null -ne $refreshed) {
            $after = ConvertTo-MailboxRuleSnapshot -Rule $refreshed
        }
        $appliedResult = @{ id = $ruleKey; name = $targetName }
    }
    else {
        $null = Remove-InboxRule -Identity $ruleKey -Confirm:$false
        $appliedResult = @{ id = $ruleKey; name = $targetName; deleted = $true }
    }

    $plan = [pscustomobject]@{
        action               = $Action
        mailboxId            = $mailboxKey
        ruleId               = $ruleKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $false
        requiresConfirmation = [bool]$guard.requiresConfirmation
        securitySensitive    = [bool]$guard.securitySensitive
        warning              = $guard.warning
    }

    return [pscustomobject]@{
        plan       = $plan
        result     = $appliedResult
        auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = "mailbox.rule.$Action"
            targetId   = $ruleKey
            targetName = $targetName
            timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            before     = $before
            after      = $after
        }
        success    = $true
    }
}
