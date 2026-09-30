# Set-Connector.ps1 — EPIC-021 connector add/edit/enable/disable/remove worker
# (SPEC §2 US-3, §3.2, §4.1, §4.3, §6, §8, §11.2; T-0404).
#
# Covers create, edit, enable, disable, and delete of Exchange Online inbound
# and outbound connectors (New-/Set-/Remove-InboundConnector and -OutboundConnector).
# Supports DryRun (plan preview mode returning a diff without mutating).
#
# Gating (EPIC-006 contract, T-0107): connector writes are not registry CheckId
# commands, so they cannot travel the CheckId-bound executor path. They follow
# the same contract instead — the BFF confirms the plan before dispatch (dryRun
# plans only), -DryRun reports the intended change without writing, -Confirmed
# is re-checked here so a job that skips confirmation cannot apply, every
# apply captures before/after, and every apply emits one audit record.
# Disabling or deleting a connector that carries production mail flow is
# security-sensitive (SPEC §4.3): the plan carries the warning with
# requiresConfirmation so the warning surfaces before apply.
#
# Secrets (SPEC §11.2): a connector secret (e.g. a partner TLS certificate)
# travels by reference only. The job envelope and every input carry secretRef;
# the material is resolved from the credential store inside this child process
# (T-0011) and is never emitted in a plan, result, or audit record.

function Test-ConnectorInput {
    <#
    .SYNOPSIS
        Validates one planned connector create, edit, enable, disable, or delete.
    .DESCRIPTION
        Mirrors the BFF route validation so the worker refuses the same rows
        the BFF would: create needs a name and type; edit, enable, disable, and
        delete need the connector id; edit needs at least one field to change.
        Returns the error list; empty is valid.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('create', 'edit', 'enable', 'disable', 'delete')]
        [string]$Action,

        [Parameter()]
        [string]$ConnectorId = '',

        [Parameter()]
        [string]$Name = '',

        [Parameter()]
        [ValidateSet('', 'inbound', 'outbound')]
        [string]$Type = '',

        [Parameter()]
        [Nullable[bool]]$Enabled = $null,

        [Parameter()]
        [string]$SenderDomains = '',

        [Parameter()]
        [string]$RecipientDomains = ''
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    if ($Action -eq 'create') {
        if ([string]::IsNullOrWhiteSpace($Name)) {
            $errors.Add('name is required for create')
        }
        if ($Type -ne 'inbound' -and $Type -ne 'outbound') {
            $errors.Add("type must be inbound or outbound for create")
        }
    }
    else {
        if ([string]::IsNullOrWhiteSpace($ConnectorId)) {
            $errors.Add("connectorId is required for $Action")
        }
    }
    if ($Action -eq 'edit') {
        $hasChange = (-not [string]::IsNullOrWhiteSpace($Name)) -or
            ($null -ne $Enabled) -or
            (-not [string]::IsNullOrWhiteSpace($SenderDomains)) -or
            (-not [string]::IsNullOrWhiteSpace($RecipientDomains))
        if (-not $hasChange) {
            $errors.Add('at least one connector field must be supplied for edit')
        }
    }
    return @($errors)
}

