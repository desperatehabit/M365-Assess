# Set-TransportRule.ps1 — EPIC-021 transport-rule create/edit/delete worker (SPEC §2 US-1, §4.1, §4.3, §6, §8; T-0402).
#
# Covers create, edit, and delete of tenant transport rules (New-/Set-/Remove-TransportRule),
# including enable/disable and explicit priority changes. Supports DryRun (plan preview
# returning the rule JSON without mutating). An edit that changes nothing is a
# structured no-op: success with noop set, no EXO write, before equal to after.
#
# Gating (EPIC-006 contract, T-0107): rule writes are not registry CheckId commands,
# so they cannot travel the CheckId-bound executor path. They follow the same contract
# instead — the BFF confirms the plan before dispatch (dryRun plans only), -DryRun
# reports the intended change without writing, -Confirmed is re-checked here so a job
# that skips confirmation cannot apply, every apply captures before/after, and every
# apply emits one audit record. The condition/action builder validates every field
# against the adopted common set (SPEC §11.1) and rejects anything outside it with a
# structured error, never silently dropping it. The supervisor connects EXO in the
# child process after materializing the tenant credential in-process; this file never
# touches secrets.

$script:TransportRuleConditionNames = @(
    'From', 'FromMemberOf', 'FromScope', 'SentTo', 'SentToMemberOf', 'SentToScope',
    'SubjectContainsWords', 'SubjectOrBodyContainsWords', 'HeaderContainsMessageHeader',
    'HasAttachment', 'MessageSizeOver', 'AttachmentExtensionMatchesWords', 'RecipientDomainIs'
)
$script:TransportRuleActionNames = @(
    'AddToRecipients', 'BlindCopyTo', 'CopyTo', 'ModerateMessageByUser', 'RedirectMessageTo',
    'RejectMessageReasonText', 'DeleteMessage', 'Quarantine', 'PrependSubject', 'SetHeaderName',
    'ApplyHtmlDisclaimerText', 'ApplyHtmlDisclaimerFallbackAction', 'RouteMessageOutboundConnector'
)
$script:TransportRuleExceptionNames = @(
    'ExceptIfFrom', 'ExceptIfFromMemberOf', 'ExceptIfFromScope', 'ExceptIfSentTo',
    'ExceptIfSentToMemberOf', 'ExceptIfSubjectContainsWords', 'ExceptIfSubjectOrBodyContainsWords',
    'ExceptIfHasAttachment', 'ExceptIfRecipientDomainIs'
)

function ConvertFrom-TransportRuleFieldsJson {
    <#
    .SYNOPSIS
        Parses a condition/action/exception JSON object into a hashtable.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [string]$Json = ''
    )

    if ([string]::IsNullOrWhiteSpace($Json)) {
        return @{}
    }
    $parsed = $Json | ConvertFrom-Json -AsHashtable
    if ($null -eq $parsed) {
        return @{}
    }
    return $parsed
}

function Test-TransportRuleInput {
    <#
    .SYNOPSIS
        Validates one planned transport-rule create, edit, or delete.
    .DESCRIPTION
        Mirrors the BFF route validation so the worker refuses the same rows the
        BFF would: create needs a rule name, edit and delete need the rule id,
        edit needs at least one field to change, priority is non-negative, and
        every condition/action/exception key must be in the adopted common set.
        Returns the error list; empty is valid.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('create', 'edit', 'delete')]
        [string]$Action,

        [string]$RuleId = '',

        [string]$Name = '',

        [Nullable[bool]]$Enabled = $null,

        [Nullable[int]]$Priority = $null,

        [string]$ConditionsJson = '',

        [string]$ActionsJson = '',

        [string]$ExceptionsJson = ''
    )

    $errors = [System.Collections.Generic.List[string]]::new()
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
            (-not [string]::IsNullOrWhiteSpace($ConditionsJson)) -or
            (-not [string]::IsNullOrWhiteSpace($ActionsJson)) -or
            (-not [string]::IsNullOrWhiteSpace($ExceptionsJson))
        if (-not $hasChange) {
            $errors.Add('at least one rule field must be supplied for edit')
        }
    }
    if ($null -ne $Priority -and $Priority -lt 0) {
        $errors.Add('priority must be a non-negative integer')
    }

    $conditions = ConvertFrom-TransportRuleFieldsJson -Json $ConditionsJson
    $actions = ConvertFrom-TransportRuleFieldsJson -Json $ActionsJson
    $exceptions = ConvertFrom-TransportRuleFieldsJson -Json $ExceptionsJson
    foreach ($key in $conditions.Keys) {
        if ($script:TransportRuleConditionNames -notcontains $key) {
            $errors.Add("unsupported condition '$key'")
        }
    }
    foreach ($key in $actions.Keys) {
        if ($script:TransportRuleActionNames -notcontains $key) {
            $errors.Add("unsupported action '$key'")
        }
    }
    foreach ($key in $exceptions.Keys) {
        if ($script:TransportRuleExceptionNames -notcontains $key) {
            $errors.Add("unsupported exception '$key'")
        }
    }
    return @($errors)
}

