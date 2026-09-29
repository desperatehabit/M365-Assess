# Get-Filters.ps1 — EPIC-022 spam/anti-phish/malware/connection filter read (SPEC §2 US-1, §3.1, §5, §6).
#
# Live EXO reads only: filter policies are never mirrored, so every call reads
# the policy cmdlets (Get-HostedContentFilterPolicy, Get-AntiPhishPolicy,
# Get-MalwareFilterPolicy, Get-HostedConnectionFilterPolicy) plus the matching
# rule cmdlet for priority and state, and shapes rows to the §3.1 columns
# (name, priority, state, key settings summary, last modified). Only Get-
# cmdlets are issued; nothing is written to the tenant. The caller (child
# entrypoint) runs with the EXO session the supervisor connected after
# materializing the tenant credential in-process; this file never touches
# secrets. Key-settings summaries reuse the module read logic
# (DefenderAntiSpamChecks, DefenderAntiPhishingChecks,
# DefenderAntiMalwareChecks, Get-ExoSecurityConfig, Get-EmailSecurityReport).

function ConvertTo-FilterType {
    <#
    .SYNOPSIS
        Normalizes a filter type to the §3.1 vocabulary.
    .DESCRIPTION
        Accepts the four §3.1 filter types with the hyphenated anti-phish
        alias; anything else throws so the entrypoint fails closed.
    .PARAMETER FilterType
        The raw filter type value.
    .EXAMPLE
        ConvertTo-FilterType -FilterType 'anti-phish'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$FilterType
    )

    $normalized = $FilterType.Trim().ToLowerInvariant() -replace '-', ''
    switch ($normalized) {
        'spam' { return 'spam' }
        'antiphish' { return 'antiphish' }
        'malware' { return 'malware' }
        'connection' { return 'connection' }
        default { throw "Unknown filter type: $FilterType. Expected one of: spam, antiphish, malware, connection." }
    }
}

function Get-FilterRuleIndex {
    <#
    .SYNOPSIS
        Indexes EXO filter rules by name for priority and state lookup.
    .PARAMETER Rules
        The rule records from the matching Get-*Rule cmdlet.
    .EXAMPLE
        Get-FilterRuleIndex -Rules $rules
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter()]
        [object[]]$Rules = @()
    )

    $index = @{}
    foreach ($rule in @($Rules)) {
        if ($null -eq $rule) {
            continue
        }
        $name = [string]$rule.Name
        if ($name.Trim().Length -gt 0 -and -not $index.ContainsKey($name)) {
            $index[$name] = $rule
        }
    }
    return $index
}

function Get-FilterState {
    <#
    .SYNOPSIS
        Derives the §3.1 state column from a rule and its policy.
    .DESCRIPTION
        The rule state wins when present; otherwise the policy Enabled flag
        decides, with default policies treated as enabled because EXO always
        applies them.
    .PARAMETER Rule
        The matching rule record, or null when no rule names the policy.
    .PARAMETER Policy
        The policy record.
    .EXAMPLE
        Get-FilterState -Rule $rule -Policy $policy
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [object]$Rule,

        [Parameter(Mandatory)]
        [object]$Policy
    )

    if ($null -ne $Rule -and ([string]$Rule.State).Trim().Length -gt 0) {
        return ([string]$Rule.State).Trim()
    }
    if ($null -ne $Policy.Enabled -and ($Policy.Enabled -is [bool])) {
        if ($Policy.Enabled) { return 'Enabled' }
        return 'Disabled'
    }
    if ($null -ne $Policy.IsEnabled -and ($Policy.IsEnabled -is [bool])) {
        if ($Policy.IsEnabled) { return 'Enabled' }
        return 'Disabled'
    }
    if ($Policy.IsDefault -eq $true) {
        return 'Enabled'
    }
    return 'Unknown'
}

function Get-FilterPriority {
    <#
    .SYNOPSIS
        Reads the rule priority for the §3.1 priority column.
    .PARAMETER Rule
        The matching rule record, or null when no rule names the policy.
    .EXAMPLE
        Get-FilterPriority -Rule $rule
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter()]
        [object]$Rule
    )

    if ($null -eq $Rule -or $null -eq $Rule.Priority) {
        return $null
    }
    $parsed = 0
    if ([int]::TryParse([string]$Rule.Priority, [ref]$parsed)) {
        return $parsed
    }
    return $null
}

