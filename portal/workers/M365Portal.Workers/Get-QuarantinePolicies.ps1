# Get-QuarantinePolicies.ps1 — EPIC-022 quarantine policy list read (SPEC §2 US-6, §3.5, §5, §6).
#
# Live EXO reads only: quarantine policies are never mirrored, so every call
# reads Get-QuarantinePolicy directly and shapes rows to the §3.5 columns
# (name, policyType, esnEnabled, quarantineRetentionPeriod, addressForMessages,
# lastModified) for notification and permission policies. Only Get- cmdlets are
# issued; nothing is written to the tenant.

function Get-QuarantinePolicyField {
    <#
    .SYNOPSIS
        Reads the first non-null property or dictionary key from a record.
    .PARAMETER Record
        Source object or dictionary.
    .PARAMETER Names
        Candidate field names in priority order.
    .EXAMPLE
        Get-QuarantinePolicyField -Record $policy -Names @('WhenChangedUTC', 'WhenChanged')
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [object]$Record,

        [Parameter(Mandatory)]
        [string[]]$Names
    )

    foreach ($name in $Names) {
        if ($Record -is [System.Collections.IDictionary]) {
            if ($Record.Contains($name) -and $null -ne $Record[$name]) {
                return $Record[$name]
            }
        }
        else {
            $prop = $Record.PSObject.Properties[$name]
            if ($null -ne $prop -and $null -ne $prop.Value) {
                return $prop.Value
            }
        }
    }
    return $null
}

function ConvertTo-QuarantinePolicyType {
    <#
    .SYNOPSIS
        Normalizes a quarantine policy type to the §3.5 vocabulary.
    .DESCRIPTION
        Maps notification/QuarantinePolicy to notification and
        permission/AdminOnlyAccessPolicy to permission; throws on unknown.
    .PARAMETER PolicyType
        Raw policy type value.
    .EXAMPLE
        ConvertTo-QuarantinePolicyType -PolicyType 'AdminOnlyAccessPolicy'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$PolicyType
    )

    $normalized = $PolicyType.Trim().ToLowerInvariant() -replace '[-_\s]', ''
    switch ($normalized) {
        'notification' { return 'notification' }
        'quarantinepolicy' { return 'notification' }
        'permission' { return 'permission' }
        'adminonlyaccesspolicy' { return 'permission' }
        default { throw "Unknown quarantine policy type: $PolicyType. Expected one of: notification, permission." }
    }
}

function ConvertTo-QuarantinePolicyRow {
    <#
    .SYNOPSIS
        Shapes one Get-QuarantinePolicy record into the §3.5 row contract.
    .PARAMETER Policy
        The record from Get-QuarantinePolicy.
    .EXAMPLE
        ConvertTo-QuarantinePolicyRow -Policy $policy
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Policy
    )

    $nameRaw = Get-QuarantinePolicyField -Record $Policy -Names @('Name', 'name')
    $name = if ($null -ne $nameRaw) { [string]$nameRaw } else { '' }

    $rawType = Get-QuarantinePolicyField -Record $Policy -Names @('QuarantinePolicyType', 'PolicyType', 'policyType')
    $policyType = 'notification'
    if ($null -ne $rawType -and -not [string]::IsNullOrWhiteSpace([string]$rawType)) {
        $typeText = ([string]$rawType).Trim()
        $normalized = $typeText.ToLowerInvariant() -replace '[-_\s]', ''
        if ($normalized -in @('notification', 'quarantinepolicy', 'permission', 'adminonlyaccesspolicy')) {
            $policyType = ConvertTo-QuarantinePolicyType -PolicyType $typeText
        }
        else {
            $policyType = $typeText
        }
    }

    $esnRaw = Get-QuarantinePolicyField -Record $Policy -Names @('ESNEnabled', 'esnEnabled')
    $esnEnabled = if ($null -ne $esnRaw) { [bool]$esnRaw } else { $false }

    $retentionRaw = Get-QuarantinePolicyField -Record $Policy -Names @('QuarantineRetentionPeriod', 'quarantineRetentionPeriod')
    $retention = 0
    if ($null -ne $retentionRaw) {
        $parsedRetention = 0
        if ([int]::TryParse([string]$retentionRaw, [ref]$parsedRetention)) {
            $retention = $parsedRetention
        }
    }

    $addressRaw = Get-QuarantinePolicyField -Record $Policy -Names @('AddressForMessages', 'addressForMessages')
    $addressForMessages = if ($null -ne $addressRaw) { [string]$addressRaw } else { '' }

    $modifiedRaw = Get-QuarantinePolicyField -Record $Policy -Names @('WhenChangedUTC', 'WhenChanged', 'lastModified')
    $lastModified = $null
    if ($null -ne $modifiedRaw) {
        if ($modifiedRaw -is [datetime]) {
            $lastModified = ([datetime]$modifiedRaw).ToUniversalTime().ToString('o')
        }
        elseif ($modifiedRaw -is [datetimeoffset]) {
            $lastModified = ([datetimeoffset]$modifiedRaw).ToUniversalTime().ToString('o')
        }
        else {
            $modText = [string]$modifiedRaw
            if (-not [string]::IsNullOrWhiteSpace($modText)) {
                $lastModified = $modText.Trim()
            }
        }
    }

    return [pscustomobject]@{
        name                      = $name
        policyType                = $policyType
        esnEnabled                = $esnEnabled
        quarantineRetentionPeriod = $retention
        addressForMessages        = $addressForMessages
        lastModified              = $lastModified
    }
}

