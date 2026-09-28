# Set-IntuneAppAssignment.ps1 - EPIC-017 app assignment worker (SPEC section 4.2, section 8, section 9; T-0324).
#
# Plans and applies group/intent assignments for one Intune app:
# - Reads the app with its assignments and checks its type against the T-0321 registry
#   (v1: win32, store). A missing app is 404; an unsupported type is 501.
# - Resolves the requested targets (groups, All users, All devices) and intents
#   (required / available / uninstall) into a plan: per-target add/update/remove/unchanged
#   against the current assignments, plus the full before and after sets.
#   'merge' keeps targets the request does not name; 'replace' removes them. Exclusion
#   assignments are never touched here.
# - The plan carries a planHash over the after-set. Apply must echo the hash it was shown;
#   if the live assignments moved since the preview, the hash differs and nothing is written.
# - Graph's /assign replaces the whole set, so apply posts the after-set in one call and
#   emits one audit event per changed target, with actor and result.

$script:AppAssignGraphBase = '/beta/deviceAppManagement/mobileApps'
$script:AppAssignIntents = @('required', 'available', 'uninstall')
$script:AppAssignSupportedTypes = @{
    '#microsoft.graph.win32LobApp'                  = 'win32'
    '#microsoft.graph.winGetApp'                    = 'store'
    '#microsoft.graph.microsoftStoreForBusinessApp' = 'store'
}

function Read-IntuneAppAssignmentJob {
    <#
    .SYNOPSIS
        Parses a job document for Set-IntuneAppAssignment.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "job envelope not found at '$Path'"
    }
    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    foreach ($field in @('tenantId', 'appId')) {
        if (-not $json[$field]) { throw "job envelope '$Path' is missing mandatory '$field'" }
    }
    $mode = if ($json['mode']) { [string]$json['mode'] } else { 'merge' }
    if (@('merge', 'replace') -notcontains $mode) {
        throw "job envelope '$Path' has unknown mode '$mode'"
    }

    return @{
        TenantId    = [string]$json['tenantId']
        AppId       = [string]$json['appId']
        Assignments = @($json['assignments'] | Where-Object { $null -ne $_ })
        Mode        = $mode
        Preview     = [bool]($json['preview'] -eq $true)
        ConfirmPlan = [string]$json['confirmPlan']
        Actor       = if ($json['actor']) { [string]$json['actor'] } else { 'system' }
    }
}

function Get-AppAssignValue {
    # Reads a property from a hashtable or a PSCustomObject.
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function ConvertFrom-AppAssignmentTarget {
    <#
    .SYNOPSIS
        Reduces a Graph assignment target to @{ Key; TargetType; GroupId }.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([object]$Target)

    $type = [string](Get-AppAssignValue -Object $Target -Name '@odata.type')
    $groupId = [string](Get-AppAssignValue -Object $Target -Name 'groupId')
    switch ($type) {
        '#microsoft.graph.groupAssignmentTarget' { return @{ Key = "group:$groupId"; TargetType = 'group'; GroupId = $groupId } }
        '#microsoft.graph.exclusionGroupAssignmentTarget' { return @{ Key = "exclude:$groupId"; TargetType = 'exclusion'; GroupId = $groupId } }
        '#microsoft.graph.allLicensedUsersAssignmentTarget' { return @{ Key = 'allUsers'; TargetType = 'allUsers'; GroupId = $null } }
        '#microsoft.graph.allDevicesAssignmentTarget' { return @{ Key = 'allDevices'; TargetType = 'allDevices'; GroupId = $null } }
        default { return @{ Key = "other:${type}:${groupId}"; TargetType = 'other'; GroupId = $null } }
    }
}

function ConvertTo-AppAssignmentTarget {
    # Builds a Graph assignment target from a plan target.
    param([Parameter(Mandatory)][hashtable]$Target)
    switch ($Target.TargetType) {
        'group' { return @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = $Target.GroupId } }
        'allUsers' { return @{ '@odata.type' = '#microsoft.graph.allLicensedUsersAssignmentTarget' } }
        'allDevices' { return @{ '@odata.type' = '#microsoft.graph.allDevicesAssignmentTarget' } }
        default { throw "cannot build a target of type '$($Target.TargetType)'" }
    }
}