function Get-FilterLastModified {
    <#
    .SYNOPSIS
        Reads the last-modified stamp for the §3.1 column.
    .PARAMETER Policy
        The policy record.
    .PARAMETER Rule
        The matching rule record, or null.
    .EXAMPLE
        Get-FilterLastModified -Policy $policy -Rule $rule
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [object]$Policy,

        [Parameter()]
        [object]$Rule
    )

    foreach ($candidate in @($Policy.WhenChangedUTC, $Policy.WhenChanged, $Rule.WhenChangedUTC, $Rule.WhenChanged)) {
        if ($null -ne $candidate -and ([string]$candidate).Trim().Length -gt 0) {
            return [string]$candidate
        }
    }
    return $null
}

function Get-SpamFilterSummary {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [object]$Policy
    )

    $parts = @(
        "BulkThreshold=$($Policy.BulkThreshold)"
        "SpamAction=$($Policy.SpamAction)"
        "HighConfidenceSpamAction=$($Policy.HighConfidenceSpamAction)"
        "PhishSpamAction=$($Policy.PhishSpamAction)"
        "BulkSpamAction=$($Policy.BulkSpamAction)"
        "QuarantineRetentionPeriod=$($Policy.QuarantineRetentionPeriod)"
        "SpamZapEnabled=$($Policy.SpamZapEnabled)"
        "PhishZapEnabled=$($Policy.PhishZapEnabled)"
    )
    return ($parts -join '; ')
}

function Get-AntiPhishFilterSummary {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [object]$Policy
    )

    $parts = @(
        "Enabled=$($Policy.Enabled)"
        "PhishThresholdLevel=$($Policy.PhishThresholdLevel)"
        "EnableMailboxIntelligence=$($Policy.EnableMailboxIntelligence)"
        "EnableMailboxIntelligenceProtection=$($Policy.EnableMailboxIntelligenceProtection)"
        "EnableSpoofIntelligence=$($Policy.EnableSpoofIntelligence)"
        "EnableFirstContactSafetyTips=$($Policy.EnableFirstContactSafetyTips)"
        "EnableUnauthenticatedSender=$($Policy.EnableUnauthenticatedSender)"
        "EnableViaTag=$($Policy.EnableViaTag)"
    )
    if ($Policy.EnableTargetedUserProtection -eq $true) {
        $parts += 'TargetedUserProtection=Enabled'
    }
    if ($Policy.EnableTargetedDomainsProtection -eq $true) {
        $parts += 'TargetedDomainsProtection=Enabled'
    }
    if ($Policy.EnableOrganizationDomainsProtection -eq $true) {
        $parts += 'OrganizationDomainsProtection=Enabled'
    }
    return ($parts -join '; ')
}

function Get-MalwareFilterSummary {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [object]$Policy
    )

    $parts = @(
        "EnableFileFilter=$($Policy.EnableFileFilter)"
        "FileFilterAction=$($Policy.FileFilterAction)"
        "ZapEnabled=$($Policy.ZapEnabled)"
        "EnableInternalSenderAdminNotifications=$($Policy.EnableInternalSenderAdminNotifications)"
        "EnableExternalSenderAdminNotifications=$($Policy.EnableExternalSenderAdminNotifications)"
    )
    $fileTypes = @($Policy.FileTypes)
    if ($fileTypes.Count -gt 0) {
        $parts += "FileTypesCount=$($fileTypes.Count)"
    }
    return ($parts -join '; ')
}

function Get-ConnectionFilterSummary {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [object]$Policy
    )

    $allowCount = @($Policy.IPAllowList).Count
    $blockCount = @($Policy.IPBlockList).Count
    return (@(
        "IPAllowListCount=$allowCount"
        "IPBlockListCount=$blockCount"
        "EnableSafeList=$($Policy.EnableSafeList)"
    ) -join '; ')
}

