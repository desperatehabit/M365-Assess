# New-Team.ps1 — EPIC-026 team create worker (SPEC §2 US-2, §3.1, §4.1, §5, §6, §8; T-0504).
#
# Creates a team from the Add team wizard fields (name, owners, members,
# template, visibility). A supplied local TeamTemplate (T-0501) expands its
# owners, members, and settings into the new team; explicit wizard values are
# merged with the template and de-duplicated so a template plus an override
# never produces a duplicate owner or member.
#
# Gating (EPIC-006 contract, T-0108): team create is not a registry CheckId
# command, so it cannot travel the CheckId-bound executor path. It follows the
# same contract instead — the BFF confirms the plan before dispatch (dryRun
# plans only), -DryRun reports the intended change without writing, every
# applied create captures before (absent) and after (created team), and every
# applied create emits one AuditEvent plus one TeamOperation row (T-0501). The
# Graph session is connected by the supervisor after materializing the tenant
# credential in-process; this file never touches secrets.

$script:TeamVisibilities = @('public', 'private')

function ConvertTo-TeamSettingsHashtable {
    <#
    .SYNOPSIS
        Normalizes a settings value (hashtable or JSON object) to a hashtable.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter()]
        [object]$Settings
    )

    $result = @{}
    if ($null -eq $Settings) {
        return $result
    }
    if ($Settings -is [System.Collections.IDictionary]) {
        foreach ($key in $Settings.Keys) {
            $result[[string]$key] = $Settings[$key]
        }
        return $result
    }
    foreach ($property in $Settings.PSObject.Properties) {
        $result[$property.Name] = $property.Value
    }
    return $result
}

function Merge-TeamIdentityList {
    <#
    .SYNOPSIS
        Merges explicit and template identities, trimming and de-duplicating.
    .DESCRIPTION
        Explicit wizard entries come first, then template entries, so the
        caller's overrides keep their order. Comparison is case-insensitive
        because UPNs and directory ids are.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()]
        [object[]]$Primary = @(),

        [Parameter()]
        [object[]]$Secondary = @()
    )

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $merged = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in @($Primary) + @($Secondary)) {
        if ($null -eq $entry) {
            continue
        }
        $value = ([string]$entry).Trim()
        if ($value.Length -eq 0) {
            continue
        }
        if ($seen.Add($value)) {
            $merged.Add($value)
        }
    }
    return @($merged)
}

function Resolve-TeamTemplate {
    <#
    .SYNOPSIS
        Expands a stored TeamTemplate into the team create fields.
    .DESCRIPTION
        Merges the wizard values with the template: owners and members are the
        union (explicit first, de-duplicated); visibility is the explicit value
        when supplied, otherwise the template's, otherwise private; settings
        are the template's settings overlaid by any explicit settings. Returns
        the resolved team plus the template id, or the explicit values alone
        when no template is supplied.
    .PARAMETER Team
        Wizard team object (name, owners, members, visibility, settings).
    .PARAMETER Template
        Stored TeamTemplate (id, name, owners, members, visibility, settings).
    .EXAMPLE
        Resolve-TeamTemplate -Team $team -Template $template
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Team,

        [Parameter()]
        [object]$Template
    )

    $templateOwners = @()
    $templateMembers = @()
    $templateSettings = @{}
    $templateVisibility = ''
    $templateId = ''
    if ($null -ne $Template) {
        $templateId = [string]$Template.id
        $templateOwners = @($Template.owners)
        $templateMembers = @($Template.members)
        $templateSettings = ConvertTo-TeamSettingsHashtable -Settings $Template.settings
        if (-not [string]::IsNullOrWhiteSpace([string]$Template.visibility)) {
            $templateVisibility = ([string]$Template.visibility).Trim().ToLowerInvariant()
        }
    }

    $owners = @(Merge-TeamIdentityList -Primary @($Team.owners) -Secondary $templateOwners)
    $members = @(Merge-TeamIdentityList -Primary @($Team.members) -Secondary $templateMembers)

    $visibility = ([string]$Team.visibility).Trim().ToLowerInvariant()
    if ($visibility.Length -eq 0) {
        $visibility = $templateVisibility
    }
    if ($visibility.Length -eq 0) {
        $visibility = 'private'
    }

    $settings = @{}
    foreach ($key in $templateSettings.Keys) {
        $settings[$key] = $templateSettings[$key]
    }
    $explicitSettings = ConvertTo-TeamSettingsHashtable -Settings $Team.settings
    foreach ($key in $explicitSettings.Keys) {
        $settings[$key] = $explicitSettings[$key]
    }

    return [pscustomobject]@{
        name       = ([string]$Team.name).Trim()
        owners     = $owners
        members    = $members
        visibility = $visibility
        settings   = $settings
        templateId = $templateId
    }
}

