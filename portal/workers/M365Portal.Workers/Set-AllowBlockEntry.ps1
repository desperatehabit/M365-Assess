# Set-AllowBlockEntry.ps1 — EPIC-022 tenant allow/block list write worker (SPEC §2 US-5, §3.4, §4.3, §6, §7, §8; T-0427).
#
# Covers create, edit, and delete operations for the four §3.4 entry types
# (sender, domain, URL, file). An optional expiry is applied on the EXO entry;
# no entry is mirrored to disk. Supports DryRun (plan preview mode returning a
# JSON diff without mutating). Captures before/after and emits an AuditEvent on
# every write. The caller (child entrypoint) runs with the EXO session the
# supervisor connected after materializing the tenant credential in-process;
# this file never touches secrets.

function ConvertTo-AllowBlockType {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Type
    )

    $normalized = $Type.Trim().ToLowerInvariant() -replace '[\s_-]', ''
    switch ($normalized) {
        'sender' { return 'sender' }
        'senders' { return 'sender' }
        'address' { return 'sender' }
        'email' { return 'sender' }
        'domain' { return 'domain' }
        'domains' { return 'domain' }
        'url' { return 'url' }
        'urls' { return 'url' }
        'file' { return 'file' }
        'filehash' { return 'file' }
        'hash' { return 'file' }
        default { throw "Unknown allow/block type: $Type. Expected one of: sender, domain, url, file." }
    }
}

function ConvertTo-AllowBlockAction {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$EntryAction
    )

    $normalized = $EntryAction.Trim().ToLowerInvariant()
    switch ($normalized) {
        'allow' { return 'allow' }
        'block' { return 'block' }
        default { throw "Unknown allow/block action: $EntryAction. Expected one of: allow, block." }
    }
}

function ConvertTo-ExoAllowBlockListType {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('sender', 'domain', 'url', 'file')]
        [string]$Type
    )

    switch ($Type) {
        'sender' { return 'Sender' }
        'domain' { return 'Sender' }
        'url' { return 'Url' }
        'file' { return 'FileHash' }
    }
}

function ConvertTo-ExoAllowBlockSwitch {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('allow', 'block')]
        [string]$EntryAction
    )

    if ($EntryAction -eq 'allow') {
        return @{ Allow = $true }
    }
    return @{ Block = $true }
}

function Get-AllowBlockItemField {
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [object]$Item,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Name
    )

    if ($Item -is [System.Collections.IDictionary]) {
        if ($Item.Contains($Name)) { return $Item[$Name] }
        return $null
    }
    $property = $Item.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function ConvertTo-AllowBlockEntryObject {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [object]$Item,

        [Parameter(Mandatory)]
        [ValidateSet('sender', 'domain', 'url', 'file')]
        [string]$Type,

        [Parameter(Mandatory)]
        [ValidateSet('allow', 'block')]
        [string]$EntryAction
    )

    $expires = Get-AllowBlockItemField -Item $Item -Name 'ExpirationDate'
    $expiresOn = $null
    if ($expires) {
        $expiresOn = ([datetime]$expires).ToUniversalTime().ToString('o')
    }
    $notes = Get-AllowBlockItemField -Item $Item -Name 'Notes'
    return @{
        type      = $Type
        value     = [string](Get-AllowBlockItemField -Item $Item -Name 'Value')
        action    = $EntryAction
        expiresOn = $expiresOn
        notes     = if ($null -ne $notes) { [string]$notes } else { '' }
    }
}