function Resolve-AppAssignmentRequest {
    <#
    .SYNOPSIS
        Validates requested assignments into plan targets: @{ Key; TargetType; GroupId; Intent }.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param([object[]]$Assignments = @())

    $byKey = [ordered]@{}
    foreach ($a in $Assignments) {
        $intent = [string](Get-AppAssignValue -Object $a -Name 'intent')
        if ($script:AppAssignIntents -notcontains $intent) {
            throw [System.ArgumentException]::new("intent '$intent' is not one of: $($script:AppAssignIntents -join ', ')")
        }
        $target = [string](Get-AppAssignValue -Object $a -Name 'target')
        $groupId = [string](Get-AppAssignValue -Object $a -Name 'groupId')
        $entry = if ($groupId) {
            if ($groupId -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw [System.ArgumentException]::new("groupId '$groupId' is not a GUID") }
            @{ Key = "group:$($groupId.ToLowerInvariant())"; TargetType = 'group'; GroupId = $groupId.ToLowerInvariant() }
        }
        elseif ($target -eq 'allUsers') { @{ Key = 'allUsers'; TargetType = 'allUsers'; GroupId = $null } }
        elseif ($target -eq 'allDevices') { @{ Key = 'allDevices'; TargetType = 'allDevices'; GroupId = $null } }
        else { throw [System.ArgumentException]::new("each assignment needs a groupId or target 'allUsers'/'allDevices'") }

        # Intune offers "available" to users only.
        if ($entry.TargetType -eq 'allDevices' -and $intent -eq 'available') {
            throw [System.ArgumentException]::new("intent 'available' cannot target All devices")
        }
        if ($byKey.Contains($entry.Key) -and $byKey[$entry.Key].Intent -ne $intent) {
            throw [System.ArgumentException]::new("target '$($entry.Key)' is requested with two intents")
        }
        $entry.Intent = $intent
        $byKey[$entry.Key] = $entry
    }
    return @($byKey.Values)
}