function Test-TeamCreateInput {
    <#
    .SYNOPSIS
        Validates a resolved team create.
    .DESCRIPTION
        Requires a name and a visibility of public or private. Returns the
        error list; an empty list is valid.
    .PARAMETER Team
        Resolved team object (name, owners, members, visibility).
    .EXAMPLE
        Test-TeamCreateInput -Team $resolved
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [object]$Team
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace([string]$Team.name)) {
        $errors.Add('name is required')
    }
    $visibility = ([string]$Team.visibility).Trim().ToLowerInvariant()
    if ($script:TeamVisibilities -notcontains $visibility) {
        $errors.Add("visibility '$($Team.visibility)' must be public or private")
    }
    return @($errors)
}

function New-TeamOperation {
    <#
    .SYNOPSIS
        Builds the TeamOperation audit record for one team create (T-0501).
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [string]$TenantId,

        [Parameter()]
        [string]$TeamId = '',

        [Parameter()]
        [string]$Operation = 'create',

        [Parameter(Mandatory)]
        [ValidateSet('applied', 'failed', 'planned')]
        [string]$State,

        [Parameter()]
        [string]$By = '',

        [Parameter()]
        [string]$Result = '',

        [Parameter()]
        [string]$At = ''
    )

    $timestamp = if ($At) { $At } else { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    return @{
        id        = [guid]::NewGuid().ToString()
        tenantId  = $TenantId
        teamId    = $TeamId
        operation = $Operation
        state     = $State
        by        = if ($By) { $By } else { $null }
        at        = $timestamp
        result    = if ($Result) { $Result } else { $null }
    }
}

function New-TeamAuditEvent {
    <#
    .SYNOPSIS
        Builds the AuditEvent for one team create (EPIC-026 §5).
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [string]$TargetName,

        [Parameter()]
        [string]$TargetId = '',

        [Parameter()]
        [object]$Before = $null,

        [Parameter()]
        [object]$After = $null
    )

    return @{
        id         = [guid]::NewGuid().ToString()
        tenantId   = $TenantId
        action     = 'teams.team.create'
        targetId   = $TargetId
        targetName = $TargetName
        timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        before     = $Before
        after      = $After
    }
}