function ConvertTo-TransportRuleFieldGroups {
    <#
    .SYNOPSIS
        Extracts the common condition, action, and exception fields present on a rule.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [object]$Rule
    )

    $conditions = @{}
    foreach ($name in $script:TransportRuleConditionNames) {
        $value = $Rule.$name
        if ($null -ne $value) {
            $conditions[$name] = $value
        }
    }
    $actions = @{}
    foreach ($name in $script:TransportRuleActionNames) {
        $value = $Rule.$name
        if ($null -ne $value) {
            $actions[$name] = $value
        }
    }
    $exceptions = @{}
    foreach ($name in $script:TransportRuleExceptionNames) {
        $value = $Rule.$name
        if ($null -ne $value) {
            $exceptions[$name] = $value
        }
    }
    return @{
        conditions = $conditions
        actions    = $actions
        exceptions = $exceptions
    }
}

function ConvertTo-TransportRuleSnapshot {
    <#
    .SYNOPSIS
        Normalizes an EXO transport rule to the before/after snapshot shape.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [object]$Rule
    )

    $groups = ConvertTo-TransportRuleFieldGroups -Rule $Rule
    return @{
        identity   = [string]$Rule.Identity
        name       = [string]$Rule.Name
        enabled    = ([string]$Rule.State -eq 'Enabled')
        priority   = $Rule.Priority
        conditions = $groups['conditions']
        actions    = $groups['actions']
        exceptions = $groups['exceptions']
    }
}

function Find-TransportRule {
    <#
    .SYNOPSIS
        Reads one transport rule by id, or returns null when absent.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$RuleId
    )

    $rules = @(Get-TransportRule -ErrorAction Stop)
    foreach ($rule in $rules) {
        if ([string]$rule.Identity -eq $RuleId -or [string]$rule.Guid -eq $RuleId -or [string]$rule.Name -eq $RuleId) {
            return $rule
        }
    }
    return $null
}

function Read-SetTransportRuleJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-SetTransportRule parameters.
    .DESCRIPTION
        Validates the envelope carries a tenant and an action, then returns the
        rule identity, planned values, confirmation, and dry-run flag. The
        envelope carries references and planned values only.
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

    $enabled = $null
    if ($null -ne $json.enabled) {
        $enabled = [bool]$json.enabled
    }
    $priority = $null
    if ($null -ne $json.priority) {
        $priority = [int]$json.priority
    }

    return @{
        TenantId       = [string]$json.tenantId
        Action         = [string]$json.action
        RuleId         = if ($json.ruleId) { [string]$json.ruleId } else { '' }
        Name           = if ($json.name) { [string]$json.name } else { '' }
        Enabled        = $enabled
        Priority       = $priority
        ConditionsJson = if ($json.conditionsJson) { [string]$json.conditionsJson } else { '' }
        ActionsJson    = if ($json.actionsJson) { [string]$json.actionsJson } else { '' }
        ExceptionsJson = if ($json.exceptionsJson) { [string]$json.exceptionsJson } else { '' }
        Confirmed      = [bool]($json.confirmed -eq $true)
        DryRun         = [bool]($json.dryRun -eq $true)
    }
}

