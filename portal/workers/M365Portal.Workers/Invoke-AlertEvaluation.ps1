# Invoke-AlertEvaluation.ps1
# EPIC-029 SPEC.md §4.1, §4.2, §7, §8, §11.4 — batched per-tenant alert
# evaluation (T-0564).
#
# The EPIC-007 alert orchestrator (T-0123) invokes this handler once per tenant.
# It loads the tenant's enabled rules, fetches each distinct log source once for
# the whole batch (§11.4: one fetch per distinct source bounds Graph calls),
# rehydrates each rule's condition rows, and emits an AlertEvent only for rows
# that match. Channel actions are recorded as fired events; the T-0565 delivery
# adapters consume them. Script mode is never executed in this process: a
# matching script-mode rule is dispatched to the EPIC-007 sandbox
# (Invoke-SandboxedScript, T-0126) and the dispatch is audited (§7, §8).
#
# Every tenant-touching dependency is an injectable seam so the unit tests run
# without Graph or a sandbox.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Captured at load: a function's $PSScriptRoot follows the caller, so the
# sandbox dispatch needs the handler's own directory recorded here.
$script:AlertEvaluationRoot = $PSScriptRoot

function Get-AlertEvaluationProperty {
    <#
    .SYNOPSIS
        Reads a property from a hashtable/dictionary or a PSCustomObject.
    #>
    [CmdletBinding()]
    param(
        [Parameter()][AllowNull()][object]$Object,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Test-AlertIsNumber {
    <#
    .SYNOPSIS
        True when the value is a JSON numeric type.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter()][AllowNull()][object]$Value)

    return ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or
        $Value -is [decimal] -or $Value -is [int16] -or $Value -is [single] -or
        $Value -is [byte] -or $Value -is [sbyte] -or $Value -is [uint16] -or
        $Value -is [uint32] -or $Value -is [uint64])
}

function ConvertTo-AlertComparable {
    <#
    .SYNOPSIS
        Stable JSON string for a value, with object keys sorted for equality.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()][AllowNull()][object]$Value,
        [Parameter()][int]$Depth = 0
    )

    if ($null -eq $Value) { return 'null' }
    if ($Depth -gt 12) { return '"<max-depth>"' }
    if ($Value -is [string]) { return ($Value | ConvertTo-Json -Compress) }
    if ((Test-AlertIsNumber -Value $Value) -or $Value -is [bool]) {
        return ($Value | ConvertTo-Json -Compress)
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $pairs = foreach ($key in ($Value.Keys | Sort-Object)) {
            '"{0}":{1}' -f $key, (ConvertTo-AlertComparable -Value $Value[$key] -Depth ($Depth + 1))
        }
        return '{' + (@($pairs) -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = foreach ($item in @($Value)) {
            ConvertTo-AlertComparable -Value $item -Depth ($Depth + 1)
        }
        return '[' + (@($items) -join ',') + ']'
    }
    $properties = @($Value.PSObject.Properties | Where-Object { $_.MemberType -in @('NoteProperty', 'Property') })
    if ($properties.Count -gt 0) {
        $pairs = foreach ($property in ($properties | Sort-Object Name)) {
            '"{0}":{1}' -f $property.Name, (ConvertTo-AlertComparable -Value $property.Value -Depth ($Depth + 1))
        }
        return '{' + (@($pairs) -join ',') + '}'
    }
    return ([string]$Value | ConvertTo-Json -Compress)
}

function Test-AlertValueEqual {
    <#
    .SYNOPSIS
        Deep equality of two JSON values (the `eq`/`ne` semantics).
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()][AllowNull()][object]$Left,
        [Parameter()][AllowNull()][object]$Right
    )

    return (ConvertTo-AlertComparable -Value $Left) -eq (ConvertTo-AlertComparable -Value $Right)
}

function Test-AlertLikeMatch {
    <#
    .SYNOPSIS
        SQL-LIKE match: `%` is any run, `_` is exactly one, case-insensitive.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Pattern
    )

    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append('^')
    foreach ($character in $Pattern.ToCharArray()) {
        if ($character -eq '%') {
            [void]$builder.Append('.*')
        }
        elseif ($character -eq '_') {
            [void]$builder.Append('.')
        }
        else {
            [void]$builder.Append([regex]::Escape([string]$character))
        }
    }
    [void]$builder.Append('$')
    return [regex]::IsMatch($Value, $builder.ToString(), [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function ConvertTo-AlertPropertyBag {
    <#
    .SYNOPSIS
        Normalises a log-source row to a dictionary the condition evaluator reads.
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.IDictionary])]
    param([Parameter()][AllowNull()][object]$Value)

    if ($null -eq $Value) { return @{} }
    if ($Value -is [System.Collections.IDictionary]) { return $Value }
    $bag = @{}
    foreach ($property in $Value.PSObject.Properties) {
        if ($property.MemberType -in @('NoteProperty', 'Property')) {
            $bag[$property.Name] = $property.Value
        }
    }
    return $bag
}

