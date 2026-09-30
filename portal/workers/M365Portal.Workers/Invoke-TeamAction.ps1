# Invoke-TeamAction.ps1 — EPIC-026 team lifecycle worker for edit, archive,
# clone, and delete (SPEC §2 US-2, §3.1, §4.1, §5, §6, §8; T-0505).
#
# Covers the row actions on the Teams page: edit, archive, clone, and delete.
# Every write follows the EPIC-006 gated-executor contract (T-0108) — the BFF
# confirms the plan before dispatch, -DryRun reports the intended change without
# writing, every apply captures before/after, and every apply emits one
# AuditEvent plus one TeamOperation-shaped row (T-0501) carrying state and
# result. Delete is destructive, so it additionally requires explicit
# confirmation naming the team (SPEC §8/§9): -Confirmed plus -ConfirmName
# matching the team's display name. Archive is reversible, so it is audited but
# does not require confirmation. The supervisor connects Graph in the child
# process after materializing the tenant credential; this file never touches
# secrets.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TeamActions = @('edit', 'archive', 'clone', 'delete')
$script:TeamVisibilities = @('public', 'private')
$script:TeamEditableFields = @(
    'displayName'
    'description'
    'visibility'
    'classification'
    'specialization'
    'memberSettings'
    'guestSettings'
    'messagingSettings'
    'funSettings'
    'discoverySettings'
)

function ConvertTo-TeamChangesHashtable {
    <#
    .SYNOPSIS
        Keeps only the known editable team fields from a changes object.
    .DESCRIPTION
        Accepts a hashtable or a JSON object and returns a hashtable of the
        allowed Graph team properties, so a job envelope cannot smuggle an
        arbitrary field into the PATCH body.
    .PARAMETER Changes
        Proposed team changes from the job envelope or direct parameters.
    .EXAMPLE
        ConvertTo-TeamChangesHashtable -Changes @{ description = 'x' }
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter()]
        [object]$Changes
    )

    $result = @{}
    if ($null -eq $Changes) {
        return $result
    }
    $source = @{}
    if ($Changes -is [System.Collections.IDictionary]) {
        foreach ($key in $Changes.Keys) {
            $source[[string]$key] = $Changes[$key]
        }
    }
    else {
        foreach ($property in $Changes.PSObject.Properties) {
            $source[$property.Name] = $property.Value
        }
    }
    foreach ($field in $script:TeamEditableFields) {
        if ($source.ContainsKey($field) -and $null -ne $source[$field]) {
            $result[$field] = $source[$field]
        }
    }
    return $result
}

function ConvertTo-TeamSnapshot {
    <#
    .SYNOPSIS
        Shapes one live Graph team into the lifecycle before/after snapshot.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Team
    )

    $isArchived = $false
    if ($null -ne $Team['isArchived']) {
        $isArchived = [bool]$Team['isArchived']
    }

    return [pscustomobject]@{
        id                = [string]$Team['id']
        displayName       = [string]$Team['displayName']
        description       = [string]$Team['description']
        visibility        = [string]$Team['visibility']
        isArchived        = $isArchived
        memberSettings    = $Team['memberSettings']
        guestSettings     = $Team['guestSettings']
        messagingSettings = $Team['messagingSettings']
        funSettings       = $Team['funSettings']
    }
}

function Get-TeamState {
    <#
    .SYNOPSIS
        Reads one live team for the lifecycle before snapshot.
    .DESCRIPTION
        A team that does not exist (or cannot be read) returns null so the
        caller refuses the action with a structured NotFound error instead of
        writing blindly.
    .PARAMETER TeamId
        Team identity.
    .EXAMPLE
        Get-TeamState -TeamId 'team-1'
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TeamId
    )

    try {
        $uri = '/v1.0/teams/{0}?$select=id,displayName,description,visibility,isArchived,memberSettings,guestSettings,messagingSettings,funSettings' -f $TeamId
        $team = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction Stop
        if ($null -eq $team) {
            return $null
        }
        return ConvertTo-TeamSnapshot -Team $team
    }
    catch {
        return $null
    }
}

