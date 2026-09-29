# Set-Filter.ps1 — EPIC-022 spam/anti-phish/malware/connection filter write worker (SPEC §2 US-1, §3.1, §4.1, §6, §7, §8; T-0422).
#
# Covers create, edit, enable, disable, and delete operations for the four
# §3.1 filter types. Supports DryRun (plan preview mode returning JSON diff
# without mutating). Captures before/after and emits an AuditEvent on every
# write. Disabling a filter is flagged security-impacting and requires
# explicit confirmation. The caller (child entrypoint) runs with the EXO
# session the supervisor connected after materializing the tenant credential
# in-process; this file never touches secrets.

function ConvertTo-FilterType {
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

function Read-SetFilterJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-SetFilter parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then resolves the
        §3.1 filter type and change action from the payload. The envelope
        carries references only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        PS> Read-SetFilterJob -Path './run/set-filter-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Set-filter job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Set-filter job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Set-filter job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $rawType = [string]$payload['filterType']
    if ([string]::IsNullOrWhiteSpace($rawType)) {
        throw 'Set-filter job is missing required field: filterType'
    }
    $action = [string]$payload['action']
    if ([string]::IsNullOrWhiteSpace($action)) {
        throw 'Set-filter job is missing required field: action'
    }

    return @{
        TenantId   = $tenantId
        FilterType = ConvertTo-FilterType -FilterType $rawType
        Action     = $action
        PolicyName = if ($payload['policyName']) { [string]$payload['policyName'] } else { '' }
        Settings   = if ($payload['settings']) { $payload['settings'] } else { @{} }
        Confirm    = [bool]($payload['confirm'] -eq $true)
        DryRun     = [bool]($payload['dryRun'] -eq $true)
    }
}

function Get-FilterPolicy {
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('spam', 'antiphish', 'malware', 'connection')]
        [string]$FilterType,

        [Parameter()]
        [string]$PolicyName = ''
    )

    switch ($FilterType) {
        'spam' {
            if ([string]::IsNullOrWhiteSpace($PolicyName)) { return @(Get-HostedContentFilterPolicy -ErrorAction Stop) }
            return @(Get-HostedContentFilterPolicy -Identity $PolicyName -ErrorAction Stop)
        }
        'antiphish' {
            if ([string]::IsNullOrWhiteSpace($PolicyName)) { return @(Get-AntiPhishPolicy -ErrorAction Stop) }
            return @(Get-AntiPhishPolicy -Identity $PolicyName -ErrorAction Stop)
        }
        'malware' {
            if ([string]::IsNullOrWhiteSpace($PolicyName)) { return @(Get-MalwareFilterPolicy -ErrorAction Stop) }
            return @(Get-MalwareFilterPolicy -Identity $PolicyName -ErrorAction Stop)
        }
        'connection' {
            if ([string]::IsNullOrWhiteSpace($PolicyName)) { return @(Get-HostedConnectionFilterPolicy -ErrorAction Stop) }
            return @(Get-HostedConnectionFilterPolicy -Identity $PolicyName -ErrorAction Stop)
        }
    }
}

function Get-FilterRule {
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('spam', 'antiphish', 'malware', 'connection')]
        [string]$FilterType,

        [Parameter(Mandatory)]
        [string]$PolicyName
    )

    switch ($FilterType) {
        'spam' { return @(Get-HostedContentFilterRule -Identity $PolicyName -ErrorAction Stop) }
        'antiphish' { return @(Get-AntiPhishRule -Identity $PolicyName -ErrorAction Stop) }
        'malware' { return @(Get-MalwareFilterRule -Identity $PolicyName -ErrorAction Stop) }
        'connection' { return @(Get-HostedConnectionFilterRule -Identity $PolicyName -ErrorAction Stop) }
    }
}