function Read-SetAllowBlockEntryJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-SetAllowBlockEntry parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then resolves the
        §3.4 entry type, allow/block action, and change action from the payload.
        The envelope carries references only; secrets are never present and
        never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        PS> Read-SetAllowBlockEntryJob -Path './run/set-allow-block-entry-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Set-allow-block-entry job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Set-allow-block-entry job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Set-allow-block-entry job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $rawType = [string]$payload['type']
    if ([string]::IsNullOrWhiteSpace($rawType)) {
        throw 'Set-allow-block-entry job is missing required field: type'
    }
    $action = [string]$payload['action']
    if ([string]::IsNullOrWhiteSpace($action)) {
        throw 'Set-allow-block-entry job is missing required field: action'
    }
    $entryAction = [string]$payload['entryAction']
    if ([string]::IsNullOrWhiteSpace($entryAction)) {
        throw 'Set-allow-block-entry job is missing required field: entryAction'
    }
    $value = [string]$payload['value']
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw 'Set-allow-block-entry job is missing required field: value'
    }

    # ConvertFrom-Json turns ISO date strings into [datetime]; normalize back to
    # an ISO 8601 string so the write worker receives a stable value.
    $rawExpires = $payload['expiresOn']
    $expiresOn = ''
    if ($rawExpires -is [datetime]) {
        $expiresOn = ([datetime]$rawExpires).ToUniversalTime().ToString('o')
    }
    elseif ($rawExpires) {
        $expiresOn = [string]$rawExpires
    }

    return @{
        TenantId    = $tenantId
        Type        = ConvertTo-AllowBlockType -Type $rawType
        Action      = $action
        Value       = $value
        EntryAction = ConvertTo-AllowBlockAction -EntryAction $entryAction
        ExpiresOn   = $expiresOn
        Notes       = if ($payload['notes']) { [string]$payload['notes'] } else { '' }
        DryRun      = [bool]($payload['dryRun'] -eq $true)
    }
}

function Get-AllowBlockEntry {
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Sender', 'Url', 'FileHash')]
        [string]$ListType,

        [Parameter()]
        [string]$Value = '',

        [Parameter(Mandatory)]
        [ValidateSet('allow', 'block')]
        [string]$EntryAction
    )

    $listSwitch = ConvertTo-ExoAllowBlockSwitch -EntryAction $EntryAction
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return @(Get-TenantAllowBlockListItems -ListType $ListType @listSwitch -ErrorAction Stop)
    }
    return @(Get-TenantAllowBlockListItems -ListType $ListType -Entry $Value @listSwitch -ErrorAction Stop)
}

function ConvertTo-AllowBlockExpiration {
    [CmdletBinding()]
    [OutputType([datetime])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$ExpiresOn
    )

    try {
        return ([datetime]::Parse($ExpiresOn, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal)).ToUniversalTime()
    }
    catch {
        throw "ValidationFailed: expiresOn is not a valid ISO date: $ExpiresOn"
    }
}