function New-TeamActionAuditEvent {
    <#
    .SYNOPSIS
        Builds the AuditEvent for one team lifecycle write (EPIC-026 §5).
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [string]$Action,

        [Parameter(Mandatory)]
        [string]$TargetName,

        [Parameter()]
        [string]$TargetId = '',

        [Parameter()]
        [object]$Before = $null,

        [Parameter()]
        [object]$After = $null,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [ValidateSet('success', 'failure')]
        [string]$Result = 'success',

        [Parameter()]
        [string]$ErrorMessage = ''
    )

    return @{
        id            = [guid]::NewGuid().ToString()
        tenantId      = $TenantId
        action        = "teams.team.$Action"
        targetId      = $TargetId
        targetName    = $TargetName
        timestamp     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        result        = $Result
        before        = $Before
        after         = $After
        error         = if ($ErrorMessage) { $ErrorMessage } else { $null }
        actor         = $Actor
        correlationId = $CorrelationId
    }
}

function New-TeamOperationRow {
    <#
    .SYNOPSIS
        Builds the TeamOperation audit row for one team lifecycle write (T-0501).
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [string]$TenantId,

        [Parameter()]
        [string]$TeamId = '',

        [Parameter(Mandatory)]
        [string]$Operation,

        [Parameter(Mandatory)]
        [ValidateSet('applied', 'failed')]
        [string]$State,

        [Parameter()]
        [string]$By = '',

        [Parameter()]
        [string]$Result = ''
    )

    return @{
        id        = [guid]::NewGuid().ToString()
        tenantId  = $TenantId
        teamId    = $TeamId
        operation = $Operation
        state     = $State
        by        = if ($By) { $By } else { $null }
        at        = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        result    = if ($Result) { $Result } else { $null }
    }
}

