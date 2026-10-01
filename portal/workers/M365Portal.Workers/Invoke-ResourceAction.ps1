# Invoke-ResourceAction.ps1 — EPIC-023 resource write worker (SPEC §3.3, §4.3, §6, §7, §8; T-0449).
#
# Executes resource writes live against Exchange Online: create, edit, and delete
# for rooms and equipment, and membership add/remove for room lists. Resources
# are not registry CheckId commands, so this follows the EPIC-006 executor
# contract (T-0108) instead of the CheckId-bound apply path: -DryRun plans the
# change with no tenant write and no audit, delete requires explicit -Confirmed
# re-checked here so a job that skips confirmation cannot apply it, and every
# apply captures before/after and emits one AuditEvent through -WriteAudit.
# addMember rejects a duplicate membership with a failed result instead of
# writing. Unknown actions are refused with a structured error, never passed
# through. The EXO session is connected by the entrypoint after materializing
# the tenant credential in-process; this file never touches secrets.

function Get-ResourceActions {
    <#
    .SYNOPSIS
        Returns the resource action set this worker dispatches.
    .DESCRIPTION
        The single source of truth for valid action names. Anything else is
        refused with resources.unknown_action.
    .EXAMPLE
        Get-ResourceActions
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('create', 'edit', 'delete', 'addMember', 'removeMember')
}

function Get-ResourceActionConfirmation {
    <#
    .SYNOPSIS
        Returns the actions that require explicit confirmation.
    .DESCRIPTION
        Delete is destructive and requires confirmation before apply.
    .EXAMPLE
        Get-ResourceActionConfirmation
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('delete')
}

function Get-ResourceActionKinds {
    <#
    .SYNOPSIS
        Returns the resource kinds each action accepts.
    .DESCRIPTION
        create applies to rooms and equipment; edit and delete apply to all
        kinds; addMember and removeMember apply to room lists only (SPEC §6,
        §11 item 3).
    .EXAMPLE
        Get-ResourceActionKinds -Action 'addMember'
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('create', 'edit', 'delete', 'addMember', 'removeMember')]
        [string]$Action
    )

    switch ($Action) {
        'addMember' { return @('roomlists') }
        'removeMember' { return @('roomlists') }
        'create' { return @('rooms', 'equipment') }
        default { return @('rooms', 'equipment', 'roomlists') }
    }
}

function Get-ResourceRecord {
    <#
    .SYNOPSIS
        Reads one room, equipment, or room list by id for before/after capture.
    .DESCRIPTION
        Tries Get-EXOMailbox first (rooms/equipment), then Get-DistributionGroup
        (room lists), and returns the record plus the recipient kind so the
        caller can pick the Set-/Remove- cmdlet. A missing resource returns
        $null.
    .PARAMETER ResourceId
        The resource (Exchange object) id.
    .EXAMPLE
        Get-ResourceRecord -ResourceId 'room-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$ResourceId
    )

    $record = $null
    $kind = ''
    try {
        $record = Get-EXOMailbox -Identity $ResourceId -ErrorAction Stop
        $kind = 'Mailbox'
    }
    catch {
        try {
            $record = Get-DistributionGroup -Identity $ResourceId -ErrorAction Stop
            $kind = 'DistributionGroup'
        }
        catch {
            return $null
        }
    }
    if ($null -eq $record) {
        return $null
    }
    return [pscustomobject]@{
        Record = $record
        Kind   = $kind
    }
}

function ConvertTo-ResourceState {
    <#
    .SYNOPSIS
        Shapes one EXO resource record into the before/after comparison state.
    .PARAMETER Record
        The Get-EXOMailbox / Get-DistributionGroup / New-* record.
    .EXAMPLE
        ConvertTo-ResourceState -Record $room
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Record
    )

    $id = [string]$Record.ExchangeObjectId
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Record.PrimarySmtpAddress
    }

    $name = $null
    if (([string]$Record.DisplayName).Trim().Length -gt 0) {
        $name = [string]$Record.DisplayName
    }

    $capacity = $null
    $rawCapacity = $Record.Capacity
    if ($null -ne $rawCapacity -and ([string]$rawCapacity).Trim().Length -gt 0) {
        $parsedCapacity = 0
        if ([int]::TryParse([string]$rawCapacity, [ref]$parsedCapacity)) {
            $capacity = $parsedCapacity
        }
    }

    $location = $null
    $rawLocation = [string]$Record.CustomAttribute1
    if ($rawLocation.Trim().Length -gt 0) {
        $location = $rawLocation.Trim()
    }

    $type = 'room'
    switch ([string]$Record.RecipientTypeDetails) {
        'EquipmentMailbox' { $type = 'equipment' }
        'RoomList' { $type = 'roomlist' }
    }

    return [pscustomobject]@{
        id                 = $id
        name               = $name
        primarySmtpAddress = [string]$Record.PrimarySmtpAddress
        capacity           = $capacity
        location           = $location
        type               = $type
        hidden             = ($Record.HiddenFromAddressListsEnabled -eq $true)
    }
}