function ConvertTo-FilterRow {
    <#
    .SYNOPSIS
        Shapes one EXO filter policy plus its rule into the §3.1 row.
    .PARAMETER Policy
        The policy record from the matching Get-*Policy cmdlet.
    .PARAMETER Rule
        The matching rule record, or null.
    .PARAMETER FilterType
        The normalized §3.1 filter type.
    .EXAMPLE
        ConvertTo-FilterRow -Policy $policy -FilterType 'spam'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Policy,

        [Parameter()]
        [object]$Rule,

        [Parameter(Mandatory)]
        [ValidateSet('spam', 'antiphish', 'malware', 'connection')]
        [string]$FilterType
    )

    $summary = switch ($FilterType) {
        'spam' { Get-SpamFilterSummary -Policy $Policy }
        'antiphish' { Get-AntiPhishFilterSummary -Policy $Policy }
        'malware' { Get-MalwareFilterSummary -Policy $Policy }
        'connection' { Get-ConnectionFilterSummary -Policy $Policy }
    }

    return [pscustomobject]@{
        name         = [string]$Policy.Name
        priority     = Get-FilterPriority -Rule $Rule
        state        = Get-FilterState -Rule $Rule -Policy $Policy
        summary      = $summary
        lastModified = Get-FilterLastModified -Policy $Policy -Rule $Rule
    }
}

function Get-Filters {
    <#
    .SYNOPSIS
        Lists tenant filter policies live from Exchange Online with §3.1 columns.
    .DESCRIPTION
        Reads the policy and rule cmdlets for one §3.1 filter type, joins each
        policy to its rule by name for priority and state, and returns the
        shaped rows. Only Get- cmdlets are issued; nothing is written to the
        tenant and nothing is mirrored to disk.
    .PARAMETER TenantId
        Tenant the filter policies belong to. Carried through to the result envelope.
    .PARAMETER FilterType
        One of: spam, antiphish (anti-phish accepted), malware, connection.
    .EXAMPLE
        Get-Filters -TenantId 'tenant-a' -FilterType 'spam'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$FilterType
    )

    $normalized = ConvertTo-FilterType -FilterType $FilterType

    $policies = @()
    $rules = @()
    switch ($normalized) {
        'spam' {
            $policies = @(Get-HostedContentFilterPolicy -ErrorAction Stop)
            $rules = @(Get-HostedContentFilterRule -ErrorAction Stop)
        }
        'antiphish' {
            $policies = @(Get-AntiPhishPolicy -ErrorAction Stop)
            $rules = @(Get-AntiPhishRule -ErrorAction Stop)
        }
        'malware' {
            $policies = @(Get-MalwareFilterPolicy -ErrorAction Stop)
            $rules = @(Get-MalwareFilterRule -ErrorAction Stop)
        }
        'connection' {
            $policies = @(Get-HostedConnectionFilterPolicy -ErrorAction Stop)
            $rules = @(Get-HostedConnectionFilterRule -ErrorAction Stop)
        }
    }

    $ruleIndex = Get-FilterRuleIndex -Rules $rules
    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($policy in @($policies)) {
        if ($null -eq $policy) {
            continue
        }
        $rule = $null
        if ($ruleIndex.ContainsKey([string]$policy.Name)) {
            $rule = $ruleIndex[[string]$policy.Name]
        }
        $rows.Add((ConvertTo-FilterRow -Policy $policy -Rule $rule -FilterType $normalized))
    }

    $items = @($rows | Sort-Object -Property name)
    return [pscustomobject]@{
        tenantId    = $TenantId
        filterType  = $normalized
        items       = $items
        totalCount  = $items.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Read-FiltersJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Get-Filters parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then resolves the
        §3.1 filter type from the payload. The envelope carries references
        only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-FiltersJob -Path './run/filters-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Filters job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Filters job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Filters job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $nested = $payload['filters']
    if ($nested -is [System.Collections.IDictionary] -and $null -ne $nested['filterType']) {
        $rawType = [string]$nested['filterType']
    }
    else {
        $rawType = [string]$payload['filterType']
    }
    if ([string]::IsNullOrWhiteSpace($rawType)) {
        throw 'Filters job is missing required field: filterType'
    }

    return @{
        TenantId   = $tenantId
        FilterType = ConvertTo-FilterType -FilterType $rawType
    }
}