function Test-AlertConditionRow {
    <#
    .SYNOPSIS
        Evaluates one §3.2 condition row against a property bag.
    .DESCRIPTION
        Mirrors the T-0563 operator semantics: a property absent from the bag
        never matches (fail closed); `eq`/`ne` are deep equality; `like` is
        SQL-LIKE; `match` is ECMAScript regex; `gt` is numeric or lexicographic;
        `in` is membership; `contains` is substring or array membership.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()][AllowNull()][object]$Condition,
        [Parameter(Mandatory)][System.Collections.IDictionary]$PropertyBag
    )

    $property = [string](Get-AlertEvaluationProperty -Object $Condition -Name 'property')
    if (-not $property) { return $false }
    if (-not $PropertyBag.Contains($property)) { return $false }
    $value = $PropertyBag[$property]
    $operator = [string](Get-AlertEvaluationProperty -Object $Condition -Name 'operator')
    $inputValue = Get-AlertEvaluationProperty -Object $Condition -Name 'input'

    switch ($operator) {
        'eq' { return (Test-AlertValueEqual -Left $value -Right $inputValue) }
        'ne' { return (-not (Test-AlertValueEqual -Left $value -Right $inputValue)) }
        'like' {
            if ($value -isnot [string] -or $inputValue -isnot [string]) { return $false }
            return (Test-AlertLikeMatch -Value $value -Pattern $inputValue)
        }
        'match' {
            if ($value -isnot [string] -or $inputValue -isnot [string]) { return $false }
            try { return [regex]::IsMatch($value, $inputValue) }
            catch { return $false }
        }
        'gt' {
            if ($value -is [string] -and $inputValue -is [string]) {
                return ([string]::CompareOrdinal($value, $inputValue) -gt 0)
            }
            if ((Test-AlertIsNumber -Value $value) -and (Test-AlertIsNumber -Value $inputValue)) {
                return ([double]$value -gt [double]$inputValue)
            }
            return $false
        }
        'in' {
            if ($null -eq $inputValue -or $inputValue -is [string] -or -not ($inputValue -is [System.Collections.IEnumerable])) {
                return $false
            }
            foreach ($candidate in @($inputValue)) {
                if (Test-AlertValueEqual -Left $value -Right $candidate) { return $true }
            }
            return $false
        }
        'contains' {
            if ($value -is [string]) {
                return (($inputValue -is [string]) -and $value.Contains($inputValue))
            }
            if ($value -is [System.Collections.IEnumerable]) {
                foreach ($candidate in @($value)) {
                    if (Test-AlertValueEqual -Left $candidate -Right $inputValue) { return $true }
                }
            }
            return $false
        }
        default { return $false }
    }
}

function Test-AlertConditionSet {
    <#
    .SYNOPSIS
        True when every condition row matches (AND; an empty set matches).
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()][AllowNull()][object[]]$Conditions = @(),
        [Parameter(Mandatory)][System.Collections.IDictionary]$PropertyBag
    )

    foreach ($condition in @($Conditions)) {
        if ($null -eq $condition) { continue }
        if (-not (Test-AlertConditionRow -Condition $condition -PropertyBag $PropertyBag)) {
            return $false
        }
    }
    return $true
}

function Get-AlertRuleConditions {
    <#
    .SYNOPSIS
        Rehydrates a rule's condition rows from objects or a JSON string.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param([Parameter()][AllowNull()][object]$Rule)

    $conditions = Get-AlertEvaluationProperty -Object $Rule -Name 'conditions'
    if ($null -eq $conditions) { return @() }
    if ($conditions -is [string]) {
        if ([string]::IsNullOrWhiteSpace($conditions)) { return @() }
        return @($conditions | ConvertFrom-Json)
    }
    # A single condition row is a dictionary and would otherwise unroll into its
    # values under @(); a set of rows is an array and is returned as-is.
    if ($conditions -is [System.Collections.IDictionary]) { return @(, $conditions) }
    return @($conditions)
}