function Get-ResourceMembersSafe {
    <#
    .SYNOPSIS
        Reads one room list's membership, surviving a failed member read.
    .DESCRIPTION
        A room list whose member read fails yields an empty member list so one
        unavailable slice cannot fail the action. Only Get- cmdlets are issued.
    .PARAMETER Identity
        The room list identity (ExchangeObjectId or primary SMTP address).
    .EXAMPLE
        Get-ResourceMembersSafe -Identity 'rl-1'
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Identity
    )

    try {
        return @(Get-DistributionGroupMember -Identity $Identity -ResultSize Unlimited -ErrorAction Stop)
    }
    catch {
        Write-Verbose "Room list membership unavailable for '$Identity': $($_.Exception.Message)"
        return @()
    }
}

function Test-ResourceMemberExists {
    <#
    .SYNOPSIS
        Checks whether a room list already contains a member.
    .DESCRIPTION
        Matches on ExchangeObjectId first, then primary SMTP address, so a
        duplicate add is rejected before any write (SPEC §9 duplicate risk).
    .PARAMETER Members
        The Get-DistributionGroupMember records for the room list.
    .PARAMETER MemberId
        The member (Exchange object) id or primary SMTP address.
    .EXAMPLE
        Test-ResourceMemberExists -Members $members -MemberId 'room-1'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object[]]$Members,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$MemberId
    )

    foreach ($member in @($Members)) {
        if ($null -eq $member) {
            continue
        }
        if ([string]$member.ExchangeObjectId -eq $MemberId) {
            return $true
        }
        if ([string]$member.PrimarySmtpAddress -ieq $MemberId) {
            return $true
        }
    }
    return $false
}

function ConvertTo-ResourceCapacity {
    <#
    .SYNOPSIS
        Interprets the Capacity parameter as a nullable integer.
    .DESCRIPTION
        $Capacity is [object] so edit can distinguish "not provided" ($null:
        keep the current value) from an explicit value. Returns $null when the
        value was not supplied or is not a valid integer.
    .PARAMETER Value
        The Capacity parameter value.
    .EXAMPLE
        ConvertTo-ResourceCapacity -Value $Capacity
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter()]
        [object]$Value = $null
    )

    if ($null -eq $Value) {
        return $null
    }
    $parsed = 0
    if ([int]::TryParse([string]$Value, [ref]$parsed)) {
        return $parsed
    }
    return $null
}

function ConvertTo-ResourceText {
    <#
    .SYNOPSIS
        Interprets a tri-state text parameter, returning $null when not provided.
    .DESCRIPTION
        Distinguishes "not provided" ($null: keep the current value) from an
        explicit empty string (clear the value).
    .PARAMETER Value
        The parameter value.
    .EXAMPLE
        ConvertTo-ResourceText -Value $Location
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter()]
        [object]$Value = $null
    )

    if ($null -eq $Value) {
        return $null
    }
    return ([string]$Value).Trim()
}

function ConvertTo-ResourceFlag {
    <#
    .SYNOPSIS
        Interprets the tri-state Hidden parameter as a boolean.
    .DESCRIPTION
        $Hidden is [object] so edit can distinguish "not provided" ($null: keep
        the current value) from an explicit $false. Returns $false when the flag
        was not supplied.
    .PARAMETER Value
        The Hidden parameter value.
    .EXAMPLE
        ConvertTo-ResourceFlag -Value $Hidden
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [object]$Value = $null
    )

    if ($null -eq $Value) {
        return $false
    }
    return [bool]$Value
}

