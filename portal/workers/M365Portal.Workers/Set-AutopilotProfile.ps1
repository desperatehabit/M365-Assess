# Set-AutopilotProfile.ps1 - EPIC-017 Autopilot deployment profile writes (SPEC section 3.4, section 8; T-0845).
#
# Actions (job field 'action') on beta windowsAutopilotDeploymentProfiles, each previewed (a plan
# with before/after) or applied (with an audit event carrying before/after and the result):
#   create - from a profile body (a template's profileJson); a profile with the same display
#            name already in the tenant is a conflict, never a duplicate.
#   update - PATCH the live profile (always with its @odata.type).
#   delete - needs the exact profile name; Graph refuses to delete an assigned profile, so an
#            assigned one is refused up front with the assignment count.
#   assign - add and remove group assignments; each add or remove is a step with its own result.

$script:AutopilotProfileBase = '/beta/deviceManagement/windowsAutopilotDeploymentProfiles'
$script:AutopilotProfileReadOnly = @('id', 'createdDateTime', 'lastModifiedDateTime', 'assignments', 'assignedDevices', '@odata.context', 'assignments@odata.context')
$script:AutopilotGuid = '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'

function Read-AutopilotProfileJob {
    <#
    .SYNOPSIS
        Parses a job document for Set-AutopilotProfile.
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
    if (-not $json['tenantId']) { throw "job envelope '$Path' is missing mandatory 'tenantId'" }
    if (@('create', 'update', 'delete', 'assign') -notcontains [string]$json['action']) {
        throw "job envelope '$Path' has unknown action '$($json['action'])'"
    }
    return $json
}

function Get-AutopilotProfileField {
    # Reads a property from a hashtable or a PSCustomObject.
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function Get-AutopilotProfileLive {
    <#
    .SYNOPSIS
        Reads a live profile with its assignments; $null when it does not exist.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string]$ProfileId)

    try {
        $live = Invoke-MgGraphRequest -Method GET -Uri "$script:AutopilotProfileBase/$([uri]::EscapeDataString($ProfileId))?`$expand=assignments"
    }
    catch {
        if ($_.Exception.Message -match '404|NotFound|ResourceNotFound') { return $null }
        throw
    }
    $body = @{}
    $keys = if ($live -is [System.Collections.IDictionary]) { $live.Keys } else { $live.PSObject.Properties.Name }
    foreach ($key in $keys) { if ($script:AutopilotProfileReadOnly -notcontains $key) { $body[[string]$key] = Get-AutopilotProfileField -Object $live -Name $key } }
    $assignments = @(foreach ($a in @(Get-AutopilotProfileField -Object $live -Name 'assignments' | Where-Object { $_ })) {
            $target = Get-AutopilotProfileField -Object $a -Name 'target'
            @{ id = [string](Get-AutopilotProfileField -Object $a -Name 'id'); groupId = [string](Get-AutopilotProfileField -Object $target -Name 'groupId') }
        })
    return @{ id = $ProfileId; body = $body; assignments = $assignments }
}

function New-AutopilotProfileAudit {
    # Builds the audit event for an applied profile write.
    param([string]$TenantId, [string]$Action, [string]$ProfileId, [string]$Name, [string]$Actor, $Before, $After, [string]$Result, [string]$ErrorText)
    return @{
        id         = [guid]::NewGuid().ToString()
        tenantId   = $TenantId
        action     = "intune.autopilot.profile.$Action"
        targetId   = $ProfileId
        targetName = $Name
        actor      = $Actor
        timestamp  = (Get-Date).ToUniversalTime().ToString('o')
        before     = $Before
        after      = $After
        result     = $Result
        error      = $ErrorText
    }
}