function Get-QuarantinePolicies {
    <#
    .SYNOPSIS
        Lists tenant quarantine notification and permission policies live from EXO.
    .DESCRIPTION
        Calls Get-QuarantinePolicy once, shapes each policy to the §3.5 columns,
        applies optional PolicyType and PolicyName filters, and returns the
        QuarantinePoliciesPage envelope.
    .PARAMETER TenantId
        Tenant identifier carried through to the result envelope.
    .PARAMETER PolicyType
        Optional policy type filter: notification or permission.
    .PARAMETER PolicyName
        Optional exact policy name filter (case-insensitive).
    .EXAMPLE
        Get-QuarantinePolicies -TenantId 'tenant-a' -PolicyType 'notification'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$PolicyType = '',

        [Parameter()]
        [string]$PolicyName = ''
    )

    $normalizedType = ''
    if (-not [string]::IsNullOrWhiteSpace($PolicyType)) {
        $normalizedType = ConvertTo-QuarantinePolicyType -PolicyType $PolicyType
    }

    $rawPolicies = Get-QuarantinePolicy -ErrorAction Stop
    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($policy in @($rawPolicies)) {
        if ($null -eq $policy) {
            continue
        }
        $row = ConvertTo-QuarantinePolicyRow -Policy $policy
        if (-not [string]::IsNullOrWhiteSpace($normalizedType) -and [string]$row.policyType -ne $normalizedType) {
            continue
        }
        if (-not [string]::IsNullOrWhiteSpace($PolicyName)) {
            if (-not [string]::Equals(([string]$row.name).Trim(), $PolicyName.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
                continue
            }
        }
        $rows.Add($row)
    }

    $ordered = @($rows | Sort-Object -Property policyType, name)
    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = @($ordered)
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Read-QuarantinePoliciesJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Get-QuarantinePolicies parameters.
    .DESCRIPTION
        Validates schemaVersion v1 and tenantId, then extracts optional
        policyType and policyName filters from the envelope payload.
    .PARAMETER Path
        Path to the job envelope JSON file.
    .EXAMPLE
        Read-QuarantinePoliciesJob -Path './run/quarantine-policies-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Quarantine policies job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Quarantine policies job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Quarantine policies job is missing required field: tenantId'
    }

    $source = $job['payload']
    if ($source -isnot [System.Collections.IDictionary]) {
        $source = @{}
    }
    if ($source.Contains('filters') -and $source['filters'] -is [System.Collections.IDictionary]) {
        $source = $source['filters']
    }

    $rawType = if ($source.Contains('policyType') -and $null -ne $source['policyType']) { [string]$source['policyType'] } else { '' }
    $policyType = if ([string]::IsNullOrWhiteSpace($rawType)) { '' } else { ConvertTo-QuarantinePolicyType -PolicyType $rawType }
    $policyName = if ($source.Contains('policyName') -and $null -ne $source['policyName']) { [string]$source['policyName'] } else { '' }

    return @{
        TenantId   = $tenantId
        PolicyType = $policyType
        PolicyName = $policyName
    }
}