function Invoke-ResourceAction {
    <#
    .SYNOPSIS
        Executes one resource write action live against Exchange Online.
    .DESCRIPTION
        Dispatches create, edit, delete, addMember, or removeMember. -DryRun
        returns the intended change with no EXO write and no audit. Delete
        requires -Confirmed. addMember rejects a duplicate membership with a
        failed result. Returns a planned/failed result for dry runs and missing
        resources, and a plan/result/auditEvent record for applies. Apply
        failures are returned, not thrown; only unknown actions, missing
        inputs, and missing confirmation throw.
    .PARAMETER TenantId
        Tenant the resource belongs to. Carried through to the result envelope.
    .PARAMETER Kind
        Resource kind: rooms, equipment, or roomlists.
    .PARAMETER Action
        One of the Get-ResourceActions names.
    .PARAMETER ResourceId
        The target resource id. Required for edit, delete, addMember, and
        removeMember.
    .PARAMETER DisplayName
        Display name for create; new display name for edit.
    .PARAMETER Capacity
        Seat capacity for create and edit. Omit ($null) to keep the current
        value on edit.
    .PARAMETER Location
        Room location (CustomAttribute1) for create and edit. Omit ($null) to
        keep the current value on edit.
    .PARAMETER Hidden
        Hidden-from-GAL flag for create and edit. Omit ($null) to keep the
        current value on edit.
    .PARAMETER MemberId
        Member resource id for addMember and removeMember.
    .PARAMETER DryRun
        Report the intended change without writing to the tenant. Defaults to
        $false; the BFF sets it from the preview flag before dispatch.
    .PARAMETER Confirmed
        Explicit confirmation for delete.
    .PARAMETER Actor
        Caller identity recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-ResourceAction -TenantId 'tenant-a' -Kind 'rooms' -Action 'create' -DisplayName 'Focus Room' -Capacity 8
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateSet('rooms', 'equipment', 'roomlists')]
        [string]$Kind,

        [Parameter(Mandatory)]
        [string]$Action,

        [Parameter()]
        [string]$ResourceId = '',

        [Parameter()]
        [string]$DisplayName = '',

        [Parameter()]
        [object]$Capacity = $null,

        [Parameter()]
        [object]$Location = $null,

        [Parameter()]
        [object]$Hidden = $null,

        [Parameter()]
        [string]$MemberId = '',

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [switch]$Confirmed,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    $known = Get-ResourceActions
    if (-not $known.Contains($Action)) {
        throw "resources.unknown_action: unknown resource action '$Action'; expected one of: $($known -join ', ')"
    }
    $kinds = Get-ResourceActionKinds -Action $Action
    if (-not $kinds.Contains($Kind)) {
        throw "resources.kind_mismatch: action '$Action' does not apply to kind '$Kind'; expected one of: $($kinds -join ', ')"
    }
    if (-not $DryRun -and (Get-ResourceActionConfirmation).Contains($Action) -and -not $Confirmed) {
        throw "resources.confirm_required: action '$Action' requires explicit confirmation"
    }

    $before = $null
    $after = $null
    $diff = [System.Collections.Generic.List[string]]::new()
    $existing = $null

    if ($Action -in @('edit', 'delete', 'addMember', 'removeMember')) {
        if ([string]::IsNullOrWhiteSpace($ResourceId)) {
            throw "resources.validation_failed: resourceId is required for $Action"
        }
        $existing = Get-ResourceRecord -ResourceId $ResourceId
        if ($null -eq $existing) {
            return [pscustomobject]@{
                resourceId = $ResourceId
                action     = $Action
                status     = 'failed'
                before     = $null
                after      = $null
                error      = "resource '$ResourceId' was not found"
            }
        }
        $before = ConvertTo-ResourceState -Record $existing.Record
    }

    switch ($Action) {
        'create' {
            if ([string]::IsNullOrWhiteSpace($DisplayName)) {
                throw "resources.validation_failed: displayName is required for create"
            }
            $newCapacity = ConvertTo-ResourceCapacity -Value $Capacity
            $newLocation = ConvertTo-ResourceText -Value $Location
            $newHidden = ConvertTo-ResourceFlag -Value $Hidden
            $after = [pscustomobject]@{
                id                 = ''
                name               = $DisplayName.Trim()
                primarySmtpAddress = ''
                capacity           = $newCapacity
                location           = $newLocation
                type               = $(if ($Kind -eq 'equipment') { 'equipment' } else { 'room' })
                hidden             = $newHidden
            }
            $diff.Add("Create $Kind resource '$($DisplayName.Trim())'")
            if ($null -ne $newCapacity) {
                $diff.Add("Set capacity: $newCapacity")
            }
            if ($null -ne $newLocation) {
                $diff.Add("Set location: $newLocation")
            }
            if ($newHidden) {
                $diff.Add('Hide from GAL')
            }
        }
        'edit' {
            $newName = if (-not [string]::IsNullOrWhiteSpace($DisplayName)) { (ConvertTo-ResourceText -Value $DisplayName) } else { $before.name }
            $newCapacity = ConvertTo-ResourceCapacity -Value $Capacity
            if ($null -eq $newCapacity) { $newCapacity = $before.capacity }
            $newLocation = ConvertTo-ResourceText -Value $Location
            if ($null -eq $newLocation) { $newLocation = $before.location }
            $newHidden = if ($null -ne $Hidden) { [bool]$Hidden } else { $before.hidden }
            $after = [pscustomobject]@{
                id                 = $before.id
                name               = $newName
                primarySmtpAddress = $before.primarySmtpAddress
                capacity           = $newCapacity
                location           = $newLocation
                type               = $before.type
                hidden             = $newHidden
            }
            if ($after.name -ne $before.name) {
                $diff.Add("Change name: '$($before.name)' -> '$($after.name)'")
            }
            if ($after.capacity -ne $before.capacity) {
                $diff.Add("Change capacity: '$($before.capacity)' -> '$($after.capacity)'")
            }
            if ($after.location -ne $before.location) {
                $diff.Add("Change location: '$($before.location)' -> '$($after.location)'")
            }
            if ($after.hidden -ne $before.hidden) {
                $diff.Add("Change hidden: '$($before.hidden)' -> '$($after.hidden)'")
            }
        }
        'delete' {
            $diff.Add("Delete $Kind '$($before.name)' ($ResourceId)")
        }
        'addMember' {
            if ([string]::IsNullOrWhiteSpace($MemberId)) {
                throw "resources.validation_failed: memberId is required for addMember"
            }
            $members = Get-ResourceMembersSafe -Identity $ResourceId
            if (Test-ResourceMemberExists -Members $members -MemberId $MemberId) {
                return [pscustomobject]@{
                    resourceId = $ResourceId
                    action     = $Action
                    status     = 'failed'
                    before     = $before
                    after      = $null
                    error      = "resource '$MemberId' is already a member of room list '$ResourceId'"
                }
            }
            $diff.Add("Add member '$MemberId' to room list '$($before.name)'")
        }
        'removeMember' {
            if ([string]::IsNullOrWhiteSpace($MemberId)) {
                throw "resources.validation_failed: memberId is required for removeMember"
            }
            $members = Get-ResourceMembersSafe -Identity $ResourceId
            if (-not (Test-ResourceMemberExists -Members $members -MemberId $MemberId)) {
                return [pscustomobject]@{
                    resourceId = $ResourceId
                    action     = $Action
                    status     = 'failed'
                    before     = $before
                    after      = $null
                    error      = "resource '$MemberId' is not a member of room list '$ResourceId'"
                }
            }
            $diff.Add("Remove member '$MemberId' from room list '$($before.name)'")
        }
    }

    $effectiveResourceId = if ($Action -eq 'create') { '' } else { $ResourceId }
    $targetName = if ($Action -eq 'create') { $after.name } else { $before.name }

    $plan = [pscustomobject]@{
        action               = $Action
        resourceId           = $effectiveResourceId
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = ($Action -eq 'delete')
    }

    if ($DryRun) {
        return $plan
    }

    $appliedAt = [DateTime]::UtcNow.ToString('o')
    $auditEvent = @{
        id            = [guid]::NewGuid().ToString()
        tenantId      = $TenantId
        action        = "resources.action:$Action"
        resourceId    = $effectiveResourceId
        targetName    = $targetName
        timestamp     = $appliedAt
        before        = $before
        after         = $null
        actor         = $Actor
        correlationId = $CorrelationId
    }

    try {
        $appliedResult = $null
        switch ($Action) {
            'create' {
                $mailboxType = if ($Kind -eq 'equipment') { 'Equipment' } else { 'Room' }
                $newParams = @{
                    Name         = $DisplayName.Trim()
                    DisplayName  = $DisplayName.Trim()
                    ErrorAction  = 'Stop'
                }
                if ($null -ne (ConvertTo-ResourceCapacity -Value $Capacity)) {
                    $newParams['Capacity'] = [int](ConvertTo-ResourceCapacity -Value $Capacity)
                }
                if ($null -ne (ConvertTo-ResourceText -Value $Location)) {
                    $newParams['CustomAttribute1'] = (ConvertTo-ResourceText -Value $Location)
                }
                if ($null -ne $Hidden) {
                    $newParams['HiddenFromAddressListsEnabled'] = [bool]$Hidden
                }
                $appliedResult = New-Mailbox -Type $mailboxType @newParams
                $newState = ConvertTo-ResourceState -Record $appliedResult
                $after = $newState
                $effectiveResourceId = $newState.id
                $auditEvent['resourceId'] = $newState.id
            }
            'edit' {
                $setParams = @{
                    Identity = $ResourceId
                }
                if (-not [string]::IsNullOrWhiteSpace($DisplayName)) { $setParams['DisplayName'] = (ConvertTo-ResourceText -Value $DisplayName) }
                $newCapacity = ConvertTo-ResourceCapacity -Value $Capacity
                if ($null -ne $newCapacity) { $setParams['Capacity'] = $newCapacity }
                $newLocation = ConvertTo-ResourceText -Value $Location
                if ($null -ne $newLocation) { $setParams['CustomAttribute1'] = $newLocation }
                if ($null -ne $Hidden) { $setParams['HiddenFromAddressListsEnabled'] = [bool]$Hidden }
                if ($existing.Kind -eq 'DistributionGroup') {
                    $appliedResult = Set-DistributionGroup @setParams
                }
                else {
                    $appliedResult = Set-EXOMailbox @setParams
                }
                $reread = Get-ResourceRecord -ResourceId $ResourceId
                if ($null -ne $reread) {
                    $after = ConvertTo-ResourceState -Record $reread.Record
                }
            }
            'delete' {
                if ($existing.Kind -eq 'DistributionGroup') {
                    $appliedResult = Remove-DistributionGroup -Identity $ResourceId -Confirm:$false
                }
                else {
                    $appliedResult = Remove-Mailbox -Identity $ResourceId -Confirm:$false
                }
                $appliedResult = @{ deleted = $true; id = $ResourceId }
                $after = $null
            }
            'addMember' {
                $appliedResult = Add-DistributionGroupMember -Identity $ResourceId -Member $MemberId -Confirm:$false
                $reread = Get-ResourceRecord -ResourceId $ResourceId
                if ($null -ne $reread) {
                    $after = ConvertTo-ResourceState -Record $reread.Record
                }
            }
            'removeMember' {
                $appliedResult = Remove-DistributionGroupMember -Identity $ResourceId -Member $MemberId -Confirm:$false
                $reread = Get-ResourceRecord -ResourceId $ResourceId
                if ($null -ne $reread) {
                    $after = ConvertTo-ResourceState -Record $reread.Record
                }
            }
        }

        $auditEvent['after'] = $after
        $auditEvent['result'] = 'success'
        $auditEvent['error'] = $null
        $null = & $WriteAudit $auditEvent

        return [pscustomobject]@{
            plan       = $plan
            result     = $appliedResult
            auditEvent = $auditEvent
            success    = $true
        }
    }
    catch {
        $message = $_.Exception.Message
        $auditEvent['after'] = $null
        $auditEvent['result'] = 'failure'
        $auditEvent['error'] = $message
        $null = & $WriteAudit $auditEvent
        return [pscustomobject]@{
            resourceId = $effectiveResourceId
            action     = $Action
            status     = 'failed'
            before     = $before
            after      = $null
            error      = $message
        }
    }
}