function Test-ConnectorChangeSensitive {
    <#
    .SYNOPSIS
        Classifies a connector change as mail-flow-sensitive (SPEC §4.3).
    .DESCRIPTION
        Disabling or deleting a connector that is currently enabled carries
        production mail flow, so the change forces the warning path with
        requiresConfirmation so the operator reviews it before apply. An edit
        that flips enabled from true to false is the same class of change.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('create', 'edit', 'enable', 'disable', 'delete')]
        [string]$Action,

        [Parameter()]
        [hashtable]$Before,

        [Parameter()]
        [hashtable]$After
    )

    $warning = 'Disabling this connector affects production mail flow: review the connector before applying. This change is audited with before/after.'
    $sensitive = { param([string]$Reason) return [pscustomobject]@{
        securitySensitive     = $true
        requiresConfirmation  = $true
        warning               = $warning
        reasons               = @($Reason)
    } }.GetNewClosure()

    if ($Action -eq 'disable') {
        if ($null -ne $Before -and $Before['enabled'] -eq $false) {
            return [pscustomobject]@{ securitySensitive = $false; requiresConfirmation = $false; warning = $null; reasons = @() }
        }
        return (& $sensitive 'connector is enabled and carries production mail flow')
    }
    if ($Action -eq 'delete') {
        if ($null -ne $Before -and $Before['enabled'] -eq $false) {
            return [pscustomobject]@{ securitySensitive = $false; requiresConfirmation = $false; warning = $null; reasons = @() }
        }
        return (& $sensitive 'connector is enabled and carries production mail flow')
    }
    if ($Action -eq 'edit') {
        $beforeEnabled = ($null -ne $Before -and $Before['enabled'] -eq $true)
        $afterEnabled = ($null -ne $After -and $After['enabled'] -eq $true)
        if ($beforeEnabled -and -not $afterEnabled) {
            return (& $sensitive 'edit disables a connector that carries production mail flow')
        }
    }
    return [pscustomobject]@{ securitySensitive = $false; requiresConfirmation = $false; warning = $null; reasons = @() }
}

function ConvertTo-ConnectorSnapshot {
    <#
    .SYNOPSIS
        Normalizes an EXO inbound or outbound connector to the before/after snapshot shape.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [object]$Connector
    )

    $type = 'inbound'
    if ([string]$Connector.ConnectorType -eq 'Outbound') {
        $type = 'outbound'
    }

    $senderDomains = @()
    if ($null -ne $Connector.SenderDomains) {
        $senderDomains = @($Connector.SenderDomains | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().Length -gt 0 })
    }
    $recipientDomains = @()
    if ($null -ne $Connector.RecipientDomains) {
        $recipientDomains = @($Connector.RecipientDomains | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().Length -gt 0 })
    }

    $lastModified = $null
    foreach ($field in @('WhenChangedUTC', 'WhenChanged')) {
        $raw = [string]$Connector.$field
        if ($raw.Trim().Length -gt 0) {
            $lastModified = $raw.Trim()
            break
        }
    }

    return @{
        identity        = [string]$Connector.Identity
        name            = [string]$Connector.Name
        type            = $type
        enabled         = ($Connector.Enabled -eq $true)
        senderDomains   = $senderDomains
        recipientDomains = $recipientDomains
        requireTls      = ($Connector.RequireTls -eq $true)
        secretRef       = $null
        lastModified    = $lastModified
    }
}

function Find-Connector {
    <#
    .SYNOPSIS
        Reads one connector by identity or name across inbound and outbound sets.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$ConnectorId
    )

    $key = $ConnectorId.Trim()
    foreach ($cmdlet in @('Get-InboundConnector', 'Get-OutboundConnector')) {
        $found = & $cmdlet -ErrorAction Stop |
            Where-Object { [string]$_.Identity -eq $key -or [string]$_.Name -eq $key } |
            Select-Object -First 1
        if ($null -ne $found) {
            return $found
        }
    }
    return $null
}

function Read-SetConnectorJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-SetConnector parameters.
    .DESCRIPTION
        Validates the envelope carries a tenant and an action, then returns the
        connector identity, planned values, secret reference, confirmation,
        and dry-run flag. The envelope carries references and planned values
        only; secret material is never present and never needed at rest.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "job envelope not found at '$Path'"
    }

    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if (-not $json.tenantId) {
        throw "job envelope '$Path' is missing mandatory 'tenantId'"
    }
    if (-not $json.action) {
        throw "job envelope '$Path' is missing mandatory 'action'"
    }

    $enabled = $null
    if ($null -ne $json.enabled) {
        $enabled = [bool]$json.enabled
    }

    return @{
        TenantId        = [string]$json.tenantId
        Action          = [string]$json.action
        ConnectorId     = if ($json.connectorId) { [string]$json.connectorId } else { '' }
        Name            = if ($json.name) { [string]$json.name } else { '' }
        Type            = if ($json.type) { [string]$json.type } else { '' }
        Enabled         = $enabled
        SenderDomains   = if ($json.senderDomains) { [string]$json.senderDomains } else { '' }
        RecipientDomains = if ($json.recipientDomains) { [string]$json.recipientDomains } else { '' }
        RequireTls      = if ($null -ne $json.requireTls) { [bool]$json.requireTls } else { $null }
        SecretRef       = if ($json.secretRef) { [string]$json.secretRef } else { '' }
        Confirmed       = [bool]($json.confirmed -eq $true)
        DryRun          = [bool]($json.dryRun -eq $true)
    }
}