function Get-AlertScriptAction {
    <#
    .SYNOPSIS
        Returns the first script-mode action of a rule, or $null.
    #>
    [CmdletBinding()]
    param([Parameter()][AllowNull()][object]$Rule)

    $actions = Get-AlertEvaluationProperty -Object $Rule -Name 'actions'
    if ($null -eq $actions) { return $null }
    if ($actions -is [string]) {
        if ([string]::IsNullOrWhiteSpace($actions)) { return $null }
        $actions = @($actions | ConvertFrom-Json)
    }
    if ($actions -is [System.Collections.IDictionary]) { $actions = @(, $actions) }
    foreach ($action in @($actions)) {
        if ((Get-AlertEvaluationProperty -Object $action -Name 'kind') -eq 'script') {
            return $action
        }
    }
    return $null
}

function Resolve-AlertScriptContent {
    <#
    .SYNOPSIS
        Resolves the script text a script-mode action should run in the sandbox.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][object]$Rule,
        [Parameter(Mandatory)][object]$Action,
        [Parameter()][scriptblock]$Resolver
    )

    if ($Resolver) {
        return [string](& $Resolver $Rule $Action)
    }
    return [string](Get-AlertEvaluationProperty -Object $Action -Name 'scriptContent')
}

function Invoke-AlertSandboxedScript {
    <#
    .SYNOPSIS
        Dispatches a matching script-mode rule to the EPIC-007 sandbox.
    .DESCRIPTION
        This is the default script-mode seam: it hands the rule's script text to
        Invoke-SandboxedScript (T-0126), which admits it through the allowlist and
        runs it in a constrained child. The alert handler never evaluates script
        text itself.
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)][object]$Rule,
        [Parameter(Mandatory)][object]$Action,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Entry,
        [Parameter()][scriptblock]$Resolver
    )

    if (-not (Get-Command -Name 'Invoke-SandboxedScript' -ErrorAction SilentlyContinue)) {
        . (Join-Path -Path $script:AlertEvaluationRoot -ChildPath 'Invoke-SandboxedScript.ps1')
    }
    $content = Resolve-AlertScriptContent -Rule $Rule -Action $Action -Resolver $Resolver
    if (-not $content) {
        $ruleId = [string](Get-AlertEvaluationProperty -Object $Rule -Name 'id')
        throw "alert.script_mode: no sandboxable script content for rule $ruleId"
    }
    return Invoke-SandboxedScript -ScriptContent $content -Arguments @{ event = $Entry }
}