function ConvertTo-FilterSettings {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('spam', 'antiphish', 'malware', 'connection')]
        [string]$FilterType,

        [Parameter(Mandatory)]
        [object]$Policy
    )

    $settings = @{}
    switch ($FilterType) {
        'spam' {
            $settings['spamAction'] = [string]$Policy.SpamAction
            $settings['highConfidenceSpamAction'] = [string]$Policy.HighConfidenceSpamAction
            $settings['phishSpamAction'] = [string]$Policy.PhishSpamAction
            $settings['bulkSpamAction'] = [string]$Policy.BulkSpamAction
            $settings['bulkThreshold'] = [int]$Policy.BulkThreshold
            $settings['spamZapEnabled'] = [bool]$Policy.SpamZapEnabled
            $settings['phishZapEnabled'] = [bool]$Policy.PhishZapEnabled
        }
        'antiphish' {
            $settings['phishThresholdLevel'] = [int]$Policy.PhishThresholdLevel
            $settings['enableMailboxIntelligence'] = [bool]$Policy.EnableMailboxIntelligence
            $settings['enableMailboxIntelligenceProtection'] = [bool]$Policy.EnableMailboxIntelligenceProtection
            $settings['enableSpoofIntelligence'] = [bool]$Policy.EnableSpoofIntelligence
            $settings['enableFirstContactSafetyTips'] = [bool]$Policy.EnableFirstContactSafetyTips
            $settings['enableUnauthenticatedSender'] = [bool]$Policy.EnableUnauthenticatedSender
            $settings['enableViaTag'] = [bool]$Policy.EnableViaTag
        }
        'malware' {
            $settings['fileFilterAction'] = [string]$Policy.FileFilterAction
            $settings['zapEnabled'] = [bool]$Policy.ZapEnabled
            $settings['enableFileFilter'] = [bool]$Policy.EnableFileFilter
        }
        'connection' {
            $settings['ipAllowList'] = @($Policy.IPAllowList)
            $settings['ipBlockList'] = @($Policy.IPBlockList)
            $settings['enableSafeList'] = [bool]$Policy.EnableSafeList
        }
    }
    return $settings
}

function New-FilterSettingsFromInput {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('spam', 'antiphish', 'malware', 'connection')]
        [string]$FilterType,

        [Parameter(Mandatory)]
        [hashtable]$Settings
    )

    $params = @{}
    foreach ($key in $Settings.Keys) {
        $params[$key] = $Settings[$key]
    }
    return $params
}

