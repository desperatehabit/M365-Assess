# Get-SafeLinks.ps1 — EPIC-030 Safe Links policy read + gated change worker
# (SPEC.md §2 US-5, §3.5, §5, §6, §7, §8, §11.1; T-0585).
#
# Reads are live EXO reads only: Get-SafeLinksPolicy on every call, shaped to
# the §3.5 columns (name, state, key settings — URL rewriting, scan on click,
# detonation — last modified), filtered and cursor-paged over that single read.
# Changes (create/edit/enable/disable/delete) follow the EPIC-006 gated
# contract instead of the registry-bound executor: -DryRun plans with no
# tenant write, -Confirmed is re-checked here so a job that skips confirmation
# cannot apply, every apply captures before/after and emits one audit event,
# and disable/delete are flagged compliance-impacting (requiresConfirmation)
# because they weaken tenant protection. The supervisor connects EXO in this
# child process after materializing the tenant credential in-process; this
# file never touches secrets, and one job runs in one child process for one
# tenant, so an EXO session is never shared across tenants.

function ConvertTo-SafeLinksPolicyRow {
    <#
    .SYNOPSIS
        Shapes one Get-SafeLinksPolicy record into the §3.5 list row.
    .PARAMETER Policy
        The Get-SafeLinksPolicy record.
    .EXAMPLE
        ConvertTo-SafeLinksPolicyRow -Policy $policy
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Policy
    )

    $id = [string]$Policy.Guid
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Policy.Identity
    }
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Policy.Name
    }

    $state = 'disabled'
    if ($null -ne $Policy.IsEnabled -and [bool]$Policy.IsEnabled) {
        $state = 'enabled'
    }

    $urlRewriting = $true
    if ($null -ne $Policy.DisableUrlRewrite -and [bool]$Policy.DisableUrlRewrite) {
        $urlRewriting = $false
    }

    $scanOnClick = $false
    if ($null -ne $Policy.EnableSafeLinksForEmail -and [bool]$Policy.EnableSafeLinksForEmail) {
        $scanOnClick = $true
    }

    $detonation = $false
    if ($null -ne $Policy.ScanUrls -and [bool]$Policy.ScanUrls) {
        $detonation = $true
    }

    $lastModified = $null
    foreach ($field in @('WhenChangedUTC', 'WhenChanged')) {
        $raw = [string]$Policy.$field
        if ($raw.Trim().Length -gt 0) {
            $lastModified = $raw.Trim()
            break
        }
    }

    return [pscustomobject]@{
        id           = $id
        name         = [string]$Policy.Name
        state        = $state
        urlRewriting = $urlRewriting
        scanOnClick  = $scanOnClick
        detonation   = $detonation
        lastModified = $lastModified
    }
}

function Test-SafeLinksPolicyFilter {
    <#
    .SYNOPSIS
        Applies the list filters to one shaped row.
    .PARAMETER Row
        The ConvertTo-SafeLinksPolicyRow result.
    .PARAMETER Search
        Case-insensitive substring match against the policy name.
    .PARAMETER State
        Keeps enabled, disabled, or all when empty.
    .EXAMPLE
        Test-SafeLinksPolicyFilter -Row $row -State 'enabled'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [string]$State = ''
    )

    if ($Search.Trim().Length -gt 0) {
        $needle = $Search.Trim().ToLowerInvariant()
        if (-not ([string]$Row.name).ToLowerInvariant().Contains($needle)) {
            return $false
        }
    }
    if ($State.Trim().Length -gt 0 -and [string]$Row.state -ne $State.Trim().ToLowerInvariant()) {
        return $false
    }
    return $true
}