function Invoke-SetConnector {
    <#
    .SYNOPSIS
        Executes or previews connector create/edit/enable/disable/delete with before/after capture.
    .DESCRIPTION
        -DryRun returns the plan with no EXO write. Without -DryRun, -Confirmed
        is required or the apply is refused. Edit and delete read the current
        connector first for the before snapshot. Every apply emits one
        auditEvent with before/after for the app audit sink. A connector
        secret is resolved from the credential store inside this child process
        (T-0011) and never emitted in the plan, result, or audit record.
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
        [string]$ConnectorId = '',

        [Parameter()]
        [string]$Name = '',

        [Parameter()]
        [ValidateSet('', 'inbound', 'outbound')]
        [string]$Type = '',

        [Parameter()]
        [Nullable[bool]]$Enabled = $null,

        [Parameter()]
        [string]$SenderDomains = '',

        [Parameter()]
        [string]$RecipientDomains = '',

        [Parameter()]
        [Nullable[bool]]$RequireTls = $null,

        [Parameter()]
        [string]$SecretRef = '',

        [Parameter()]
        [bool]$DryRun = $false,

        [Parameter()]
        [bool]$Confirmed = $false,

        [Parameter()]
        [scriptblock]$CredentialStore
    )

    $failures = @(Test-ConnectorInput -Action $Action -ConnectorId $ConnectorId -Name $Name -Type $Type -Enabled $Enabled -SenderDomains $SenderDomains -RecipientDomains $RecipientDomains)
    if ($failures.Count -gt 0) {
        throw "ValidationFailed: $($failures -join '; ')"
    }

    $connectorKey = $ConnectorId.Trim()
    $secretMaterial = $null
    if (-not [string]::IsNullOrWhiteSpace($SecretRef)) {
        if ($null -eq $CredentialStore) {
            throw "Connector secret '$SecretRef' requires secret material but no credential store was provided (code: worker.credential_store_required)."
        }
        $secretMaterial = & $CredentialStore $SecretRef
        if ($null -eq $secretMaterial -or ($secretMaterial -is [string] -and -not $secretMaterial)) {
            throw "Connector secret '$SecretRef' could not be resolved from the credential store (code: worker.credential_not_found)."
        }
    }

    $before = $null
    $after = $null
    $targetName = ''
    $diff = [System.Collections.Generic.List[string]]::new()

    if ($Action -eq 'create') {
        $targetName = $Name.Trim()
        $after = @{
            identity         = $null
            name             = $targetName
            type             = $Type
            enabled          = if ($null -ne $Enabled) { [bool]$Enabled } else { $true }
            senderDomains    = @($SenderDomains.Trim() -split '[,\s]+' | Where-Object { $_.Trim().Length -gt 0 })
            recipientDomains = @($RecipientDomains.Trim() -split '[,\s]+' | Where-Object { $_.Trim().Length -gt 0 })
            requireTls       = ($null -ne $RequireTls -and $RequireTls -eq $true)
            secretRef        = if ([string]::IsNullOrWhiteSpace($SecretRef)) { $null } else { $SecretRef.Trim() }
            lastModified     = $null
        }
        $diff.Add("Create $Type connector '$targetName'")
    }
    else {
        $existing = Find-Connector -ConnectorId $connectorKey
        if ($null -eq $existing) {
            throw "NotFound: Connector '$connectorKey' not found"
        }
        $before = ConvertTo-ConnectorSnapshot -Connector $existing
        $targetName = [string]$before['name']
        if ([string]::IsNullOrWhiteSpace($targetName)) {
            $targetName = $connectorKey
        }

        if ($Action -eq 'delete') {
            $diff.Add("Remove connector '$targetName' ($connectorKey)")
        }
        else {
            $after = $before.Clone()
            if (-not [string]::IsNullOrWhiteSpace($Name)) {
                $after['name'] = $Name.Trim()
            }
            if ($null -ne $Enabled) {
                $after['enabled'] = [bool]$Enabled
            }
            if (-not [string]::IsNullOrWhiteSpace($SenderDomains)) {
                $after['senderDomains'] = @($SenderDomains.Trim() -split '[,\s]+' | Where-Object { $_.Trim().Length -gt 0 })
            }
            if (-not [string]::IsNullOrWhiteSpace($RecipientDomains)) {
                $after['recipientDomains'] = @($RecipientDomains.Trim() -split '[,\s]+' | Where-Object { $_.Trim().Length -gt 0 })
            }
            if ($null -ne $RequireTls) {
                $after['requireTls'] = [bool]$RequireTls
            }
            if (-not [string]::IsNullOrWhiteSpace($SecretRef)) {
                $after['secretRef'] = $SecretRef.Trim()
            }
            foreach ($field in @('name', 'enabled', 'senderDomains', 'recipientDomains', 'requireTls', 'secretRef')) {
                $beforeText = @($before[$field] | ForEach-Object { [string]$_ }) -join ','
                $afterText = @($after[$field] | ForEach-Object { [string]$_ }) -join ','
                if ($beforeText -ne $afterText) {
                    $diff.Add("Set $field from '$beforeText' to '$afterText' on connector '$targetName' ($connectorKey)")
                }
            }
            if ($diff.Count -eq 0) {
                $diff.Add("Connector '$targetName' ($connectorKey) is already at the requested state; no change applied")
                $guard = Test-ConnectorChangeSensitive -Action $Action -Before $before -After $after
                $plan = [pscustomobject]@{
                    action               = $Action
                    connectorId          = $connectorKey
                    targetName           = $targetName
                    before               = $before
                    after                = $after
                    diff                 = @($diff)
                    valid                = $true
                    dryRun               = $DryRun
                    requiresConfirmation = [bool]$guard.requiresConfirmation
                    securitySensitive    = [bool]$guard.securitySensitive
                    warning              = $guard.warning
                }
                if ($DryRun) {
                    return $plan
                }
                return [pscustomobject]@{
                    plan       = $plan
                    result     = @{ id = $connectorKey; name = $targetName; noop = $true }
                    auditEvent = @{
                        id         = [guid]::NewGuid().ToString()
                        tenantId   = $TenantId
                        action     = "connector.$Action"
                        targetId   = $connectorKey
                        targetName = $targetName
                        timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                        before     = $before
                        after      = $after
                        note       = 'already at the requested state; no change applied'
                    }
                    noop       = $true
                    success    = $true
                }
            }
        }
    }

    $guard = Test-ConnectorChangeSensitive -Action $Action -Before $before -After $after
    $plan = [pscustomobject]@{
        action               = $Action
        connectorId          = $connectorKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $DryRun
        requiresConfirmation = [bool]$guard.requiresConfirmation
        securitySensitive    = [bool]$guard.securitySensitive
        warning              = $guard.warning
    }

    if ($DryRun) {
        return $plan
    }

    if (-not $Confirmed) {
        throw "connector.confirm_required: action '$Action' requires explicit confirmation"
    }

    $appliedResult = $null
    if ($Action -eq 'create') {
        $createParams = @{
            Name = $targetName
        }
        if ($Type -eq 'inbound') {
            if (-not [string]::IsNullOrWhiteSpace($SenderDomains)) {
                $createParams['SenderDomains'] = @($SenderDomains.Trim() -split '[,\s]+' | Where-Object { $_.Trim().Length -gt 0 })
            }
            if ($null -ne $RequireTls) {
                $createParams['RequireTls'] = [bool]$RequireTls
            }
            if ($null -ne $Enabled) {
                $createParams['Enabled'] = [bool]$Enabled
            }
            if ($null -ne $secretMaterial) {
                $createParams['TlsCertificate'] = [string]$secretMaterial
            }
            $created = New-InboundConnector @createParams
        }
        else {
            if (-not [string]::IsNullOrWhiteSpace($RecipientDomains)) {
                $createParams['RecipientDomains'] = @($RecipientDomains.Trim() -split '[,\s]+' | Where-Object { $_.Trim().Length -gt 0 })
            }
            if ($null -ne $RequireTls) {
                $createParams['RequireTls'] = [bool]$RequireTls
            }
            if ($null -ne $Enabled) {
                $createParams['Enabled'] = [bool]$Enabled
            }
            if ($null -ne $secretMaterial) {
                $createParams['TlsCertificate'] = [string]$secretMaterial
            }
            $created = New-OutboundConnector @createParams
        }
        $connectorKey = [string]$created.Identity
        if ([string]::IsNullOrWhiteSpace($connectorKey)) {
            $relisted = Find-Connector -ConnectorId $targetName
            if ($null -ne $relisted) {
                $connectorKey = [string]$relisted.Identity
            }
        }
        $after['identity'] = $connectorKey
        $appliedResult = @{ id = $connectorKey; name = $targetName }
    }
    elseif ($Action -eq 'edit' -or $Action -eq 'enable' -or $Action -eq 'disable') {
        $editParams = @{ Identity = $connectorKey }
        if (-not [string]::IsNullOrWhiteSpace($Name)) {
            $editParams['Name'] = $Name.Trim()
        }
        if ($null -ne $Enabled) {
            $editParams['Enabled'] = [bool]$Enabled
        }
        if (-not [string]::IsNullOrWhiteSpace($SenderDomains)) {
            $editParams['SenderDomains'] = @($SenderDomains.Trim() -split '[,\s]+' | Where-Object { $_.Trim().Length -gt 0 })
        }
        if (-not [string]::IsNullOrWhiteSpace($RecipientDomains)) {
            $editParams['RecipientDomains'] = @($RecipientDomains.Trim() -split '[,\s]+' | Where-Object { $_.Trim().Length -gt 0 })
        }
        if ($null -ne $RequireTls) {
            $editParams['RequireTls'] = [bool]$RequireTls
        }
        if ($null -ne $secretMaterial) {
            $editParams['TlsCertificate'] = [string]$secretMaterial
        }
        $existingType = [string]$before['type']
        if ($existingType -eq 'inbound') {
            $null = Set-InboundConnector @editParams
        }
        else {
            $null = Set-OutboundConnector @editParams
        }
        $refreshed = Find-Connector -ConnectorId $connectorKey
        if ($null -ne $refreshed) {
            $after = ConvertTo-ConnectorSnapshot -Connector $refreshed
            if (-not [string]::IsNullOrWhiteSpace($SecretRef)) {
                $after['secretRef'] = $SecretRef.Trim()
            }
        }
        $appliedResult = @{ id = $connectorKey; name = $targetName }
    }
    else {
        $existingType = [string]$before['type']
        if ($existingType -eq 'inbound') {
            $null = Remove-InboundConnector -Identity $connectorKey -Confirm:$false
        }
        else {
            $null = Remove-OutboundConnector -Identity $connectorKey -Confirm:$false
        }
        $appliedResult = @{ id = $connectorKey; name = $targetName; deleted = $true }
    }

    $plan = [pscustomobject]@{
        action               = $Action
        connectorId          = $connectorKey
        targetName           = $targetName
        before               = $before
        after                = $after
        diff                 = @($diff)
        valid                = $true
        dryRun               = $false
        requiresConfirmation = [bool]$guard.requiresConfirmation
        securitySensitive    = [bool]$guard.securitySensitive
        warning              = $guard.warning
    }

    return [pscustomobject]@{
        plan       = $plan
        result     = $appliedResult
        auditEvent = @{
            id         = [guid]::NewGuid().ToString()
            tenantId   = $TenantId
            action     = "connector.$Action"
            targetId   = $connectorKey
            targetName = $targetName
            timestamp  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            before     = $before
            after      = $after
        }
        success    = $true
    }
}