function Invoke-AlertEvaluation {
    <#
    .SYNOPSIS
        Evaluates a tenant's enabled alert rules in one batch.
    .DESCRIPTION
        Implements EPIC-029 SPEC.md §4.1 and §11.4. The tenant's enabled rules are
        filtered once; each distinct log source is fetched exactly once and shared
        across every rule that reads it; each rule's condition rows are
        rehydrated and evaluated against the cached rows. An AlertEvent is emitted
        only for a matching row. A matching script-mode rule is dispatched to the
        EPIC-007 sandbox through the -InvokeScriptMode seam (default
        Invoke-SandboxedScript) and the dispatch is audited; no script runs in
        this process.
    .PARAMETER TenantId
        The tenant being evaluated.
    .PARAMETER Rules
        The tenant's rules; only those with `enabled = $true` participate.
    .PARAMETER ReadLogSource
        Seam: scriptblock (source) -> rows. Called once per distinct source.
    .PARAMETER EmitEvent
        Seam: scriptblock (alertEvent) -> void. Receives one event per match.
    .PARAMETER WriteAudit
        Seam: scriptblock (auditEvent) -> void. Receives script-mode dispatches.
    .PARAMETER InvokeScriptMode
        Seam: scriptblock (rule, action, entry) -> sandbox result. Defaults to the
        EPIC-007 sandbox dispatch.
    .PARAMETER ResolveScriptContent
        Seam: scriptblock (rule, action) -> script text for the default dispatch.
    .PARAMETER RunAt
        ISO-8601 timestamp; defaults to now.
    .PARAMETER CorrelationId
        Correlation id recorded on audit events.
    .OUTPUTS
        [PSCustomObject] with EvaluatedRules, MatchedRules, FiredEvents,
        Dispatched, Sources, Events, and Audits.
    .EXAMPLE
        Invoke-AlertEvaluation -TenantId 'contoso' -Rules $rules -ReadLogSource $reader -EmitEvent $emit
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [AllowEmptyCollection()]
        [object[]]$Rules = @(),

        [Parameter()]
        [scriptblock]$ReadLogSource,

        [Parameter()]
        [scriptblock]$EmitEvent,

        [Parameter()]
        [scriptblock]$WriteAudit,

        [Parameter()]
        [scriptblock]$InvokeScriptMode,

        [Parameter()]
        [scriptblock]$ResolveScriptContent,

        [Parameter()]
        [AllowNull()]
        [object]$RunAt = '',

        [Parameter()]
        [string]$CorrelationId = ''
    )

    # A job envelope may carry runAt as a parsed DateTime; emit ISO-8601 on the
    # event either way so the AlertEvent timestamp is culture-independent.
    if ($RunAt -is [DateTime]) {
        $RunAt = $RunAt.ToUniversalTime().ToString('o')
    }
    elseif ($RunAt) {
        $RunAt = [string]$RunAt
    }
    if (-not $RunAt) { $RunAt = [DateTime]::UtcNow.ToString('o') }
    if (-not $ReadLogSource) { $ReadLogSource = { param($source) @() } }
    if (-not $EmitEvent) { $EmitEvent = { param($event) } }
    if (-not $WriteAudit) { $WriteAudit = { param($event) } }

    $enabledRules = @($Rules | Where-Object {
        [bool](Get-AlertEvaluationProperty -Object $_ -Name 'enabled')
    })

    # §11.4: one fetch per distinct log source for the whole tenant batch.
    $sourceCache = [ordered]@{}
    $sourceOrder = New-Object System.Collections.Generic.List[string]
    foreach ($rule in $enabledRules) {
        $source = [string](Get-AlertEvaluationProperty -Object $rule -Name 'source')
        if (-not $source) { continue }
        if (-not $sourceCache.Contains($source)) {
            $sourceCache[$source] = @(& $ReadLogSource $source)
            $sourceOrder.Add($source) | Out-Null
        }
    }

    $events = New-Object System.Collections.Generic.List[object]
    $audits = New-Object System.Collections.Generic.List[object]
    $evaluatedRules = 0
    $matchedRules = 0
    $dispatched = 0

    foreach ($rule in $enabledRules) {
        $ruleId = [string](Get-AlertEvaluationProperty -Object $rule -Name 'id')
        $source = [string](Get-AlertEvaluationProperty -Object $rule -Name 'source')
        $severity = [string](Get-AlertEvaluationProperty -Object $rule -Name 'severity')
        $conditions = Get-AlertRuleConditions -Rule $rule
        $scriptAction = Get-AlertScriptAction -Rule $rule
        $scriptMode = $null -ne $scriptAction
        $entries = @()
        if ($sourceCache.Contains($source)) { $entries = @($sourceCache[$source]) }

        $evaluatedRules++
        $ruleMatched = $false
        foreach ($rawEntry in $entries) {
            $entry = ConvertTo-AlertPropertyBag -Value $rawEntry
            if (-not (Test-AlertConditionSet -Conditions $conditions -PropertyBag $entry)) { continue }

            $ruleMatched = $true
            $event = [ordered]@{
                id          = [guid]::NewGuid().ToString()
                ruleId      = $ruleId
                tenantId    = $TenantId
                firedAt     = $RunAt
                severity    = $severity
                payload     = $entry
                state       = 'open'
                snoozeUntil = $null
            }
            & $EmitEvent $event
            $events.Add($event) | Out-Null

            if ($scriptMode) {
                if ($InvokeScriptMode) {
                    $null = & $InvokeScriptMode $rule $scriptAction $entry
                }
                else {
                    $null = Invoke-AlertSandboxedScript -Rule $rule -Action $scriptAction -Entry $entry -Resolver $ResolveScriptContent
                }
                $dispatched++
                $audit = [ordered]@{
                    action        = 'alert.script-mode'
                    ruleId        = $ruleId
                    tenantId      = $TenantId
                    scriptId      = [string](Get-AlertEvaluationProperty -Object $scriptAction -Name 'scriptId')
                    sandboxed     = $true
                    dispatched    = $true
                    correlationId = $CorrelationId
                    timestamp     = $RunAt
                }
                & $WriteAudit $audit
                $audits.Add($audit) | Out-Null
            }
        }
        if ($ruleMatched) { $matchedRules++ }
    }

    return [PSCustomObject]@{
        TenantId         = $TenantId
        EvaluatedRules   = $evaluatedRules
        MatchedRules     = $matchedRules
        FiredEvents      = $events.Count
        Dispatched       = $dispatched
        Sources          = $sourceOrder.ToArray()
        SourceFetchCount = $sourceOrder.Count
        Events           = $events.ToArray()
        Audits           = $audits.ToArray()
        RunAt            = $RunAt
        CorrelationId    = $CorrelationId
    }
}