function Get-SafeLinksPolicies {
    <#
    .SYNOPSIS
        Lists tenant Safe Links policies live from Exchange Online with §3.5 columns.
    .DESCRIPTION
        Reads Get-SafeLinksPolicy once, shapes the §3.5 rows ordered by name,
        applies the requested filters, and returns one cursor page. Only Get-
        cmdlets are issued; nothing is written to the tenant and nothing is
        persisted.
    .PARAMETER TenantId
        Tenant the policies belong to. Carried through to the result envelope.
    .PARAMETER Search
        Case-insensitive substring match against the policy name.
    .PARAMETER State
        Filter by policy state: enabled, disabled, or empty for all.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-SafeLinksPolicies -TenantId 'tenant-a' -State 'enabled' -Top 50
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [ValidateSet('', 'enabled', 'disabled')]
        [string]$State = '',

        [Parameter()]
        [ValidateRange(1, 999)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $allPolicies = @(Get-SafeLinksPolicy -ErrorAction Stop)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($policy in @($allPolicies)) {
        if ($null -eq $policy) {
            continue
        }
        $row = ConvertTo-SafeLinksPolicyRow -Policy $policy
        if (Test-SafeLinksPolicyFilter -Row $row -Search $Search -State $State) {
            $rows.Add($row)
        }
    }

    $ordered = @($rows | Sort-Object -Property @{ Expression = { $_.name }; Ascending = $true })
    $offset = ConvertFrom-SafeLinksCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-SafeLinksCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function ConvertTo-SafeLinksCursor {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-SafeLinksCursor {
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter()]
        [string]$Cursor = ''
    )

    if ([string]::IsNullOrWhiteSpace($Cursor)) {
        return 0
    }
    try {
        $text = $Cursor.Trim().Replace('-', '+').Replace('_', '/')
        $pad = (4 - ($text.Length % 4)) % 4
        $text += ('=' * $pad)
        $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text))
        $offset = 0
        if ([int]::TryParse($decoded, [ref]$offset) -and $offset -ge 0) {
            return $offset
        }
    }
    catch {
        Write-Verbose 'Ignoring undecodable Safe Links cursor and starting at the first page.'
    }
    return 0
}

function Read-SafeLinksJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Safe Links worker parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        action and its payload fields. The envelope carries references and
        planned values only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-SafeLinksJob -Path './run/safelinks-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Safe Links job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Safe Links job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Safe Links job is missing required field: tenantId'
    }

    $action = [string]$job['action']
    if ([string]::IsNullOrWhiteSpace($action)) {
        $action = 'list'
    }
    if (@('list', 'create', 'edit', 'enable', 'disable', 'delete') -notcontains $action) {
        throw "Safe Links job has unsupported action: $action"
    }

    $settings = @{}
    $rawSettings = $job['settings']
    if ($rawSettings -is [System.Collections.IDictionary]) {
        $settings = $rawSettings
    }

    return @{
        TenantId    = $tenantId
        Action      = $action
        PolicyId    = [string]$job['policyId']
        Name        = [string]$job['name']
        Settings    = $settings
        ConfirmName = [string]$job['confirmName']
        Search      = [string]$job['search']
        State       = [string]$job['state']
        Top         = Get-SafeLinksJobInt -Value $job['top'] -Default 100
        Cursor      = [string]$job['cursor']
        DryRun      = [bool]($job['dryRun'] -eq $true)
        Confirmed   = [bool]($job['confirmed'] -eq $true)
    }
}

function Get-SafeLinksJobInt {
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter()]
        [object]$Value,

        [Parameter()]
        [int]$Default = 0
    )

    if ($null -eq $Value -or ([string]$Value).Trim().Length -eq 0) {
        return $Default
    }
    $parsed = 0
    if ([int]::TryParse([string]$Value, [ref]$parsed)) {
        return $parsed
    }
    return $Default
}

function Get-SafeLinksPolicySnapshot {
    <#
    .SYNOPSIS
        Reads one live Safe Links policy as the §3.5 row for before/after capture.
    .PARAMETER PolicyId
        Safe Links policy identity (name or GUID).
    .EXAMPLE
        Get-SafeLinksPolicySnapshot -PolicyId 'policy-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$PolicyId
    )

    $policy = Get-SafeLinksPolicy -Identity $PolicyId -ErrorAction Stop
    if (-not $policy) {
        throw "NotFound: Safe Links policy '$PolicyId' not found"
    }
    return ConvertTo-SafeLinksPolicyRow -Policy $policy
}