function New-Team {
    <#
    .SYNOPSIS
        Creates one team live against Graph with before/after capture.
    .DESCRIPTION
        Expands a supplied TeamTemplate, validates the resolved team, then
        creates it as a Microsoft 365 team and attaches owners and members.
        -DryRun returns the intended change with no Graph write. Every applied
        create emits one AuditEvent and one TeamOperation row; apply failures
        are returned, not thrown.
    .PARAMETER TenantId
        Tenant the team belongs to. Carried through to the result envelope.
    .PARAMETER Team
        Wizard team object (name, owners, members, visibility, settings).
    .PARAMETER Template
        Optional stored TeamTemplate expanded into the new team.
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
        New-Team -TenantId 'tenant-a' -Team $team -DryRun
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [object]$Team,

        [Parameter()]
        [object]$Template,

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) },

        [Parameter()]
        [scriptblock]$WriteTeamOperation = { param($Operation) }
    )

    $resolved = Resolve-TeamTemplate -Team $Team -Template $Template
    $failures = @(Test-TeamCreateInput -Team $resolved)
    if ($failures.Count -gt 0) {
        return [pscustomobject]@{
            success       = $false
            status        = 'failed'
            id            = $null
            plan          = $null
            teamOperation = $null
            auditEvent    = $null
            error         = ($failures -join '; ')
        }
    }

    $diff = [System.Collections.Generic.List[string]]::new()
    $null = $diff.Add("Create team '$($resolved.name)' ($($resolved.visibility))")
    if ($resolved.templateId) {
        $null = $diff.Add("Expand template '$($resolved.templateId)': $($resolved.owners.Count) owner(s), $($resolved.members.Count) member(s)")
    }
    elseif ($resolved.owners.Count -gt 0 -or $resolved.members.Count -gt 0) {
        $null = $diff.Add("Add $($resolved.owners.Count) owner(s) and $($resolved.members.Count) member(s)")
    }

    $plan = [pscustomobject]@{
        action               = 'create'
        targetName           = $resolved.name
        before               = $null
        after                = $resolved
        diff                 = @($diff)
        valid                = $true
        dryRun               = [bool]$DryRun
        requiresConfirmation = $false
    }

    if ($DryRun) {
        return [pscustomobject]@{
            success       = $true
            status        = 'planned'
            id            = $null
            plan          = $plan
            teamOperation = $null
            auditEvent    = $null
            error         = $null
        }
    }

    try {
        $body = @{
            'template@odata.bind' = "https://graph.microsoft.com/v1.0/teamsTemplates('standard')"
            displayName           = $resolved.name
            visibility            = $resolved.visibility
        }
        $members = [System.Collections.Generic.List[object]]::new()
        foreach ($owner in $resolved.owners) {
            $members.Add(@{
                '@odata.type'      = '#microsoft.graph.aadUserConversationMember'
                roles              = @('owner')
                'user@odata.bind'  = "https://graph.microsoft.com/v1.0/users('$owner')"
            })
        }
        foreach ($member in $resolved.members) {
            $members.Add(@{
                '@odata.type'      = '#microsoft.graph.aadUserConversationMember'
                roles              = @()
                'user@odata.bind'  = "https://graph.microsoft.com/v1.0/users('$member')"
            })
        }
        if ($members.Count -gt 0) {
            $body['members'] = @($members)
        }
        foreach ($settingsKey in @('memberSettings', 'guestSettings', 'messagingSettings', 'funSettings')) {
            if ($resolved.settings.ContainsKey($settingsKey)) {
                $body[$settingsKey] = $resolved.settings[$settingsKey]
            }
        }

        $created = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/teams' -Body ($body | ConvertTo-Json -Depth 8)
        $teamId = [string]$created.id

        $after = [pscustomobject]@{
            id         = $teamId
            name       = $resolved.name
            owners     = $resolved.owners
            members    = $resolved.members
            visibility = $resolved.visibility
            settings   = $resolved.settings
            templateId = $resolved.templateId
        }
        $auditEvent = New-TeamAuditEvent -TenantId $TenantId -TargetId $teamId -TargetName $resolved.name -Before $null -After $after
        $teamOperation = New-TeamOperation -TenantId $TenantId -TeamId $teamId -State 'applied' -By $Actor -Result 'applied'
        $null = & $WriteAudit $auditEvent
        $null = & $WriteTeamOperation $teamOperation

        return [pscustomobject]@{
            success       = $true
            status        = 'created'
            id            = $teamId
            plan          = $plan
            teamOperation = $teamOperation
            auditEvent    = $auditEvent
            error         = $null
        }
    }
    catch {
        $message = $_.Exception.Message
        $auditEvent = New-TeamAuditEvent -TenantId $TenantId -TargetId '' -TargetName $resolved.name -Before $null -After $null
        $teamOperation = New-TeamOperation -TenantId $TenantId -TeamId '' -State 'failed' -By $Actor -Result $message
        $null = & $WriteAudit $auditEvent
        $null = & $WriteTeamOperation $teamOperation

        return [pscustomobject]@{
            success       = $false
            status        = 'failed'
            id            = $null
            plan          = $plan
            teamOperation = $teamOperation
            auditEvent    = $auditEvent
            error         = $message
        }
    }
}

function Read-TeamCreateJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into New-Team parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        planned team (payload.team) and optional template (payload.template)
        with the dry-run flag and actor. The envelope carries references and
        planned values only; secrets are never present here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-TeamCreateJob -Path './run/team-create-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Team create job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Team create job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Team create job is missing required field: tenantId'
    }
    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    if ($null -eq $payload['team']) {
        throw 'Team create job is missing required field: payload.team'
    }

    return @{
        TenantId      = $tenantId
        Team          = $payload['team']
        Template      = $payload['template']
        DryRun        = ($payload['dryRun'] -eq $true)
        Actor         = if ($payload['actor']) { [string]$payload['actor'] } else { '' }
        CorrelationId = if ($job['correlationId']) { [string]$job['correlationId'] } else { '' }
    }
}