function Invoke-SetTransportRule {
    <#
    .SYNOPSIS
        Executes or previews transport-rule create/edit/delete with before/after capture.
    .DESCRIPTION
        -DryRun returns the plan with the rule JSON and no EXO write. Without
        -DryRun, -Confirmed is required or the apply is refused. Edit reads the
        current rule first for the before snapshot; an edit that changes nothing
        returns a structured no-op with no EXO write. Every apply emits one
        auditEvent with before/after for the app audit sink.
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

        [string]$RuleId = '',

        [string]$Name = '',

        [Nullable[bool]]$Enabled = $null,

        [Nullable[int]]$Priority = $null,

        [string]$ConditionsJson = '',

        [string]$ActionsJson = '',

        [string]$ExceptionsJson = '',

        [bool]$DryRun = $false,

        [bool]$Confirmed = $false
    )

    $failures = @(Test-TransportRuleInput -Action $Action -RuleId $RuleId -Name $Name -Enabled $Enabled -Priority $Priority -ConditionsJson $ConditionsJson -ActionsJson $ActionsJson -ExceptionsJson $ExceptionsJson)
    if ($failures.Count -gt 0) {
        throw "ValidationFailed: $($failures -join '; ')"
    }

    $conditions = ConvertFrom-TransportRuleFieldsJson -Json $ConditionsJson
    $actions = ConvertFrom-TransportRuleFieldsJson -Json $ActionsJson
    $exceptions = ConvertFrom-TransportRuleFieldsJson -Json $ExceptionsJson

    $before = $null
    $after = $null
    $targetName = ''
    $ruleKey = ''
    $diff = [System.Collections.Generic.List[string]]::new()

    if ($Action -eq 'create') {
        $targetName = $Name.Trim()
        $after = @{
            identity   = $null
            name       = $targetName
            enabled    = if ($null -ne $Enabled) { [bool]$Enabled } else { $true }
            priority   = if ($null -ne $Priority) { [int]$Priority } else { 0 }
            conditions = $conditions
            actions    = $actions
            exceptions = $exceptions
        }
        $diff.Add("Create transport rule '$targetName'")
    }
    else {
        $ruleKey = $RuleId.Trim()
        $existing = Find-TransportRule -RuleId $ruleKey
        if ($null -eq $existing) {
            throw "NotFound: Transport rule '$ruleKey' not found"
        }
        $before = ConvertTo-TransportRuleSnapshot -Rule $existing
        $targetName = [string]$before['name']
        if ([string]::IsNullOrWhiteSpace($targetName)) {
            $targetName = $ruleKey
        }

        if ($Action -eq 'delete') {
            $diff.Add("Remove transport rule '$targetName' ($ruleKey)")
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
                $after['priority'] = [int]$Priority
            }
            if ($conditions.Count -gt 0) {
                $after['conditions'] = $conditions
            }
            if ($actions.Count -gt 0) {
                $after['actions'] = $actions
            }
            if ($exceptions.Count -gt 0) {
                $after['exceptions'] = $exceptions
            }
            foreach ($field in @('name', 'enabled', 'priority')) {
                if ("$($before[$field])" -ne "$($after[$field])") {
                    $diff.Add("Set $field from '$($before[$field])' to '$($after[$field])' on rule '$targetName' ($ruleKey)")
                }
            }
            if ($diff.Count -eq 0) {
                $diff.Add("Rule '$targetName' ($ruleKey) is already at the requested state; no change applied")
                $plan = [pscustomobject]@{
                    action               = $Action
                    ruleId               = $ruleKey
                    targetName           = $targetName
                    before               = $before
                    after                = $after
                    diff                 = @($diff)
                    valid                = $true
                    dryRun               = $DryRun
                    requiresConfirmation = $true
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
                        action     = 'transport.rule.edit'
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

    $plan = [pscustomobject]@{
        action               = $Action
        ruleId               = if ($ruleKey) { $ruleKey } else { $null }
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = $true
    }

    if ($DryRun) {
        return $plan
    }

    if (-not $Confirmed) {
        throw "transport.rule_confirm_required: action '$Action' requires explicit confirmation"
    }

    $appliedResult = $null
    if ($Action -eq 'create') {
        $createParams = @{
            Name = $targetName
        }
        if ($null -ne $Enabled) {
            $createParams['Enabled'] = [bool]$Enabled
        }
        if ($null -ne $Priority) {
            $createParams['Priority'] = [int]$Priority
        }
        foreach ($k in $conditions.Keys) {
            $createParams[$k] = $conditions[$k]
        }
        foreach ($k in $actions.Keys) {
            $createParams[$k] = $actions[$k]
        }
        foreach ($k in $exceptions.Keys) {
            $createParams[$k] = $exceptions[$k]
        }
        $created = New-TransportRule @createParams
        $ruleKey = [string]$created.Identity
        if ([string]::IsNullOrWhiteSpace($ruleKey)) {
            $relisted = @(Get-TransportRule -ErrorAction Stop) |
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
        foreach ($k in $conditions.Keys) {
            $editParams[$k] = $conditions[$k]
        }
        foreach ($k in $actions.Keys) {
            $editParams[$k] = $actions[$k]
        }
        foreach ($k in $exceptions.Keys) {
            $editParams[$k] = $exceptions[$k]
        }
        $null = Set-TransportRule @editParams
        $refreshed = Find-TransportRule -RuleId $ruleKey
        if ($null -ne $refreshed) {
            $after = ConvertTo-TransportRuleSnapshot -Rule $refreshed
        }
        $appliedResult = @{ id = $ruleKey; name = $targetName }
    }
    else {
        $null = Remove-TransportRule -Identity $ruleKey -Confirm:$false
        $appliedResult = @{ id = $ruleKey; name = $targetName; deleted = $true }
    }

    $plan = [pscustomobject]@{
        action               = $Action
        ruleId               = $ruleKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $false
        requiresConfirmation = $true
    }

    return [pscustomobject]@{
        plan       = $plan
        result     = $appliedResult
        auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = "transport.rule.$Action"
            targetId   = $ruleKey
            targetName = $targetName
            timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            before     = $before
            after      = $after
        }
        success    = $true
    }
}