function Invoke-SetFilter {
    <#
    .SYNOPSIS
        Executes or previews filter policy create/edit/enable/disable/delete operations.
    .DESCRIPTION
        Captures before/after for every change, supports DryRun for plan preview,
        and emits an AuditEvent on every write. Disabling a filter requires
        explicit confirmation (SPEC §4.1, §8).
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('spam', 'antiphish', 'malware', 'connection')]
        [string]$FilterType,

        [Parameter(Mandatory)]
        [ValidateSet('create', 'edit', 'enable', 'disable', 'delete')]
        [string]$Action,

        [Parameter()]
        [string]$PolicyName = '',

        [Parameter()]
        [hashtable]$Settings = @{},

        [Parameter()]
        [bool]$Confirm = $false,

        [Parameter()]
        [bool]$DryRun = $false
    )

    $before = $null
    $after = $null
    $targetName = $PolicyName

    if ($Action -eq 'create') {
        if ([string]::IsNullOrWhiteSpace($PolicyName)) {
            throw "ValidationFailed: policyName is required for create"
        }
        $targetName = $PolicyName
        $after = @{
            name     = $PolicyName
            enabled  = $true
            settings = $Settings
        }
    }
    elseif ($Action -in @('edit', 'enable', 'disable', 'delete')) {
        if ([string]::IsNullOrWhiteSpace($PolicyName)) {
            throw "ValidationFailed: policyName is required for $Action"
        }
        $existing = Get-FilterPolicy -FilterType $FilterType -PolicyName $PolicyName
        if (-not $existing) {
            throw "NotFound: Filter policy '$PolicyName' not found"
        }
        $before = @{
            name     = [string]$existing.Name
            enabled  = [bool]$existing.Enabled
            settings = ConvertTo-FilterSettings -FilterType $FilterType -Policy $existing
        }
        $targetName = [string]$existing.Name

        if ($Action -eq 'edit') {
            $after = @{
                name     = $targetName
                enabled  = $before.enabled
                settings = $Settings
            }
        }
        elseif ($Action -eq 'enable') {
            $after = @{
                name     = $targetName
                enabled  = $true
                settings = $before.settings
            }
        }
        elseif ($Action -eq 'disable') {
            if (-not $Confirm) {
                throw "ValidationFailed: Disabling a filter is security-impacting and requires confirmation (SPEC §4.1, §8)."
            }
            $after = @{
                name     = $targetName
                enabled  = $false
                settings = $before.settings
            }
        }
        elseif ($Action -eq 'delete') {
            if (-not $Confirm) {
                throw "ValidationFailed: Deleting a filter is security-impacting and requires confirmation (SPEC §4.1, §8)."
            }
            $after = $null
        }
    }

    $diff = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $before -and $null -ne $after) {
        $diff.Add("+ Create $FilterType filter '$($after.name)'")
    }
    elseif ($null -ne $before -and $null -eq $after) {
        $diff.Add("- Delete $FilterType filter '$($before.name)'")
    }
    elseif ($null -ne $before -and $null -ne $after) {
        if ($before.enabled -ne $after.enabled) {
            $diff.Add("~ state: '$($before.enabled)' -> '$($after.enabled)'")
        }
        $bJson = $before.settings | ConvertTo-Json -Depth 5 -Compress
        $aJson = $after.settings | ConvertTo-Json -Depth 5 -Compress
        if ($bJson -ne $aJson) {
            $diff.Add("~ settings updated")
        }
    }

    $plan = [pscustomobject]@{
        action               = $Action
        filterType           = $FilterType
        policyName           = $targetName
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = ($Action -in @('disable', 'delete'))
    }

    if ($DryRun) {
        return [pscustomobject]@{
            success = $true
            plan    = $plan
        }
    }

    $result = $null
    if ($Action -eq 'create') {
        $params = New-FilterSettingsFromInput -FilterType $FilterType -Settings $Settings
        switch ($FilterType) {
            'spam' { $result = New-HostedContentFilterPolicy -Name $PolicyName @params -ErrorAction Stop }
            'antiphish' { $result = New-AntiPhishPolicy -Name $PolicyName @params -ErrorAction Stop }
            'malware' { $result = New-MalwareFilterPolicy -Name $PolicyName @params -ErrorAction Stop }
            'connection' { $result = New-HostedConnectionFilterPolicy -Name $PolicyName @params -ErrorAction Stop }
        }
    }
    elseif ($Action -eq 'edit') {
        $params = New-FilterSettingsFromInput -FilterType $FilterType -Settings $Settings
        switch ($FilterType) {
            'spam' { $result = Set-HostedContentFilterPolicy -Identity $PolicyName @params -ErrorAction Stop }
            'antiphish' { $result = Set-AntiPhishPolicy -Identity $PolicyName @params -ErrorAction Stop }
            'malware' { $result = Set-MalwareFilterPolicy -Identity $PolicyName @params -ErrorAction Stop }
            'connection' { $result = Set-HostedConnectionFilterPolicy -Identity $PolicyName @params -ErrorAction Stop }
        }
    }
    elseif ($Action -eq 'enable') {
        switch ($FilterType) {
            'spam' { $result = Enable-HostedContentFilterRule -Identity $PolicyName -ErrorAction Stop }
            'antiphish' { $result = Enable-AntiPhishRule -Identity $PolicyName -ErrorAction Stop }
            'malware' { $result = Enable-MalwareFilterRule -Identity $PolicyName -ErrorAction Stop }
            'connection' { $result = Enable-HostedConnectionFilterRule -Identity $PolicyName -ErrorAction Stop }
        }
    }
    elseif ($Action -eq 'disable') {
        switch ($FilterType) {
            'spam' { $result = Disable-HostedContentFilterRule -Identity $PolicyName -ErrorAction Stop }
            'antiphish' { $result = Disable-AntiPhishRule -Identity $PolicyName -ErrorAction Stop }
            'malware' { $result = Disable-MalwareFilterRule -Identity $PolicyName -ErrorAction Stop }
            'connection' { $result = Disable-HostedConnectionFilterRule -Identity $PolicyName -ErrorAction Stop }
        }
    }
    elseif ($Action -eq 'delete') {
        switch ($FilterType) {
            'spam' { $result = Remove-HostedContentFilterPolicy -Identity $PolicyName -Confirm:$false -ErrorAction Stop }
            'antiphish' { $result = Remove-AntiPhishPolicy -Identity $PolicyName -Confirm:$false -ErrorAction Stop }
            'malware' { $result = Remove-MalwareFilterPolicy -Identity $PolicyName -Confirm:$false -ErrorAction Stop }
            'connection' { $result = Remove-HostedConnectionFilterPolicy -Identity $PolicyName -Confirm:$false -ErrorAction Stop }
        }
    }

    $auditEvent = [pscustomobject]@{
        id         = [Guid]::NewGuid().ToString()
        tenantId   = $TenantId
        action     = "filters.policy.$Action"
        targetId   = $targetName
        targetName = $targetName
        timestamp  = (Get-Date).ToUniversalTime().ToString('o')
        before     = $before
        after      = $after
    }

    return [pscustomobject]@{
        success    = $true
        plan       = $plan
        result     = $result
        auditEvent = $auditEvent
    }
}