function Get-AppAssignmentPlanHash {
    <#
    .SYNOPSIS
        A stable hash of an app's after-set: what apply will write.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$AppId, [object[]]$After = @())

    $canonical = (@($After | ForEach-Object { "$($_.key)=$($_.intent)" } | Sort-Object) -join ';')
    $bytes = [Text.Encoding]::UTF8.GetBytes("$AppId|$canonical")
    return ([System.Security.Cryptography.SHA256]::HashData($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Get-IntuneAppAssignmentPlan {
    <#
    .SYNOPSIS
        Reads the app and builds the assignment plan (no writes).
    .OUTPUTS
        Hashtable with plan fields, or @{ error; message; statusCode } when the app cannot be assigned.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$AppId,
        [object[]]$Assignments = @(),
        [ValidateSet('merge', 'replace')][string]$Mode = 'merge'
    )

    try {
        $app = Invoke-MgGraphRequest -Method GET -Uri "$script:AppAssignGraphBase/$([uri]::EscapeDataString($AppId))?`$expand=assignments"
    }
    catch {
        if ($_.Exception.Message -match '404|NotFound|ResourceNotFound') {
            return @{ error = 'intune.app.not_found'; message = "app '$AppId' not found"; statusCode = 404 }
        }
        throw
    }
    $odataType = [string](Get-AppAssignValue -Object $app -Name '@odata.type')
    $appType = $script:AppAssignSupportedTypes[$odataType]
    if (-not $appType) {
        return @{ error = 'intune.app-type.unsupported'; message = "app type '$odataType' cannot be assigned in v1"; statusCode = 501 }
    }

    $requested = Resolve-AppAssignmentRequest -Assignments $Assignments

    $current = [ordered]@{}
    foreach ($a in @(Get-AppAssignValue -Object $app -Name 'assignments' | Where-Object { $_ })) {
        $t = ConvertFrom-AppAssignmentTarget -Target (Get-AppAssignValue -Object $a -Name 'target')
        $current[$t.Key] = @{
            key        = $t.Key
            targetType = $t.TargetType
            groupId    = $t.GroupId
            intent     = [string](Get-AppAssignValue -Object $a -Name 'intent')
            raw        = $a
        }
    }

    $issues = [System.Collections.Generic.List[string]]::new()
    $groupNames = @{}
    foreach ($r in $requested | Where-Object { $_.TargetType -eq 'group' }) {
        try {
            $group = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/groups/$($r.GroupId)?`$select=id,displayName"
            $groupNames[$r.GroupId] = [string](Get-AppAssignValue -Object $group -Name 'displayName')
        }
        catch {
            if ($_.Exception.Message -notmatch '404|NotFound|ResourceNotFound') { throw }
            $issues.Add("group '$($r.GroupId)' does not exist in the tenant")
        }
    }

    $changes = [System.Collections.Generic.List[hashtable]]::new()
    $after = [System.Collections.Generic.List[hashtable]]::new()
    $requestedKeys = @($requested | ForEach-Object { $_.Key })
    foreach ($r in $requested) {
        $from = if ($current.Contains($r.Key)) { $current[$r.Key].intent } else { $null }
        $change = if ($null -eq $from) { 'add' } elseif ($from -ne $r.Intent) { 'update' } else { 'unchanged' }
        $name = if ($r.GroupId) { $groupNames[$r.GroupId] } else { $null }
        $changes.Add(@{ key = $r.Key; targetType = $r.TargetType; groupId = $r.GroupId; displayName = $name; from = $from; to = $r.Intent; change = $change })
        $after.Add(@{ key = $r.Key; targetType = $r.TargetType; groupId = $r.GroupId; intent = $r.Intent })
    }
    foreach ($c in $current.Values) {
        if ($requestedKeys -contains $c.key) { continue }
        if ($Mode -eq 'replace' -and $c.targetType -ne 'exclusion') {
            $changes.Add(@{ key = $c.key; targetType = $c.targetType; groupId = $c.groupId; displayName = $null; from = $c.intent; to = $null; change = 'remove' })
            continue
        }
        $after.Add(@{ key = $c.key; targetType = $c.targetType; groupId = $c.groupId; intent = $c.intent; raw = $c.raw })
    }

    $before = @($current.Values | ForEach-Object { @{ key = $_.key; targetType = $_.targetType; groupId = $_.groupId; intent = $_.intent } })
    $afterView = @($after | ForEach-Object { @{ key = $_.key; targetType = $_.targetType; groupId = $_.groupId; intent = $_.intent } })
    return @{
        appId                = $AppId
        appName              = [string](Get-AppAssignValue -Object $app -Name 'displayName')
        appType              = $appType
        mode                 = $Mode
        changes              = @($changes)
        before               = $before
        after                = $afterView
        issues               = @($issues)
        valid                = ($issues.Count -eq 0)
        planHash             = Get-AppAssignmentPlanHash -AppId $AppId -After $afterView
        requiresConfirmation = $true
        afterAssignments     = @($after)
    }
}

function Set-IntuneAppAssignment {
    <#
    .SYNOPSIS
        Previews, or applies on confirmation, an Intune app's assignment changes.
    .PARAMETER ConfirmPlan
        The planHash the caller was shown; apply refuses when it no longer matches.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][string]$AppId,
        [object[]]$Assignments = @(),
        [ValidateSet('merge', 'replace')][string]$Mode = 'merge',
        [switch]$Preview,
        [string]$ConfirmPlan = '',
        [string]$Actor = 'system'
    )

    try {
        $plan = Get-IntuneAppAssignmentPlan -AppId $AppId -Assignments $Assignments -Mode $Mode
    }
    catch [System.ArgumentException] {
        return @{ error = 'request.validation_failed'; message = $_.Exception.Message; statusCode = 400 }
    }
    if ($plan.error) { return $plan }

    $afterAssignments = $plan.afterAssignments
    $plan.Remove('afterAssignments')

    if ($Preview) {
        return @{ tenantId = $TenantId; preview = $true; applied = $false; plan = $plan; auditEvents = @() }
    }
    if (-not $plan.valid) {
        return @{ error = 'intune.app.assign.invalid_plan'; message = ($plan.issues -join '; '); statusCode = 422; plan = $plan }
    }
    if (-not $ConfirmPlan -or $ConfirmPlan -ne $plan.planHash) {
        return @{
            error      = 'intune.app.assign.plan_changed'
            message    = 'the assignments changed since the preview; preview again and confirm the new plan'
            statusCode = 409
            plan       = $plan
        }
    }

    $changed = @($plan.changes | Where-Object { $_.change -ne 'unchanged' })
    if ($changed.Count -eq 0) {
        return @{ tenantId = $TenantId; preview = $false; applied = $false; plan = $plan; auditEvents = @() }
    }

    $body = @{
        mobileAppAssignments = @(foreach ($a in $afterAssignments) {
                if ($a.raw) {
                    @{
                        '@odata.type' = '#microsoft.graph.mobileAppAssignment'
                        intent        = $a.intent
                        target        = Get-AppAssignValue -Object $a.raw -Name 'target'
                        settings      = Get-AppAssignValue -Object $a.raw -Name 'settings'
                    }
                }
                else {
                    @{
                        '@odata.type' = '#microsoft.graph.mobileAppAssignment'
                        intent        = $a.intent
                        target        = ConvertTo-AppAssignmentTarget -Target @{ TargetType = $a.targetType; GroupId = $a.groupId }
                        settings      = $null
                    }
                }
            })
    } | ConvertTo-Json -Depth 20 -Compress

    $result = 'succeeded'
    $errorText = $null
    if ($PSCmdlet.ShouldProcess($plan.appName, 'Set Intune app assignments')) {
        try {
            $null = Invoke-MgGraphRequest -Method POST -Uri "$script:AppAssignGraphBase/$([uri]::EscapeDataString($AppId))/assign" -Body $body
        }
        catch {
            $result = 'failed'
            $errorText = $_.ToString()
        }
    }

    $timestamp = (Get-Date).ToUniversalTime().ToString('o')
    $auditEvents = @(foreach ($c in $changed) {
            @{
                id         = [guid]::NewGuid().ToString()
                tenantId   = $TenantId
                action     = "intune.app.assignment.$($c.change)"
                targetId   = $AppId
                targetName = $plan.appName
                assignment = $c.key
                actor      = $Actor
                timestamp  = $timestamp
                before     = @{ intent = $c.from }
                after      = @{ intent = $c.to }
                result     = $result
                error      = $errorText
            }
        })

    return @{
        tenantId    = $TenantId
        preview     = $false
        applied     = ($result -eq 'succeeded')
        plan        = $plan
        error       = $errorText
        auditEvents = $auditEvents
    }
}