function Invoke-AutopilotProfileWrite {
    <#
    .SYNOPSIS
        Previews or applies an Autopilot deployment profile create, update, delete, or assignment change.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$TenantId,
        [Parameter(Mandatory)][ValidateSet('create', 'update', 'delete', 'assign')][string]$Action,
        [string]$ProfileId = '',
        [System.Collections.IDictionary]$ProfileBody = @{},
        [string[]]$AddGroupIds = @(),
        [string[]]$RemoveGroupIds = @(),
        [string]$ConfirmName = '',
        [switch]$Preview,
        [string]$Actor = 'system'
    )

    $fail = { param($code, $message, $status) @{ error = $code; message = $message; statusCode = $status } }

    $current = $null
    if ($Action -ne 'create') {
        if (-not $ProfileId) { return & $fail 'request.validation_failed' "profileId is required to $Action a profile" 400 }
        $current = Get-AutopilotProfileLive -ProfileId $ProfileId
        if (-not $current) { return & $fail 'autopilot.profile.not_found' "Autopilot profile '$ProfileId' not found" 404 }
    }
    $name = if ($current) { [string]$current.body['displayName'] } else { [string]$ProfileBody['displayName'] }

    $plan = @{ action = $Action; profileId = $ProfileId; displayName = $name; before = $null; after = $null; steps = @() }
    switch ($Action) {
        'create' {
            if (-not $name) { return & $fail 'request.validation_failed' 'the profile needs a displayName' 400 }
            $filter = [uri]::EscapeDataString("displayName eq '$($name.Replace("'", "''"))'")
            $existing = @((Invoke-MgGraphRequest -Method GET -Uri "$script:AutopilotProfileBase`?`$filter=$filter&`$select=id,displayName")['value'] | Where-Object { $_ })
            if ($existing.Count -gt 0) {
                return & $fail 'autopilot.profile.exists' "an Autopilot profile named '$name' already exists in the tenant ($($existing[0]['id']))" 409
            }
            $body = @{}
            foreach ($k in $ProfileBody.Keys) { if ($script:AutopilotProfileReadOnly -notcontains $k) { $body[[string]$k] = $ProfileBody[$k] } }
            $plan.after = $body
        }
        'update' {
            if ($ProfileBody.Count -eq 0) { return & $fail 'request.validation_failed' 'no profile changes supplied' 400 }
            $plan.before = $current.body
            $merged = @{} + $current.body
            foreach ($k in $ProfileBody.Keys) { if ($script:AutopilotProfileReadOnly -notcontains $k) { $merged[[string]$k] = $ProfileBody[$k] } }
            $plan.after = $merged
        }
        'delete' {
            $plan.before = $current.body
            $plan.assignmentCount = $current.assignments.Count
            if ($current.assignments.Count -gt 0) {
                return (& $fail 'autopilot.profile.assigned' "profile '$name' is assigned to $($current.assignments.Count) group(s); remove its assignments before deleting it" 409) + @{ plan = $plan }
            }
        }
        'assign' {
            foreach ($g in @($AddGroupIds) + @($RemoveGroupIds)) {
                if ($g -notmatch $script:AutopilotGuid) { return & $fail 'request.validation_failed' "group id '$g' is not a GUID" 400 }
            }
            $lower = { param($ids) @($ids | Where-Object { $_ } | ForEach-Object { ([string]$_).ToLowerInvariant() }) }
            $assigned = & $lower @($current.assignments | ForEach-Object { $_.groupId })
            $removeIds = & $lower $RemoveGroupIds
            $adds = @(& $lower $AddGroupIds | Select-Object -Unique | Where-Object { $assigned -notcontains $_ })
            $removes = @($current.assignments | Where-Object { $_.groupId -and $removeIds -contains $_.groupId.ToLowerInvariant() })
            $removedIds = & $lower @($removes | ForEach-Object { $_.groupId })
            $plan.before = @{ groupIds = $assigned }
            $plan.after = @{ groupIds = @(@($assigned | Where-Object { $removedIds -notcontains $_ }) + $adds) }
            $plan.steps = @(@($adds | ForEach-Object { @{ step = 'add'; groupId = $_ } }) + @($removes | ForEach-Object { @{ step = 'remove'; groupId = $_.groupId; assignmentId = $_.id } }))
        }
    }

    if ($Action -eq 'delete' -and -not $Preview -and $ConfirmName -cne $name) {
        return (& $fail 'autopilot.profile.confirmation_required' "type the profile name '$name' to confirm deletion" 400) + @{ plan = $plan }
    }
    $nothingToDo = $Action -eq 'assign' -and $plan.steps.Count -eq 0
    if ($Preview -or $nothingToDo -or -not $PSCmdlet.ShouldProcess($name, "$Action Autopilot profile")) {
        return @{ tenantId = $TenantId; preview = [bool]$Preview; applied = $false; plan = $plan; auditEvent = $null }
    }

    $result = 'success'
    $errorText = $null
    $stepResults = [System.Collections.Generic.List[hashtable]]::new()
    try {
        switch ($Action) {
            'create' {
                $created = Invoke-MgGraphRequest -Method POST -Uri $script:AutopilotProfileBase -Body ($plan.after | ConvertTo-Json -Depth 20 -Compress)
                $ProfileId = [string](Get-AutopilotProfileField -Object $created -Name 'id')
                $plan.profileId = $ProfileId
            }
            'update' {
                $patch = @{ '@odata.type' = $current.body['@odata.type'] }
                foreach ($k in $ProfileBody.Keys) { if ($script:AutopilotProfileReadOnly -notcontains $k) { $patch[[string]$k] = $ProfileBody[$k] } }
                $null = Invoke-MgGraphRequest -Method PATCH -Uri "$script:AutopilotProfileBase/$([uri]::EscapeDataString($ProfileId))" -Body ($patch | ConvertTo-Json -Depth 20 -Compress)
            }
            'delete' { $null = Invoke-MgGraphRequest -Method DELETE -Uri "$script:AutopilotProfileBase/$([uri]::EscapeDataString($ProfileId))" }
            'assign' {
                foreach ($s in $plan.steps) {
                    try {
                        if ($s.step -eq 'add') {
                            $body = @{ target = @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = $s.groupId } } | ConvertTo-Json -Depth 5 -Compress
                            $null = Invoke-MgGraphRequest -Method POST -Uri "$script:AutopilotProfileBase/$([uri]::EscapeDataString($ProfileId))/assignments" -Body $body
                        }
                        else {
                            $null = Invoke-MgGraphRequest -Method DELETE -Uri "$script:AutopilotProfileBase/$([uri]::EscapeDataString($ProfileId))/assignments/$([uri]::EscapeDataString($s.assignmentId))"
                        }
                        $stepResults.Add(@{ step = $s.step; groupId = $s.groupId; status = 'succeeded' })
                    }
                    catch {
                        $stepResults.Add(@{ step = $s.step; groupId = $s.groupId; status = 'failed'; error = $_.ToString() })
                    }
                }
                $failed = @($stepResults | Where-Object status -eq 'failed').Count
                if ($failed -eq $stepResults.Count) { $result = 'failure' } elseif ($failed -gt 0) { $result = 'partial' }
            }
        }
    }
    catch {
        $result = 'failure'
        $errorText = $_.ToString()
    }

    return @{
        tenantId    = $TenantId
        preview     = $false
        applied     = ($result -ne 'failure')
        profileId   = $ProfileId
        plan        = $plan
        steps       = @($stepResults)
        error       = $errorText
        auditEvent  = New-AutopilotProfileAudit -TenantId $TenantId -Action $Action -ProfileId $ProfileId -Name $name -Actor $Actor -Before $plan.before -After $plan.after -Result $result -ErrorText $errorText
    }
}
