# Invoke-ContactAction.ps1 — EPIC-023 contacts write worker (SPEC §3.1, §4.1, §6, §7, §8; T-0443).
#
# Executes contact writes live against Exchange Online: create, edit,
# hide-from-GAL, and delete. Contacts are not registry CheckId commands, so
# this follows the EPIC-006 executor contract (T-0108) instead of the
# CheckId-bound apply path: -DryRun plans the change with no tenant write and
# no audit, delete requires explicit -Confirmed re-checked here so a job that
# skips confirmation cannot apply it, and every apply captures before/after
# and emits one AuditEvent through -WriteAudit. Unknown actions are refused
# with a structured error, never passed through. The EXO session is connected
# by the entrypoint after materializing the tenant credential in-process;
# this file never touches secrets.

function Get-ContactActions {
    <#
    .SYNOPSIS
        Returns the contact action set this worker dispatches.
    .DESCRIPTION
        The single source of truth for valid action names. Anything else is
        refused with contacts.unknown_action.
    .EXAMPLE
        Get-ContactActions
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('create', 'edit', 'hideFromGal', 'delete')
}

function Get-ContactActionConfirmation {
    <#
    .SYNOPSIS
        Returns the actions that require explicit confirmation.
    .DESCRIPTION
        Delete is destructive and requires confirmation before apply.
    .EXAMPLE
        Get-ContactActionConfirmation
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('delete')
}