function ConvertTo-SafeLinksPolicySettings {
    <#
    .SYNOPSIS
        Maps the planned settings vocabulary onto EXO cmdlet parameters.
    .DESCRIPTION
        Only settings the caller actually supplied are mapped, so an edit
        touches exactly the planned keys. urlRewriting is stored inverted in
        EXO (DisableUrlRewrite), so it flips here.
    .PARAMETER Settings
        Planned settings: isEnabled, urlRewriting, scanOnClick, detonation.
    .EXAMPLE
        ConvertTo-SafeLinksPolicySettings -Settings @{ detonation = $true }
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Settings
    )

    $params = @{}
    if ($Settings.ContainsKey('isEnabled')) {
        $params['IsEnabled'] = [bool]$Settings['isEnabled']
    }
    if ($Settings.ContainsKey('urlRewriting')) {
        $params['DisableUrlRewrite'] = -not [bool]$Settings['urlRewriting']
    }
    if ($Settings.ContainsKey('scanOnClick')) {
        $params['EnableSafeLinksForEmail'] = [bool]$Settings['scanOnClick']
    }
    if ($Settings.ContainsKey('detonation')) {
        $params['ScanUrls'] = [bool]$Settings['detonation']
    }
    return $params
}

function Merge-SafeLinksPolicySettings {
    <#
    .SYNOPSIS
        Applies planned settings onto a before-row to build the planned after-row.
    .PARAMETER Row
        The ConvertTo-SafeLinksPolicyRow before-snapshot.
    .PARAMETER Settings
        Planned settings in the input vocabulary; unmentioned keys keep the
        before value.
    .EXAMPLE
        Merge-SafeLinksPolicySettings -Row $before -Settings @{ isEnabled = $false }
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [Parameter(Mandatory)]
        [hashtable]$Settings
    )

    $after = @{
        id           = [string]$Row.id
        name         = [string]$Row.name
        state        = [string]$Row.state
        urlRewriting = [bool]$Row.urlRewriting
        scanOnClick  = [bool]$Row.scanOnClick
        detonation   = [bool]$Row.detonation
        lastModified = $Row.lastModified
    }
    if ($Settings.ContainsKey('isEnabled')) {
        $after['state'] = $(if ([bool]$Settings['isEnabled']) { 'enabled' } else { 'disabled' })
    }
    if ($Settings.ContainsKey('urlRewriting')) {
        $after['urlRewriting'] = [bool]$Settings['urlRewriting']
    }
    if ($Settings.ContainsKey('scanOnClick')) {
        $after['scanOnClick'] = [bool]$Settings['scanOnClick']
    }
    if ($Settings.ContainsKey('detonation')) {
        $after['detonation'] = [bool]$Settings['detonation']
    }
    return $after
}

function Get-SafeLinksPolicyDiff {
    <#
    .SYNOPSIS
        Builds the human-readable change list between the before and after rows.
    .PARAMETER Action
        The planned change action.
    .PARAMETER Before
        The before-row, or $null for create.
    .PARAMETER After
        The after-row, or $null for delete.
    .EXAMPLE
        Get-SafeLinksPolicyDiff -Action 'disable' -Before $before -After $after
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [string]$Action,

        [Parameter()]
        [object]$Before,

        [Parameter()]
        [object]$After
    )

    $diff = [System.Collections.Generic.List[string]]::new()
    if ($Action -eq 'create') {
        $diff.Add("Create Safe Links policy '$($After.name)'")
    }
    elseif ($Action -eq 'delete') {
        $diff.Add("Delete Safe Links policy '$($Before.name)'")
    }
    else {
        if ($Before.name -ne $After.name) {
            $diff.Add("Rename Safe Links policy '$($Before.name)' to '$($After.name)'")
        }
        if ($Before.state -ne $After.state) {
            $diff.Add("Set Safe Links policy '$($After.name)' state to '$($After.state)'")
        }
        if ($Before.urlRewriting -ne $After.urlRewriting) {
            $diff.Add("Set URL rewriting for '$($After.name)' to $(if ($After.urlRewriting) { 'on' } else { 'off' })")
        }
        if ($Before.scanOnClick -ne $After.scanOnClick) {
            $diff.Add("Set scan on click for '$($After.name)' to $(if ($After.scanOnClick) { 'on' } else { 'off' })")
        }
        if ($Before.detonation -ne $After.detonation) {
            $diff.Add("Set detonation for '$($After.name)' to $(if ($After.detonation) { 'on' } else { 'off' })")
        }
    }
    return @($diff)
}