function Complete-TeamAction {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Context,

        [Parameter(Mandatory)]
        [string]$Action,

        [Parameter(Mandatory)]
        [string]$TeamId,

        [Parameter(Mandatory)]
        [string]$TargetName,

        [Parameter()]
        [object]$Before = $null,

        [Parameter()]
        [object]$After = $null,

        [Parameter()]
        [object]$Plan = $null,

        [Parameter()]
        [object]$Result = $null
    )

    $audit = New-TeamActionAuditEvent -TenantId $Context.TenantId -Action $Action `
        -TargetId $TeamId -TargetName $TargetName -Before $Before -After $After `
        -Actor $Context.Actor -CorrelationId $Context.CorrelationId
    $operation = New-TeamOperationRow -TenantId $Context.TenantId -TeamId $TeamId `
        -Operation $Action -State 'applied' -By $Context.Actor -Result 'applied'
    $null = & $Context.WriteAudit $audit
    $null = & $Context.WriteTeamOperation $operation

    return [pscustomobject]@{
        success       = $true
        state         = 'succeeded'
        operation     = $Action
        teamId        = $TeamId
        targetName    = $TargetName
        plan          = $Plan
        result        = $Result
        auditEvent    = $audit
        teamOperation = $operation
    }
}

function Complete-TeamActionFailure {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Context,

        [Parameter(Mandatory)]
        [string]$Action,

        [Parameter(Mandatory)]
        [string]$TeamId,

        [Parameter(Mandatory)]
        [string]$TargetName,

        [Parameter()]
        [object]$Before = $null,

        [Parameter()]
        [object]$Plan = $null,

        [Parameter(Mandatory)]
        [string]$ErrorMessage
    )

    $audit = New-TeamActionAuditEvent -TenantId $Context.TenantId -Action $Action `
        -TargetId $TeamId -TargetName $TargetName -Before $Before -After $null `
        -Actor $Context.Actor -CorrelationId $Context.CorrelationId `
        -Result 'failure' -ErrorMessage $ErrorMessage
    $operation = New-TeamOperationRow -TenantId $Context.TenantId -TeamId $TeamId `
        -Operation $Action -State 'failed' -By $Context.Actor -Result $ErrorMessage
    $null = & $Context.WriteAudit $audit
    $null = & $Context.WriteTeamOperation $operation

    return [pscustomobject]@{
        success       = $false
        state         = 'failed'
        operation     = $Action
        teamId        = $TeamId
        targetName    = $TargetName
        plan          = $Plan
        result        = $null
        auditEvent    = $audit
        teamOperation = $operation
        error         = $ErrorMessage
    }
}

function Invoke-TeamEdit {
    <#
    .SYNOPSIS
        Previews or applies an edit to one team.
    .DESCRIPTION
        -DryRun returns the plan with no Graph write. The team is looked up live
        first for the before snapshot; an unknown team throws a structured
        NotFound error. Every apply emits one audit event plus a TeamOperation.
    .PARAMETER TenantId
        Tenant the team belongs to.
    .PARAMETER TeamId
        Team identity to edit.
    .PARAMETER Changes
        Known editable team fields to change.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Actor
        Caller identity recorded on the audit event and TeamOperation.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .PARAMETER WriteTeamOperation
        Seam: scriptblock (operation) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-TeamEdit -TenantId 'tenant-a' -TeamId 'team-1' -Changes @{ description = 'x' }
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TeamId,

        [Parameter()]
        [object]$Changes,

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) },

        [Parameter()]
        [scriptblock]$WriteTeamOperation = { param($Operation) }
    )

    $teamKey = $TeamId.Trim()
    $before = Get-TeamState -TeamId $teamKey
    if ($null -eq $before) {
        throw "NotFound: team '$teamKey' was not found; edit is available only for a live team"
    }

    $changes = ConvertTo-TeamChangesHashtable -Changes $Changes
    if ($changes.Count -eq 0) {
        throw 'ValidationFailed: at least one editable team field is required'
    }

    $targetName = [string]$before.displayName
    if ($changes.ContainsKey('displayName') -and -not [string]::IsNullOrWhiteSpace([string]$changes['displayName'])) {
        $targetName = ([string]$changes['displayName']).Trim()
    }

    $after = @{
        id                = $teamKey
        displayName       = $targetName
        description       = $before.description
        visibility        = $before.visibility
        isArchived        = $before.isArchived
        memberSettings    = $before.memberSettings
        guestSettings     = $before.guestSettings
        messagingSettings = $before.messagingSettings
        funSettings       = $before.funSettings
    }
    $diff = [System.Collections.Generic.List[string]]::new()
    foreach ($field in $changes.Keys) {
        $after[$field] = $changes[$field]
        $null = $diff.Add("Set $field to '$($changes[$field])'")
    }

    $plan = [pscustomobject]@{
        action               = 'edit'
        teamId               = $teamKey
        targetName           = $targetName
        before               = $before
        after                = [pscustomobject]$after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = $false
    }

    if ($DryRun) {
        return $plan
    }

    $context = @{
        TenantId      = $TenantId
        Actor         = $Actor
        CorrelationId = $CorrelationId
        WriteAudit    = $WriteAudit
        WriteTeamOperation = $WriteTeamOperation
    }
    try {
        $body = $changes | ConvertTo-Json -Depth 8 -Compress
        $null = Invoke-MgGraphRequest -Method PATCH -Uri ('/v1.0/teams/{0}' -f $teamKey) -Body $body
    }
    catch {
        return Complete-TeamActionFailure -Context $context -Action 'edit' -TeamId $teamKey -TargetName $targetName -Before $before -Plan $plan -ErrorMessage $_.Exception.Message
    }

    return Complete-TeamAction -Context $context -Action 'edit' -TeamId $teamKey -TargetName $targetName -Before $before -After $plan.after -Plan $plan -Result @{ id = $teamKey; state = 'edited' }
}

function Invoke-TeamArchive {
    <#
    .SYNOPSIS
        Previews or applies archiving one team.
    .DESCRIPTION
        Archive is reversible, so it is audited but does not require
        confirmation. -DryRun returns the plan with no Graph write. An unknown
        team throws a structured NotFound error.
    .PARAMETER TenantId
        Tenant the team belongs to.
    .PARAMETER TeamId
        Team identity to archive.
    .PARAMETER ShouldSetSpoSiteReadOnlyForMembers
        Also set the SharePoint site read-only for members (Graph default true).
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Actor
        Caller identity recorded on the audit event and TeamOperation.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .PARAMETER WriteTeamOperation
        Seam: scriptblock (operation) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-TeamArchive -TenantId 'tenant-a' -TeamId 'team-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TeamId,

        [Parameter()]
        [bool]$ShouldSetSpoSiteReadOnlyForMembers = $true,

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) },

        [Parameter()]
        [scriptblock]$WriteTeamOperation = { param($Operation) }
    )

    $teamKey = $TeamId.Trim()
    $before = Get-TeamState -TeamId $teamKey
    if ($null -eq $before) {
        throw "NotFound: team '$teamKey' was not found; archive is available only for a live team"
    }

    $targetName = [string]$before.displayName
    $after = [pscustomobject]@{
        id                = $teamKey
        displayName       = $targetName
        visibility        = $before.visibility
        isArchived        = $true
    }
    $diff = @("Archive team '$targetName' ($teamKey)")

    $plan = [pscustomobject]@{
        action               = 'archive'
        teamId               = $teamKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = $diff
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = $false
    }

    if ($DryRun) {
        return $plan
    }

    $context = @{
        TenantId      = $TenantId
        Actor         = $Actor
        CorrelationId = $CorrelationId
        WriteAudit    = $WriteAudit
        WriteTeamOperation = $WriteTeamOperation
    }
    try {
        $body = @{ shouldSetSpoSiteReadOnlyForMembers = [bool]$ShouldSetSpoSiteReadOnlyForMembers } | ConvertTo-Json -Compress
        $null = Invoke-MgGraphRequest -Method POST -Uri ('/v1.0/teams/{0}/archive' -f $teamKey) -Body $body
    }
    catch {
        return Complete-TeamActionFailure -Context $context -Action 'archive' -TeamId $teamKey -TargetName $targetName -Before $before -Plan $plan -ErrorMessage $_.Exception.Message
    }

    return Complete-TeamAction -Context $context -Action 'archive' -TeamId $teamKey -TargetName $targetName -Before $before -After $after -Plan $plan -Result @{ id = $teamKey; state = 'archived' }
}

function Invoke-TeamClone {
    <#
    .SYNOPSIS
        Previews or applies cloning one team.
    .DESCRIPTION
        A clone creates a new team from an existing one; the source team is
        looked up live first for the before snapshot and the default copy
        values. -DryRun returns the plan with no Graph write. An unknown source
        team throws a structured NotFound error. Every apply emits one audit
        event plus a TeamOperation.
    .PARAMETER TenantId
        Tenant the teams belong to.
    .PARAMETER TeamId
        Source team identity to clone.
    .PARAMETER NewName
        Display name for the cloned team.
    .PARAMETER Description
        Optional description for the clone; defaults to the source description.
    .PARAMETER Visibility
        Optional visibility for the clone; defaults to the source visibility.
    .PARAMETER PartsToClone
        Comma-separated Graph parts list; defaults to apps,tabs,settings,channels,members.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Actor
        Caller identity recorded on the audit event and TeamOperation.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .PARAMETER WriteTeamOperation
        Seam: scriptblock (operation) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-TeamClone -TenantId 'tenant-a' -TeamId 'team-1' -NewName 'Project Alpha (copy)'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TeamId,

        [Parameter()]
        [string]$NewName = '',

        [Parameter()]
        [string]$Description = '',

        [Parameter()]
        [string]$Visibility = '',

        [Parameter()]
        [string]$PartsToClone = 'apps,tabs,settings,channels,members',

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) },

        [Parameter()]
        [scriptblock]$WriteTeamOperation = { param($Operation) }
    )

    $teamKey = $TeamId.Trim()
    $before = Get-TeamState -TeamId $teamKey
    if ($null -eq $before) {
        throw "NotFound: team '$teamKey' was not found; clone is available only for a live team"
    }

    $sourceName = [string]$before.displayName
    $cloneName = $NewName.Trim()
    if ($cloneName.Length -eq 0) {
        throw 'ValidationFailed: newName is required to clone a team'
    }

    $cloneDescription = $Description
    if ($cloneDescription.Length -eq 0) {
        $cloneDescription = [string]$before.description
    }
    $cloneVisibility = $Visibility.Trim().ToLowerInvariant()
    if ($cloneVisibility.Length -eq 0) {
        $cloneVisibility = ([string]$before.visibility).Trim().ToLowerInvariant()
    }

    $targetName = $cloneName
    $after = [pscustomobject]@{
        sourceTeamId = $teamKey
        displayName  = $cloneName
        description  = $cloneDescription
        visibility   = $cloneVisibility
        partsToClone = $PartsToClone
        state        = 'cloning'
    }
    $diff = @("Clone team '$sourceName' ($teamKey) to '$cloneName'")

    $plan = [pscustomobject]@{
        action               = 'clone'
        teamId               = $teamKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = $diff
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = $false
    }

    if ($DryRun) {
        return $plan
    }

    $context = @{
        TenantId      = $TenantId
        Actor         = $Actor
        CorrelationId = $CorrelationId
        WriteAudit    = $WriteAudit
        WriteTeamOperation = $WriteTeamOperation
    }
    try {
        $body = @{
            displayName  = $cloneName
            partsToClone = $PartsToClone
        }
        if ($cloneDescription.Length -gt 0) {
            $body['description'] = $cloneDescription
        }
        if ($script:TeamVisibilities -contains $cloneVisibility) {
            $body['visibility'] = $cloneVisibility
        }
        $null = Invoke-MgGraphRequest -Method POST -Uri ('/v1.0/teams/{0}/clone' -f $teamKey) -Body ($body | ConvertTo-Json -Compress)
    }
    catch {
        return Complete-TeamActionFailure -Context $context -Action 'clone' -TeamId $teamKey -TargetName $targetName -Before $before -Plan $plan -ErrorMessage $_.Exception.Message
    }

    return Complete-TeamAction -Context $context -Action 'clone' -TeamId $teamKey -TargetName $targetName -Before $before -After $after -Plan $plan -Result @{ sourceTeamId = $teamKey; displayName = $cloneName; state = 'cloning' }
}

function Invoke-TeamDelete {
    <#
    .SYNOPSIS
        Previews or applies deleting one team.
    .DESCRIPTION
        -DryRun returns the plan with no Graph write. Delete is destructive, so
        without -DryRun the apply requires -Confirmed and -ConfirmName matching
        the team's display name (SPEC §8/§9); the confirmation error names the
        team. The team is looked up live first for the before snapshot; an
        unknown team throws a structured NotFound error. Every apply emits one
        audit event plus a TeamOperation.
    .PARAMETER TenantId
        Tenant the team belongs to.
    .PARAMETER TeamId
        Team identity to delete.
    .PARAMETER ConfirmName
        Typed confirmation that must match the team display name.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant.
    .PARAMETER Confirmed
        Explicit confirmation for apply; the BFF confirms the plan before dispatch.
    .PARAMETER Actor
        Caller identity recorded on the audit event and TeamOperation.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .PARAMETER WriteTeamOperation
        Seam: scriptblock (operation) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-TeamDelete -TenantId 'tenant-a' -TeamId 'team-1' -Confirmed $true -ConfirmName 'Project Alpha'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TeamId,

        [Parameter()]
        [string]$ConfirmName = '',

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) },

        [Parameter()]
        [scriptblock]$WriteTeamOperation = { param($Operation) }
    )

    $teamKey = $TeamId.Trim()
    $before = Get-TeamState -TeamId $teamKey
    if ($null -eq $before) {
        throw "NotFound: team '$teamKey' was not found; delete is available only for a live team"
    }

    $targetName = [string]$before.displayName
    $after = [pscustomobject]@{
        id          = $teamKey
        displayName = $targetName
        state       = 'deleted'
    }
    $diff = @("Delete team '$targetName' ($teamKey)")

    $plan = [pscustomobject]@{
        action               = 'delete'
        teamId               = $teamKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = $diff
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = $true
    }

    if ($DryRun) {
        return $plan
    }

    if (-not $Confirmed -or [string]::IsNullOrWhiteSpace($ConfirmName)) {
        throw "teams.confirm_required: delete of team '$targetName' ($teamKey) requires explicit confirmation naming the team"
    }
    if ($ConfirmName.Trim() -ne $targetName.Trim()) {
        throw "teams.confirm_name_mismatch: confirmation name '$($ConfirmName.Trim())' does not match team '$targetName'"
    }

    $context = @{
        TenantId      = $TenantId
        Actor         = $Actor
        CorrelationId = $CorrelationId
        WriteAudit    = $WriteAudit
        WriteTeamOperation = $WriteTeamOperation
    }
    try {
        $null = Invoke-MgGraphRequest -Method DELETE -Uri ('/v1.0/teams/{0}' -f $teamKey)
    }
    catch {
        return Complete-TeamActionFailure -Context $context -Action 'delete' -TeamId $teamKey -TargetName $targetName -Before $before -Plan $plan -ErrorMessage $_.Exception.Message
    }

    return Complete-TeamAction -Context $context -Action 'delete' -TeamId $teamKey -TargetName $targetName -Before $before -After $after -Plan $plan -Result @{ id = $teamKey; state = 'deleted' }
}

function Invoke-TeamAction {
    <#
    .SYNOPSIS
        Dispatches one team lifecycle action to its handler.
    .DESCRIPTION
        Maps the action name used by the job envelope and entrypoint onto the
        edit, archive, clone, and delete handlers so the entrypoint stays thin.
    .PARAMETER TenantId
        Tenant the action targets.
    .PARAMETER Action
        edit | archive | clone | delete.
    .PARAMETER TeamId
        Team identity the action targets.
    .PARAMETER Changes
        Editable fields for edit.
    .PARAMETER NewName
        Clone display name.
    .PARAMETER Description
        Clone description.
    .PARAMETER Visibility
        Clone visibility.
    .PARAMETER PartsToClone
        Clone parts list.
    .PARAMETER ShouldSetSpoSiteReadOnlyForMembers
        Archive SharePoint read-only flag.
    .PARAMETER ConfirmName
        Delete confirmation name.
    .PARAMETER DryRun
        Report the intended change without writing.
    .PARAMETER Confirmed
        Explicit confirmation for delete apply.
    .PARAMETER Actor
        Caller identity recorded on the audit events.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit events.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .PARAMETER WriteTeamOperation
        Seam: scriptblock (operation) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-TeamAction -TenantId 'tenant-a' -Action 'archive' -TeamId 'team-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('edit', 'archive', 'clone', 'delete')]
        [string]$Action,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TeamId,

        [Parameter()]
        [object]$Changes,

        [Parameter()]
        [string]$NewName = '',

        [Parameter()]
        [string]$Description = '',

        [Parameter()]
        [string]$Visibility = '',

        [Parameter()]
        [string]$PartsToClone = 'apps,tabs,settings,channels,members',

        [Parameter()]
        [bool]$ShouldSetSpoSiteReadOnlyForMembers = $true,

        [Parameter()]
        [string]$ConfirmName = '',

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) },

        [Parameter()]
        [scriptblock]$WriteTeamOperation = { param($Operation) }
    )

    switch ($Action) {
        'edit' {
            return Invoke-TeamEdit -TenantId $TenantId -TeamId $TeamId -Changes $Changes -DryRun $DryRun -Actor $Actor -CorrelationId $CorrelationId -WriteAudit $WriteAudit -WriteTeamOperation $WriteTeamOperation
        }
        'archive' {
            return Invoke-TeamArchive -TenantId $TenantId -TeamId $TeamId -ShouldSetSpoSiteReadOnlyForMembers $ShouldSetSpoSiteReadOnlyForMembers -DryRun $DryRun -Actor $Actor -CorrelationId $CorrelationId -WriteAudit $WriteAudit -WriteTeamOperation $WriteTeamOperation
        }
        'clone' {
            return Invoke-TeamClone -TenantId $TenantId -TeamId $TeamId -NewName $NewName -Description $Description -Visibility $Visibility -PartsToClone $PartsToClone -DryRun $DryRun -Actor $Actor -CorrelationId $CorrelationId -WriteAudit $WriteAudit -WriteTeamOperation $WriteTeamOperation
        }
        'delete' {
            return Invoke-TeamDelete -TenantId $TenantId -TeamId $TeamId -ConfirmName $ConfirmName -DryRun $DryRun -Confirmed $Confirmed -Actor $Actor -CorrelationId $CorrelationId -WriteAudit $WriteAudit -WriteTeamOperation $WriteTeamOperation
        }
        default {
            throw "teams.unknown_action: '$Action'"
        }
    }
}

function Read-TeamActionJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-TeamAction parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        action, target, edit changes, clone values, confirmation, and dry-run
        flag. The envelope carries references and planned values only; secrets
        are never present here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-TeamActionJob -Path './run/team-action-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Team action job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Team action job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Team action job is missing required field: tenantId'
    }
    $action = [string]$job['action']
    if ($script:TeamActions -notcontains $action) {
        throw "Team action job has unsupported action: '$action'"
    }
    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }

    return @{
        TenantId                         = $tenantId
        Action                           = $action
        TeamId                           = if ($payload['teamId']) { [string]$payload['teamId'] } else { '' }
        Changes                          = $payload['changes']
        NewName                          = if ($payload['newName']) { [string]$payload['newName'] } else { '' }
        Description                      = if ($payload['description']) { [string]$payload['description'] } else { '' }
        Visibility                       = if ($payload['visibility']) { [string]$payload['visibility'] } else { '' }
        PartsToClone                     = if ($payload['partsToClone']) { [string]$payload['partsToClone'] } else { 'apps,tabs,settings,channels,members' }
        ShouldSetSpoSiteReadOnlyForMembers = if ($null -ne $payload['shouldSetSpoSiteReadOnlyForMembers']) { [bool]$payload['shouldSetSpoSiteReadOnlyForMembers'] } else { $true }
        Confirmed                        = ($payload['confirm'] -eq $true)
        ConfirmName                      = if ($payload['confirmName']) { [string]$payload['confirmName'] } else { '' }
        DryRun                           = ($payload['dryRun'] -eq $true)
        Actor                            = if ($job['actor']) { [string]$job['actor'] } else { '' }
        CorrelationId                    = if ($job['correlationId']) { [string]$job['correlationId'] } else { '' }
    }
}
