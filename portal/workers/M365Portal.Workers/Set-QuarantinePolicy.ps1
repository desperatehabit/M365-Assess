# Set-QuarantinePolicy.ps1 — EPIC-022 quarantine notification and permission policy write worker (SPEC §2 US-6, §3.5, §4.4, §6, §7, §8; T-0428).
#
# Covers create, edit, and delete operations for the two §3.5 quarantine
# policy types: notification policies (end-user spam notifications, retention,
# multi-language) and permission policies (admin-only quarantine access).
# Supports DryRun (plan preview mode returning JSON diff without mutating).
# Captures before/after and emits an AuditEvent on every write. Deleting a
# policy is flagged security-impacting and requires explicit confirmation.
# The caller (child entrypoint) runs with the EXO session the supervisor
# connected after materializing the tenant credential in-process; this file
# never touches secrets.

function ConvertTo-QuarantinePolicyType {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$PolicyType
    )

    $normalized = $PolicyType.Trim().ToLowerInvariant() -replace '-', ''
    switch ($normalized) {
        'notification' { return 'notification' }
        'quarantinepolicy' { return 'notification' }
        'permission' { return 'permission' }
        'adminonlyaccesspolicy' { return 'permission' }
        default { throw "Unknown quarantine policy type: $PolicyType. Expected one of: notification, permission." }
    }
}

function ConvertTo-ExoQuarantinePolicyType {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('notification', 'permission')]
        [string]$PolicyType
    )

    switch ($PolicyType) {
        'notification' { return 'QuarantinePolicy' }
        'permission' { return 'AdminOnlyAccessPolicy' }
    }
}

function Read-SetQuarantinePolicyJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-SetQuarantinePolicy parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then resolves the
        §3.5 policy type and change action from the payload. The envelope
        carries references only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        PS> Read-SetQuarantinePolicyJob -Path './run/set-quarantine-policy-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Set-quarantine-policy job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Set-quarantine-policy job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Set-quarantine-policy job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $rawType = [string]$payload['policyType']
    if ([string]::IsNullOrWhiteSpace($rawType)) {
        throw 'Set-quarantine-policy job is missing required field: policyType'
    }
    $action = [string]$payload['action']
    if ([string]::IsNullOrWhiteSpace($action)) {
        throw 'Set-quarantine-policy job is missing required field: action'
    }

    return @{
        TenantId   = $tenantId
        PolicyType = ConvertTo-QuarantinePolicyType -PolicyType $rawType
        Action     = $action
        PolicyName = if ($payload['policyName']) { [string]$payload['policyName'] } else { '' }
        Settings   = if ($payload['settings']) { $payload['settings'] } else { @{} }
        Confirm    = [bool]($payload['confirm'] -eq $true)
        DryRun     = [bool]($payload['dryRun'] -eq $true)
    }
}

function Get-QuarantinePolicy {
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('notification', 'permission')]
        [string]$PolicyType,

        [Parameter()]
        [string]$PolicyName = ''
    )

    $exoType = ConvertTo-ExoQuarantinePolicyType -PolicyType $PolicyType
    $all = @(Get-QuarantinePolicy -ErrorAction Stop)
    $typed = @($all | Where-Object { [string]$_.QuarantinePolicyType -eq $exoType })
    if ([string]::IsNullOrWhiteSpace($PolicyName)) {
        return $typed
    }
    return @($typed | Where-Object { [string]$_.Name -eq $PolicyName })
}

function ConvertTo-QuarantinePolicySettings {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [object]$Policy
    )

    $settings = @{
        esnEnabled                      = [bool]$Policy.ESNEnabled
        quarantineRetentionPeriod       = [int]$Policy.QuarantineRetentionPeriod
        addressForMessages              = [string]$Policy.AddressForMessages
        adminAddressForMessages         = [string]$Policy.AdminAddressForMessages
        endUserSpamNotificationFrequency = [string]$Policy.EndUserSpamNotificationFrequency
        useSystemDefault                = [bool]$Policy.UseSystemDefault
    }
    return $settings
}