function Invoke-SafeLinksPolicyChange {
    <#
    .SYNOPSIS
        Executes or previews a Safe Links policy change with before/after capture.
    .DESCRIPTION
        -DryRun returns the plan with no tenant write. Without -DryRun,
        -Confirmed is required or the apply is refused. Disable and delete are
        compliance-impacting: the plan carries requiresConfirmation so the BFF
        warns before apply. Every applied change captures before/after and
        emits one auditEvent for the app audit sink; a change whose diff is
        empty is a structured no-op with no EXO write.
    .PARAMETER TenantId
        Tenant the policy belongs to. Carried through to the result envelope.
    .PARAMETER Action
        create, edit, enable, disable, or delete.
    .PARAMETER PolicyId
        Safe Links policy identity for edit, enable, disable, and delete.
    .PARAMETER Name
        Policy name for create.
    .PARAMETER Settings
        Planned settings for create and edit: isEnabled, urlRewriting,
        scanOnClick, detonation.
    .PARAMETER ConfirmName
        Policy name re-typed for delete confirmation.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for apply; the BFF confirms the plan before dispatch.
    .EXAMPLE
        Invoke-SafeLinksPolicyChange -TenantId 'tenant-a' -Action 'disable' -PolicyId 'policy-1' -DryRun $true
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('create', 'edit', 'enable', 'disable', 'delete')]
        [string]$Action,

        [Parameter()]
        [string]$PolicyId = '',

        [Parameter()]
        [string]$Name = '',

        [Parameter()]
        [hashtable]$Settings = @{},

        [Parameter()]
        [string]$ConfirmName = '',

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false
    )

    $requiresConfirmation = ($Action -eq 'disable' -or $Action -eq 'delete')

    if ($Action -eq 'create') {
        if ([string]::IsNullOrWhiteSpace($Name)) {
            throw 'ValidationFailed: name is required to create a Safe Links policy'
        }
        $targetName = $Name.Trim()
        $before = $null
        $resolvedSettings = @{}
        if ($Settings.Count -gt 0) {
            $resolvedSettings = $Settings.Clone()
        }
        if (-not $resolvedSettings.ContainsKey('isEnabled')) {
            $resolvedSettings['isEnabled'] = $true
        }
        $after = @{
            id           = ''
            name         = $targetName
            state        = $(if ([bool]$resolvedSettings['isEnabled']) { 'enabled' } else { 'disabled' })
            urlRewriting = $(if ($resolvedSettings.ContainsKey('urlRewriting')) { [bool]$resolvedSettings['urlRewriting'] } else { $true })
            scanOnClick  = $(if ($resolvedSettings.ContainsKey('scanOnClick')) { [bool]$resolvedSettings['scanOnClick'] } else { $false })
            detonation   = $(if ($resolvedSettings.ContainsKey('detonation')) { [bool]$resolvedSettings['detonation'] } else { $false })
            lastModified = $null
        }
        $newPolicyId = $targetName
    }
    else {
        if ([string]::IsNullOrWhiteSpace($PolicyId)) {
            throw "ValidationFailed: policyId is required to $Action a Safe Links policy"
        }
        $before = Get-SafeLinksPolicySnapshot -PolicyId $PolicyId.Trim()
        $targetName = [string]$before.name
        $newPolicyId = [string]$before.id

        if ($Action -eq 'delete') {
            if ([string]::IsNullOrWhiteSpace($ConfirmName)) {
                throw 'ValidationFailed: confirmName is required to delete a Safe Links policy'
            }
            if ($ConfirmName.Trim() -ne $targetName) {
                throw "ValidationFailed: confirmName '$($ConfirmName.Trim())' does not match Safe Links policy name '$targetName'"
            }
            $after = $null
        }
        else {
            if ($Action -eq 'edit' -and $Settings.Count -eq 0) {
                throw 'ValidationFailed: at least one setting is required to edit a Safe Links policy'
            }
            $resolvedSettings = @{}
            if ($Settings.Count -gt 0) {
                $resolvedSettings = $Settings.Clone()
            }
            if ($Action -eq 'enable') {
                $resolvedSettings['isEnabled'] = $true
            }
            elseif ($Action -eq 'disable') {
                $resolvedSettings['isEnabled'] = $false
            }
            $after = Merge-SafeLinksPolicySettings -Row $before -Settings $resolvedSettings
        }
    }

    $diff = @(Get-SafeLinksPolicyDiff -Action $Action -Before $before -After $after)

    $plan = [pscustomobject]@{
        action               = $Action
        policyId             = $newPolicyId
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = $diff
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = $requiresConfirmation
    }

    if ($DryRun) {
        return $plan
    }

    if (-not $Confirmed) {
        throw "safelinks.confirm_required: action '$Action' requires explicit confirmation"
    }

    if ($Action -ne 'create' -and $Action -ne 'delete' -and $diff.Count -eq 0) {
        return [pscustomobject]@{
            plan       = $plan
            result     = @{ policyId = $newPolicyId; name = $targetName; noop = $true }
            auditEvent = @{
                id         = [guid]::NewGuid().ToString()
                tenantId   = $TenantId
                action     = "safelinks.policy.$Action"
                targetId   = $newPolicyId
                targetName = $targetName
                timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                before     = $before
                after      = $after
                note       = 'already in the planned state; no change applied'
            }
            success    = $true
            noop       = $true
        }
    }

    if ($Action -eq 'create') {
        $settingsParams = ConvertTo-SafeLinksPolicySettings -Settings $resolvedSettings
        $createParams = @{ Name = $targetName }
        foreach ($key in $settingsParams.Keys) {
            $createParams[$key] = $settingsParams[$key]
        }
        $null = New-SafeLinksPolicy @createParams
        $created = Get-SafeLinksPolicySnapshot -PolicyId $targetName
        $after = $created
        $newPolicyId = [string]$after.id
    }
    elseif ($Action -eq 'delete') {
        $null = Remove-SafeLinksPolicy -Identity $PolicyId.Trim()
        $after = $null
    }
    else {
        $settingsParams = ConvertTo-SafeLinksPolicySettings -Settings $resolvedSettings
        $setParams = @{ Identity = $PolicyId.Trim() }
        foreach ($key in $settingsParams.Keys) {
            $setParams[$key] = $settingsParams[$key]
        }
        $null = Set-SafeLinksPolicy @setParams
        $after = Get-SafeLinksPolicySnapshot -PolicyId $PolicyId.Trim()
        $newPolicyId = [string]$after.id
    }

    $appliedPlan = [pscustomobject]@{
        action               = $Action
        policyId             = $newPolicyId
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = $diff
        valid                = $true
        dryRun               = $false
        requiresConfirmation = $requiresConfirmation
    }

    return [pscustomobject]@{
        plan       = $appliedPlan
        result     = @{ policyId = $newPolicyId; name = $targetName }
        auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = "safelinks.policy.$Action"
            targetId   = $newPolicyId
            targetName = $targetName
            timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            before     = $before
            after      = $after
        }
        success    = $true
    }
}