function Read-ResourceActionJob {
    <#
    .SYNOPSIS
        Reads a resource action job envelope file into Invoke-ResourceAction parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        resource id, action, kind, and write fields. The envelope carries
        references only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-ResourceActionJob -Path './run/resource-action-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Resource action job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Resource action job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Resource action job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $action = [string]$payload['action']
    if ([string]::IsNullOrWhiteSpace($action)) {
        throw 'Resource action job is missing required field: payload.action'
    }

    $capacity = $null
    if ($null -ne $payload['capacity']) {
        $capacity = $payload['capacity']
    }

    $location = $null
    if ($null -ne $payload['location']) {
        $location = [string]$payload['location']
    }

    $hidden = $null
    if ($null -ne $payload['hidden']) {
        $hidden = [bool]$payload['hidden']
    }

    return @{
        TenantId      = $tenantId
        Kind          = [string]$payload['kind']
        ResourceId    = [string]$payload['resourceId']
        Action        = $action
        DisplayName   = [string]$payload['displayName']
        Capacity      = $capacity
        Location      = $location
        Hidden        = $hidden
        MemberId      = [string]$payload['memberId']
        DryRun        = $payload['dryRun'] -eq $true
        Confirmed     = $payload['confirm'] -eq $true
        Actor         = [string]$payload['actor']
        CorrelationId = [string]$job['correlationId']
    }
}