function Get-ContactRecord {
    <#
    .SYNOPSIS
        Reads one mail contact or mail user by id for before/after capture.
    .DESCRIPTION
        Tries Get-MailContact first, then Get-MailUser, and returns the record
        plus the recipient kind so the caller can pick the Set-/Remove-
        cmdlet. A missing contact returns $null.
    .PARAMETER ContactId
        The contact (Exchange object) id.
    .EXAMPLE
        Get-ContactRecord -ContactId 'contact-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$ContactId
    )

    $record = $null
    $kind = ''
    try {
        $record = Get-MailContact -Identity $ContactId -ErrorAction Stop
        $kind = 'MailContact'
    }
    catch {
        try {
            $record = Get-MailUser -Identity $ContactId -ErrorAction Stop
            $kind = 'MailUser'
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

function ConvertTo-ContactState {
    <#
    .SYNOPSIS
        Shapes one EXO contact record into the before/after comparison state.
    .PARAMETER Record
        The Get-MailContact / Get-MailUser / New-* record.
    .EXAMPLE
        ConvertTo-ContactState -Record $contact
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

    $displayName = $null
    if (([string]$Record.DisplayName).Trim().Length -gt 0) {
        $displayName = [string]$Record.DisplayName
    }

    $externalAddress = $null
    $rawExternal = [string]$Record.ExternalEmailAddress
    if ($rawExternal.Trim().Length -gt 0) {
        $externalAddress = $rawExternal.Trim()
    }

    $type = 'mailContact'
    if ([string]$Record.RecipientTypeDetails -eq 'MailUser') {
        $type = 'mailUser'
    }

    return [pscustomobject]@{
        id              = $id
        displayName     = $displayName
        externalAddress = $externalAddress
        type            = $type
        hiddenFromGal   = ($Record.HiddenFromAddressListsEnabled -eq $true)
    }
}

function Test-ContactFlag {
    <#
    .SYNOPSIS
        Interprets the tri-state HiddenFromGal parameter as a boolean.
    .DESCRIPTION
        $HiddenFromGal is [object] so edit can distinguish "not provided"
        ($null: keep the current value) from an explicit $false. Returns
        $false when the flag was not supplied.
    .PARAMETER Value
        The HiddenFromGal parameter value.
    .EXAMPLE
        Test-ContactFlag -Value $HiddenFromGal
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

function Invoke-ContactAction {
    <#
    .SYNOPSIS
        Executes one contact write action live against Exchange Online.
    .DESCRIPTION
        Dispatches create, edit, hideFromGal, or delete. -DryRun returns the
        intended change with no EXO write and no audit. Delete requires
        -Confirmed. Returns a planned/failed result for dry runs and missing
        contacts, and a plan/result/auditEvent record for applies. Apply
        failures are returned, not thrown; only unknown actions, missing
        inputs, and missing confirmation throw.
    .PARAMETER TenantId
        Tenant the contact belongs to. Carried through to the result envelope.
    .PARAMETER ContactId
        The target contact id. Required for edit, hideFromGal, and delete.
    .PARAMETER Action
        One of the Get-ContactActions names.
    .PARAMETER DisplayName
        Display name for create; new display name for edit.
    .PARAMETER ExternalAddress
        External email address for create; new external address for edit.
    .PARAMETER Type
        Contact type for create: mailContact (default) or mailUser.
    .PARAMETER HiddenFromGal
        Hidden-from-GAL flag for create and edit. Omit ($null) to keep the
        current value on edit.
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
        Invoke-ContactAction -TenantId 'tenant-a' -Action 'hideFromGal' -ContactId 'contact-1'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [string]$Action,

        [Parameter()]
        [string]$ContactId = '',

        [Parameter()]
        [string]$DisplayName = '',

        [Parameter()]
        [string]$ExternalAddress = '',

        [Parameter()]
        [ValidateSet('mailContact', 'mailUser')]
        [string]$Type = 'mailContact',

        [Parameter()]
        [object]$HiddenFromGal = $null,

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

    $known = Get-ContactActions
    if (-not $known.Contains($Action)) {
        throw "contacts.unknown_action: unknown contact action '$Action'; expected one of: $($known -join ', ')"
    }
    if (-not $DryRun -and (Get-ContactActionConfirmation).Contains($Action) -and -not $Confirmed) {
        throw "contacts.confirm_required: action '$Action' requires explicit confirmation"
    }

    $before = $null
    $after = $null
    $diff = [System.Collections.Generic.List[string]]::new()
    $existing = $null

    if ($Action -in @('edit', 'hideFromGal', 'delete')) {
        if ([string]::IsNullOrWhiteSpace($ContactId)) {
            throw "contacts.validation_failed: contactId is required for $Action"
        }
        $existing = Get-ContactRecord -ContactId $ContactId
        if ($null -eq $existing) {
            return [pscustomobject]@{
                contactId = $ContactId
                action    = $Action
                status    = 'failed'
                before    = $null
                after     = $null
                error     = "contact '$ContactId' was not found"
            }
        }
        $before = ConvertTo-ContactState -Record $existing.Record
    }

    switch ($Action) {
        'create' {
            if ([string]::IsNullOrWhiteSpace($DisplayName)) {
                throw "contacts.validation_failed: displayName is required for create"
            }
            if ([string]::IsNullOrWhiteSpace($ExternalAddress)) {
                throw "contacts.validation_failed: externalAddress is required for create"
            }
            $after = [pscustomobject]@{
                id              = ''
                displayName     = $DisplayName.Trim()
                externalAddress = $ExternalAddress.Trim()
                type            = $Type
                hiddenFromGal   = (Test-ContactFlag -Value $HiddenFromGal)
            }
            $diff.Add("Create $Type contact '$($DisplayName.Trim())'")
            if (Test-ContactFlag -Value $HiddenFromGal) {
                $diff.Add('Hide from GAL')
            }
        }
        'edit' {
            $newName = if (-not [string]::IsNullOrWhiteSpace($DisplayName)) { $DisplayName.Trim() } else { $before.displayName }
            $newExternal = if (-not [string]::IsNullOrWhiteSpace($ExternalAddress)) { $ExternalAddress.Trim() } else { $before.externalAddress }
            $newHidden = if ($null -ne $HiddenFromGal) { [bool]$HiddenFromGal } else { $before.hiddenFromGal }
            $after = [pscustomobject]@{
                id              = $before.id
                displayName     = $newName
                externalAddress = $newExternal
                type            = $before.type
                hiddenFromGal   = $newHidden
            }
            if ($after.displayName -ne $before.displayName) {
                $diff.Add("Change displayName: '$($before.displayName)' -> '$($after.displayName)'")
            }
            if ($after.externalAddress -ne $before.externalAddress) {
                $diff.Add("Change externalAddress: '$($before.externalAddress)' -> '$($after.externalAddress)'")
            }
            if ($after.hiddenFromGal -ne $before.hiddenFromGal) {
                $diff.Add("Change hiddenFromGal: '$($before.hiddenFromGal)' -> '$($after.hiddenFromGal)'")
            }
        }
        'hideFromGal' {
            $after = [pscustomobject]@{
                id              = $before.id
                displayName     = $before.displayName
                externalAddress = $before.externalAddress
                type            = $before.type
                hiddenFromGal   = $true
            }
            $diff.Add("Hide contact '$($before.displayName)' from the GAL")
        }
        'delete' {
            $diff.Add("Delete contact '$($before.displayName)' ($ContactId)")
        }
    }

    $effectiveContactId = if ($Action -eq 'create') { '' } else { $ContactId }
    $targetName = if ($Action -eq 'create') { $after.displayName } else { $before.displayName }

    $plan = [pscustomobject]@{
        action               = $Action
        contactId            = $effectiveContactId
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
        action        = "contacts.action:$Action"
        contactId     = $effectiveContactId
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
                $hidden = Test-ContactFlag -Value $HiddenFromGal
                if ($Type -eq 'mailUser') {
                    $appliedResult = New-MailUser -Name $DisplayName.Trim() -DisplayName $DisplayName.Trim() -ExternalEmailAddress $ExternalAddress.Trim() -HiddenFromAddressListsEnabled $hidden
                }
                else {
                    $appliedResult = New-MailContact -Name $DisplayName.Trim() -DisplayName $DisplayName.Trim() -ExternalEmailAddress $ExternalAddress.Trim() -HiddenFromAddressListsEnabled $hidden
                }
                $newState = ConvertTo-ContactState -Record $appliedResult
                $after = $newState
                $effectiveContactId = $newState.id
                $auditEvent['contactId'] = $newState.id
            }
            'edit' {
                $setParams = @{
                    Identity = $ContactId
                }
                if (-not [string]::IsNullOrWhiteSpace($DisplayName)) { $setParams['DisplayName'] = $DisplayName.Trim() }
                if (-not [string]::IsNullOrWhiteSpace($ExternalAddress)) { $setParams['ExternalEmailAddress'] = $ExternalAddress.Trim() }
                if ($null -ne $HiddenFromGal) { $setParams['HiddenFromAddressListsEnabled'] = [bool]$HiddenFromGal }
                if ($existing.Kind -eq 'MailUser') {
                    $appliedResult = Set-MailUser @setParams
                }
                else {
                    $appliedResult = Set-MailContact @setParams
                }
                $reread = Get-ContactRecord -ContactId $ContactId
                if ($null -ne $reread) {
                    $after = ConvertTo-ContactState -Record $reread.Record
                }
            }
            'hideFromGal' {
                if ($existing.Kind -eq 'MailUser') {
                    $appliedResult = Set-MailUser -Identity $ContactId -HiddenFromAddressListsEnabled $true
                }
                else {
                    $appliedResult = Set-MailContact -Identity $ContactId -HiddenFromAddressListsEnabled $true
                }
                $reread = Get-ContactRecord -ContactId $ContactId
                if ($null -ne $reread) {
                    $after = ConvertTo-ContactState -Record $reread.Record
                }
            }
            'delete' {
                if ($existing.Kind -eq 'MailUser') {
                    $appliedResult = Remove-MailUser -Identity $ContactId -Confirm:$false
                }
                else {
                    $appliedResult = Remove-MailContact -Identity $ContactId -Confirm:$false
                }
                $appliedResult = @{ deleted = $true; id = $ContactId }
                $after = $null
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
            contactId = $effectiveContactId
            action    = $Action
            status    = 'failed'
            before    = $before
            after     = $null
            error     = $message
        }
    }
}

function Read-ContactActionJob {
    <#
    .SYNOPSIS
        Reads a contacts job envelope file into Invoke-ContactAction parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        contact id, action, and write fields. The envelope carries references
        only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-ContactActionJob -Path './run/contact-action-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Contact action job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Contact action job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Contact action job is missing required field: tenantId'
    }

    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $action = [string]$payload['action']
    if ([string]::IsNullOrWhiteSpace($action)) {
        throw 'Contact action job is missing required field: payload.action'
    }

    $hidden = $null
    if ($null -ne $payload['hiddenFromGal']) {
        $hidden = [bool]$payload['hiddenFromGal']
    }

    return @{
        TenantId        = $tenantId
        ContactId       = [string]$payload['contactId']
        Action          = $action
        DisplayName     = [string]$payload['displayName']
        ExternalAddress = [string]$payload['externalAddress']
        Type            = $(if ([string]::IsNullOrWhiteSpace([string]$payload['type'])) { 'mailContact' } else { [string]$payload['type'] })
        HiddenFromGal   = $hidden
        DryRun          = $payload['dryRun'] -eq $true
        Confirmed       = $payload['confirm'] -eq $true
        Actor           = [string]$payload['actor']
        CorrelationId   = [string]$job['correlationId']
    }
}