function New-QuarantinePolicySettingsFromInput {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Settings
    )

    $params = @{}
    foreach ($key in $Settings.Keys) {
        $params[$key] = $Settings[$key]
    }
    return $params
}

function Invoke-SetQuarantinePolicy {
    <#
    .SYNOPSIS
        Executes or previews quarantine notification/permission policy create/edit/delete operations.
    .DESCRIPTION
        Captures before/after for every change, supports DryRun for plan preview,
        and emits an AuditEvent on every write. Deleting a policy requires
        explicit confirmation (SPEC §4.4, §8).
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('notification', 'permission')]
        [string]$PolicyType,

        [Parameter(Mandatory)]
        [ValidateSet('create', 'edit', 'delete')]
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
            name       = $PolicyName
            policyType = $PolicyType
            settings   = $Settings
        }
    }
    elseif ($Action -in @('edit', 'delete')) {
        if ([string]::IsNullOrWhiteSpace($PolicyName)) {
            throw "ValidationFailed: policyName is required for $Action"
        }
        $existing = @(Get-QuarantinePolicy -PolicyType $PolicyType -PolicyName $PolicyName)
        if ($existing.Count -eq 0) {
            throw "NotFound: Quarantine policy '$PolicyName' not found"
        }
        $existingPolicy = $existing[0]
        $before = @{
            name       = [string]$existingPolicy.Name
            policyType = $PolicyType
            settings   = ConvertTo-QuarantinePolicySettings -Policy $existingPolicy
        }
        $targetName = [string]$existingPolicy.Name

        if ($Action -eq 'edit') {
            $after = @{
                name       = $targetName
                policyType = $PolicyType
                settings   = $Settings
            }
        }
        elseif ($Action -eq 'delete') {
            if (-not $Confirm) {
                throw "ValidationFailed: Deleting a quarantine policy is security-impacting and requires confirmation (SPEC §4.4, §8)."
            }
            $after = $null
        }
    }

    $diff = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $before -and $null -ne $after) {
        $diff.Add("+ Create $PolicyType quarantine policy '$($after.name)'")
    }
    elseif ($null -ne $before -and $null -eq $after) {
        $diff.Add("- Delete $PolicyType quarantine policy '$($before.name)'")
    }
    elseif ($null -ne $before -and $null -ne $after) {
        $bJson = $before.settings | ConvertTo-Json -Depth 5 -Compress
        $aJson = $after.settings | ConvertTo-Json -Depth 5 -Compress
        if ($bJson -ne $aJson) {
            $diff.Add("~ settings updated for '$($after.name)'")
        }
    }

    $plan = [pscustomobject]@{
        action               = $Action
        policyType           = $PolicyType
        policyName           = $targetName
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = ($Action -eq 'delete')
    }

    if ($DryRun) {
        return [pscustomobject]@{
            success = $true
            plan    = $plan
        }
    }

    $result = $null
    if ($Action -eq 'create') {
        $params = New-QuarantinePolicySettingsFromInput -Settings $Settings
        $params['Name'] = $PolicyName
        $params['QuarantinePolicyType'] = ConvertTo-ExoQuarantinePolicyType -PolicyType $PolicyType
        $result = New-QuarantinePolicy @params -ErrorAction Stop
        $PolicyName = if ($result -and $result.Name) { [string]$result.Name } else { $PolicyName }
        $plan.policyName = $PolicyName
    }
    elseif ($Action -eq 'edit') {
        $params = New-QuarantinePolicySettingsFromInput -Settings $Settings
        $result = Set-QuarantinePolicy -Identity $PolicyName @params -ErrorAction Stop
    }
    elseif ($Action -eq 'delete') {
        Remove-QuarantinePolicy -Identity $PolicyName -Confirm:$false -ErrorAction Stop
        $result = @{ deleted = $true }
    }

    $auditEvent = [pscustomobject]@{
        id         = [Guid]::NewGuid().ToString()
        tenantId   = $TenantId
        action     = "quarantine.policy.$Action"
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