function Invoke-SetAllowBlockEntry {
    <#
    .SYNOPSIS
        Executes or previews a tenant allow/block entry create/edit/delete.
    .DESCRIPTION
        Captures before/after for every change, supports DryRun for plan preview,
        and emits an AuditEvent on every write. An optional expiry is applied on
        the EXO entry; entries are never mirrored to disk.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('sender', 'domain', 'url', 'file')]
        [string]$Type,

        [Parameter(Mandatory)]
        [ValidateSet('create', 'edit', 'delete')]
        [string]$Action,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Value,

        [Parameter(Mandatory)]
        [ValidateSet('allow', 'block')]
        [string]$EntryAction,

        [Parameter()]
        [string]$ExpiresOn = '',

        [Parameter()]
        [string]$Notes = '',

        [Parameter()]
        [bool]$DryRun = $false
    )

    $exoType = ConvertTo-ExoAllowBlockListType -Type $Type
    $before = $null
    $after = $null

    if ($Action -eq 'create') {
        $after = @{
            type      = $Type
            value     = $Value
            action    = $EntryAction
            expiresOn = if ([string]::IsNullOrWhiteSpace($ExpiresOn)) { $null } else { (ConvertTo-AllowBlockExpiration -ExpiresOn $ExpiresOn).ToString('o') }
            notes     = $Notes
        }
    }
    elseif ($Action -in @('edit', 'delete')) {
        $existing = @(Get-AllowBlockEntry -ListType $exoType -Value $Value -EntryAction $EntryAction)
        if ($existing.Count -eq 0) {
            throw "NotFound: Allow/block entry '$Value' not found"
        }
        $before = ConvertTo-AllowBlockEntryObject -Item $existing[0] -Type $Type -EntryAction $EntryAction

        if ($Action -eq 'edit') {
            $after = @{
                type      = $Type
                value     = $before.value
                action    = $EntryAction
                expiresOn = if ([string]::IsNullOrWhiteSpace($ExpiresOn)) { $null } else { (ConvertTo-AllowBlockExpiration -ExpiresOn $ExpiresOn).ToString('o') }
                notes     = $Notes
            }
        }
    }

    $diff = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $before -and $null -ne $after) {
        $diff.Add("+ Add $EntryAction $Type entry '$($after.value)'")
        if ($after.expiresOn) { $diff.Add("~ expires $($after.expiresOn)") }
    }
    elseif ($null -ne $before -and $null -eq $after) {
        $diff.Add("- Remove $EntryAction $Type entry '$($before.value)'")
    }
    elseif ($null -ne $before -and $null -ne $after) {
        $beforeJson = @{ expiresOn = $before.expiresOn; notes = $before.notes } | ConvertTo-Json -Depth 5 -Compress
        $afterJson = @{ expiresOn = $after.expiresOn; notes = $after.notes } | ConvertTo-Json -Depth 5 -Compress
        if ($beforeJson -ne $afterJson) {
            $diff.Add("~ Update $EntryAction $Type entry '$($after.value)'")
        }
    }

    $plan = [pscustomobject]@{
        action     = $Action
        type       = $Type
        value      = $Value
        entryAction = $EntryAction
        before     = $before
        after      = $after
        diff       = @($diff)
        valid      = $true
        dryRun     = $DryRun
    }

    if ($DryRun) {
        return [pscustomobject]@{
            success = $true
            plan    = $plan
        }
    }

    $result = $null
    if ($Action -eq 'create') {
        $params = @{
            ListType = $exoType
            Entries  = $Value
            Notes    = $Notes
        }
        $params += ConvertTo-ExoAllowBlockSwitch -EntryAction $EntryAction
        if (-not [string]::IsNullOrWhiteSpace($ExpiresOn)) {
            $params['ExpirationDate'] = ConvertTo-AllowBlockExpiration -ExpiresOn $ExpiresOn
        }
        $result = New-TenantAllowBlockListItems @params -ErrorAction Stop
    }
    elseif ($Action -eq 'edit') {
        $removeParams = @{
            ListType = $exoType
            Entries  = $before.value
            Confirm  = $false
        }
        $removeParams += ConvertTo-ExoAllowBlockSwitch -EntryAction $EntryAction
        Remove-TenantAllowBlockListItems @removeParams -ErrorAction Stop

        $params = @{
            ListType = $exoType
            Entries  = $after.value
            Notes    = $Notes
        }
        $params += ConvertTo-ExoAllowBlockSwitch -EntryAction $EntryAction
        if (-not [string]::IsNullOrWhiteSpace($ExpiresOn)) {
            $params['ExpirationDate'] = ConvertTo-AllowBlockExpiration -ExpiresOn $ExpiresOn
        }
        $result = New-TenantAllowBlockListItems @params -ErrorAction Stop
    }
    elseif ($Action -eq 'delete') {
        $params = @{
            ListType = $exoType
            Entries  = $before.value
            Confirm  = $false
        }
        $params += ConvertTo-ExoAllowBlockSwitch -EntryAction $EntryAction
        Remove-TenantAllowBlockListItems @params -ErrorAction Stop
        $result = @{ deleted = $true }
    }

    $targetValue = if ($null -ne $before) { [string]$before.value } else { $Value }
    $auditEvent = [pscustomobject]@{
        id         = [Guid]::NewGuid().ToString()
        tenantId   = $TenantId
        action     = "allow-block.entry.$Action"
        targetId   = "$Type`:$targetValue`:$EntryAction"
        targetName = $targetValue
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
