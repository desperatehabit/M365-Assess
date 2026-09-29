# Invoke-DomainAction.ps1 — EPIC-034 domain management worker (SPEC §3.1, §4.1, §6, §7, §8; T-0663).
#
# Executes one domain action live against Graph with Domain.ReadWrite.All:
# add, verify, remove, and set-default. Add returns the DNS verification
# records (TXT/MX) so the UI can present the publish steps; the domain stays
# unverified until verify succeeds. Every non-dry-run outcome (applied or
# failed) writes one AuditEvent through -WriteAudit and carries it on the
# result for the BFF to record. -DryRun reports the intended change with no
# Graph write and no audit; apply requires -Confirmed (re-checked here so a
# job that skips confirmation cannot write). Unknown action names are refused
# with a structured error, never passed through. No public DNS record is
# written (SPEC §8): verification records are returned, never published. The
# Graph session is connected by the supervisor after materializing the tenant
# credential in-process; this file never touches secrets.

function Get-DomainActions {
    <#
    .SYNOPSIS
        Returns the domain action set this worker dispatches.
    .DESCRIPTION
        The single source of truth for valid action names. Anything else is
        refused with domains.unknown_action.
    .EXAMPLE
        Get-DomainActions
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param()

    return @('add', 'verify', 'remove', 'setDefault')
}

function Get-DomainState {
    <#
    .SYNOPSIS
        Reads the current domain state for before/after capture.
    .DESCRIPTION
        GETs the live domain and shapes the comparison fields. A missing
        domain returns null so the caller can fail with a clear code.
    .PARAMETER Domain
        The domain name.
    .EXAMPLE
        Get-DomainState -Domain 'contoso.com'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Domain
    )

    try {
        $domain = Invoke-MgGraphRequest -Method GET -Uri "/v1.0/domains/$Domain"
        if ($null -eq $domain) {
            return $null
        }
        return [pscustomobject]@{
            id         = [string]$domain.id
            isVerified = $domain.isVerified -eq $true
            isDefault  = $domain.isDefault -eq $true
        }
    }
    catch {
        return $null
    }
}

function New-DomainActionAudit {
    <#
    .SYNOPSIS
        Shapes one domain-action AuditEvent.
    .DESCRIPTION
        The event shape the BFF audit sink persists: tenant, action, target,
        before/after, result, actor, reason, and correlation id.
    .PARAMETER TenantId
        Tenant the domain belongs to.
    .PARAMETER Domain
        The domain name.
    .PARAMETER Action
        add, verify, remove, or setDefault.
    .PARAMETER Result
        success or failure.
    .PARAMETER Error
        Failure message; null on success.
    .PARAMETER Before
        State before the write, or null when there was none.
    .PARAMETER After
        State after the write, or null when the domain is gone.
    .PARAMETER Actor
        Caller identity recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER Reason
        Caller-supplied reason recorded on the audit event.
    .EXAMPLE
        New-DomainActionAudit -TenantId 'tenant-a' -Domain 'contoso.com' -Action 'add' -Result 'success'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Domain,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Action,

        [Parameter(Mandatory)]
        [ValidateSet('success', 'failure')]
        [string]$Result,

        [Parameter()]
        [AllowNull()]
        [string]$Error = $null,

        [Parameter()]
        $Before = $null,

        [Parameter()]
        $After = $null,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [string]$Reason = ''
    )

    return [pscustomobject]@{
        tenantId      = $TenantId
        action        = "domains.action:$Action"
        targetType    = 'domain'
        targetId      = $Domain
        result        = $Result
        error         = $Error
        before        = $Before
        after         = $After
        actor         = $Actor
        reason        = $Reason
        correlationId = $CorrelationId
        timestamp     = [DateTime]::UtcNow.ToString('o')
    }
}

function New-DomainActionResult {
    <#
    .SYNOPSIS
        Shapes the domain-action result envelope.
    .DESCRIPTION
        One shape for every action outcome so the entrypoint serializes a
        consistent contract: tenant, domain, action, status, the add-only
        verification records, a structured failure code, and the audit event
        the BFF records.
    .PARAMETER TenantId
        Tenant the domain belongs to.
    .PARAMETER Domain
        The domain name.
    .PARAMETER Action
        add, verify, remove, or setDefault.
    .PARAMETER Status
        applied, planned, or failed.
    .PARAMETER VerificationRecords
        The DNS records Graph returned for add; null for every other action.
    .PARAMETER Code
        Structured failure code; null unless the action failed.
    .PARAMETER Error
        Failure message; null unless the action failed.
    .PARAMETER AuditEvent
        The AuditEvent for a non-dry-run outcome; null for a plan.
    .EXAMPLE
        New-DomainActionResult -TenantId 'tenant-a' -Domain 'contoso.com' -Action 'add' -Status 'applied'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Domain,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Action,

        [Parameter(Mandatory)]
        [ValidateSet('applied', 'planned', 'failed')]
        [string]$Status,

        [Parameter()]
        $VerificationRecords = $null,

        [Parameter()]
        [string]$Code = $null,

        [Parameter()]
        [string]$Error = $null,

        [Parameter()]
        $AuditEvent = $null
    )

    return [pscustomobject]@{
        tenantId            = $TenantId
        domain              = $Domain
        action              = $Action
        status              = $Status
        verificationRecords = $VerificationRecords
        code                = $Code
        error               = $Error
        auditEvent          = $AuditEvent
    }
}

function Add-Domain {
    <#
    .SYNOPSIS
        Adds a domain to the tenant and returns its DNS verification records.
    .DESCRIPTION
        POSTs the domain to Graph and returns the verification records (TXT/MX)
        so the UI can present the publish steps; the domain is left unverified
        until Verify-Domain succeeds. An existing domain is refused with code
        domain_already_exists and no POST is issued. -DryRun reports the
        intended add with no Graph write. Apply requires -Confirmed.
    .PARAMETER TenantId
        Tenant the domain is added to. Carried through to the result envelope.
    .PARAMETER Domain
        The domain name to add.
    .PARAMETER DryRun
        Report the intended add without writing.
    .PARAMETER Confirmed
        Explicit confirmation for this tenant write.
    .PARAMETER Actor
        Caller identity recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER Reason
        Caller-supplied reason recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Add-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Domain,

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [switch]$Confirmed,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [string]$Reason = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    if (-not $DryRun -and -not $Confirmed) {
        throw 'domains.confirm_required: adding a domain requires confirmation'
    }

    if ($DryRun) {
        return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'add' -Status 'planned'
    }

    $existing = Get-DomainState -Domain $Domain
    if ($null -ne $existing) {
        $audit = New-DomainActionAudit -TenantId $TenantId -Domain $Domain -Action 'add' -Result 'failure' `
            -Error "domain '$Domain' already exists" -Before $existing -After $null -Actor $Actor `
            -CorrelationId $CorrelationId -Reason $Reason
        $null = & $WriteAudit $audit
        return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'add' -Status 'failed' `
            -Code 'domain_already_exists' -Error "domain '$Domain' already exists" -AuditEvent $audit
    }

    try {
        $body = @{ id = $Domain } | ConvertTo-Json -Depth 2 -Compress
        $response = Invoke-MgGraphRequest -Method POST -Uri '/v1.0/domains' -Body $body
    }
    catch {
        $message = $_.Exception.Message
        $audit = New-DomainActionAudit -TenantId $TenantId -Domain $Domain -Action 'add' -Result 'failure' `
            -Error $message -Before $null -After $null -Actor $Actor -CorrelationId $CorrelationId -Reason $Reason
        $null = & $WriteAudit $audit
        return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'add' -Status 'failed' `
            -Error $message -AuditEvent $audit
    }

    $records = @()
    if ($null -ne $response.verificationRecords) {
        $records = @($response.verificationRecords)
    }
    $after = [pscustomobject]@{
        id                 = [string]$response.id
        isVerified         = $response.isVerified -eq $true
        isDefault          = $response.isDefault -eq $true
        verificationRecords = $records
    }
    $audit = New-DomainActionAudit -TenantId $TenantId -Domain $Domain -Action 'add' -Result 'success' `
        -Before $null -After $after -Actor $Actor -CorrelationId $CorrelationId -Reason $Reason
    $null = & $WriteAudit $audit
    return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'add' -Status 'applied' `
        -VerificationRecords $records -AuditEvent $audit
}

function Verify-Domain {
    <#
    .SYNOPSIS
        Triggers Graph verification for an unverified domain.
    .DESCRIPTION
        POSTs the verify action for the domain. A missing domain is refused
        with code domain_not_found and no POST is issued. -DryRun reports the
        intended verify with no Graph write. Apply requires -Confirmed.
    .PARAMETER TenantId
        Tenant the domain belongs to. Carried through to the result envelope.
    .PARAMETER Domain
        The domain name to verify.
    .PARAMETER DryRun
        Report the intended verify without writing.
    .PARAMETER Confirmed
        Explicit confirmation for this tenant write.
    .PARAMETER Actor
        Caller identity recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER Reason
        Caller-supplied reason recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Verify-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Domain,

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [switch]$Confirmed,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [string]$Reason = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    if (-not $DryRun -and -not $Confirmed) {
        throw 'domains.confirm_required: verifying a domain requires confirmation'
    }

    if ($DryRun) {
        return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'verify' -Status 'planned'
    }

    $before = Get-DomainState -Domain $Domain
    if ($null -eq $before) {
        $audit = New-DomainActionAudit -TenantId $TenantId -Domain $Domain -Action 'verify' -Result 'failure' `
            -Error "domain '$Domain' was not found" -Before $null -After $null -Actor $Actor `
            -CorrelationId $CorrelationId -Reason $Reason
        $null = & $WriteAudit $audit
        return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'verify' -Status 'failed' `
            -Code 'domain_not_found' -Error "domain '$Domain' was not found" -AuditEvent $audit
    }

    try {
        $response = Invoke-MgGraphRequest -Method POST -Uri "/v1.0/domains/$Domain/verify"
    }
    catch {
        $message = $_.Exception.Message
        $audit = New-DomainActionAudit -TenantId $TenantId -Domain $Domain -Action 'verify' -Result 'failure' `
            -Error $message -Before $before -After $null -Actor $Actor -CorrelationId $CorrelationId -Reason $Reason
        $null = & $WriteAudit $audit
        return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'verify' -Status 'failed' `
            -Error $message -AuditEvent $audit
    }

    $after = [pscustomobject]@{
        id         = [string]$response.id
        isVerified = $response.isVerified -eq $true
        isDefault  = $response.isDefault -eq $true
    }
    $audit = New-DomainActionAudit -TenantId $TenantId -Domain $Domain -Action 'verify' -Result 'success' `
        -Before $before -After $after -Actor $Actor -CorrelationId $CorrelationId -Reason $Reason
    $null = & $WriteAudit $audit
    return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'verify' -Status 'applied' -AuditEvent $audit
}

function Remove-Domain {
    <#
    .SYNOPSIS
        Removes a domain from the tenant.
    .DESCRIPTION
        DELETEs the domain from Graph. A missing domain is refused with code
        domain_not_found and no DELETE is issued. -DryRun reports the intended
        removal with no Graph write. Apply requires -Confirmed.
    .PARAMETER TenantId
        Tenant the domain belongs to. Carried through to the result envelope.
    .PARAMETER Domain
        The domain name to remove.
    .PARAMETER DryRun
        Report the intended removal without writing.
    .PARAMETER Confirmed
        Explicit confirmation for this tenant write.
    .PARAMETER Actor
        Caller identity recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER Reason
        Caller-supplied reason recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Remove-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Domain,

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [switch]$Confirmed,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [string]$Reason = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    if (-not $DryRun -and -not $Confirmed) {
        throw 'domains.confirm_required: removing a domain requires confirmation'
    }

    if ($DryRun) {
        return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'remove' -Status 'planned'
    }

    $before = Get-DomainState -Domain $Domain
    if ($null -eq $before) {
        $audit = New-DomainActionAudit -TenantId $TenantId -Domain $Domain -Action 'remove' -Result 'failure' `
            -Error "domain '$Domain' was not found" -Before $null -After $null -Actor $Actor `
            -CorrelationId $CorrelationId -Reason $Reason
        $null = & $WriteAudit $audit
        return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'remove' -Status 'failed' `
            -Code 'domain_not_found' -Error "domain '$Domain' was not found" -AuditEvent $audit
    }

    try {
        $null = Invoke-MgGraphRequest -Method DELETE -Uri "/v1.0/domains/$Domain"
    }
    catch {
        $message = $_.Exception.Message
        $audit = New-DomainActionAudit -TenantId $TenantId -Domain $Domain -Action 'remove' -Result 'failure' `
            -Error $message -Before $before -After $null -Actor $Actor -CorrelationId $CorrelationId -Reason $Reason
        $null = & $WriteAudit $audit
        return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'remove' -Status 'failed' `
            -Error $message -AuditEvent $audit
    }

    $audit = New-DomainActionAudit -TenantId $TenantId -Domain $Domain -Action 'remove' -Result 'success' `
        -Before $before -After $null -Actor $Actor -CorrelationId $CorrelationId -Reason $Reason
    $null = & $WriteAudit $audit
    return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'remove' -Status 'applied' -AuditEvent $audit
}

function Set-DomainDefault {
    <#
    .SYNOPSIS
        Sets the domain as the tenant's default domain.
    .DESCRIPTION
        PATCHes the domain with isDefault=true. A missing domain is refused
        with code domain_not_found and no PATCH is issued. -DryRun reports the
        intended change with no Graph write. Apply requires -Confirmed.
    .PARAMETER TenantId
        Tenant the domain belongs to. Carried through to the result envelope.
    .PARAMETER Domain
        The domain name to make default.
    .PARAMETER DryRun
        Report the intended change without writing.
    .PARAMETER Confirmed
        Explicit confirmation for this tenant write.
    .PARAMETER Actor
        Caller identity recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER Reason
        Caller-supplied reason recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Set-DomainDefault -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Domain,

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [switch]$Confirmed,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [string]$Reason = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    if (-not $DryRun -and -not $Confirmed) {
        throw 'domains.confirm_required: setting a default domain requires confirmation'
    }

    if ($DryRun) {
        return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'setDefault' -Status 'planned'
    }

    $before = Get-DomainState -Domain $Domain
    if ($null -eq $before) {
        $audit = New-DomainActionAudit -TenantId $TenantId -Domain $Domain -Action 'setDefault' -Result 'failure' `
            -Error "domain '$Domain' was not found" -Before $null -After $null -Actor $Actor `
            -CorrelationId $CorrelationId -Reason $Reason
        $null = & $WriteAudit $audit
        return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'setDefault' -Status 'failed' `
            -Code 'domain_not_found' -Error "domain '$Domain' was not found" -AuditEvent $audit
    }

    try {
        $body = @{ isDefault = $true } | ConvertTo-Json -Depth 2 -Compress
        $response = Invoke-MgGraphRequest -Method PATCH -Uri "/v1.0/domains/$Domain" -Body $body
    }
    catch {
        $message = $_.Exception.Message
        $audit = New-DomainActionAudit -TenantId $TenantId -Domain $Domain -Action 'setDefault' -Result 'failure' `
            -Error $message -Before $before -After $null -Actor $Actor -CorrelationId $CorrelationId -Reason $Reason
        $null = & $WriteAudit $audit
        return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'setDefault' -Status 'failed' `
            -Error $message -AuditEvent $audit
    }

    $after = [pscustomobject]@{
        id         = [string]$response.id
        isVerified = $response.isVerified -eq $true
        isDefault  = $response.isDefault -eq $true
    }
    $audit = New-DomainActionAudit -TenantId $TenantId -Domain $Domain -Action 'setDefault' -Result 'success' `
        -Before $before -After $after -Actor $Actor -CorrelationId $CorrelationId -Reason $Reason
    $null = & $WriteAudit $audit
    return New-DomainActionResult -TenantId $TenantId -Domain $Domain -Action 'setDefault' -Status 'applied' -AuditEvent $audit
}

function Invoke-DomainAction {
    <#
    .SYNOPSIS
        Dispatches one domain action (add, verify, remove, or setDefault).
    .DESCRIPTION
        The single job surface for the entrypoint: validates the action name
        against Get-DomainActions and delegates. Unknown action names throw
        domains.unknown_action and issue no Graph call.
    .PARAMETER TenantId
        Tenant the domain belongs to.
    .PARAMETER Domain
        The domain name the action targets.
    .PARAMETER Action
        add, verify, remove, or setDefault.
    .PARAMETER DryRun
        Report the intended change without writing.
    .PARAMETER Confirmed
        Explicit confirmation for the tenant write.
    .PARAMETER Actor
        Caller identity recorded on the audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on the audit event.
    .PARAMETER Reason
        Caller-supplied reason recorded on the audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        Invoke-DomainAction -TenantId 'tenant-a' -Domain 'contoso.com' -Action 'add' -Confirmed
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Domain,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Action,

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [switch]$Confirmed,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [string]$Reason = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    $base = @{
        TenantId = $TenantId
        Domain   = $Domain
    }
    if ($DryRun) {
        $base['DryRun'] = $true
    }
    if ($Confirmed) {
        $base['Confirmed'] = $true
    }
    if ($Actor) {
        $base['Actor'] = $Actor
    }
    if ($CorrelationId) {
        $base['CorrelationId'] = $CorrelationId
    }
    if ($Reason) {
        $base['Reason'] = $Reason
    }
    $base['WriteAudit'] = $WriteAudit

    switch ($Action) {
        'add' {
            return Add-Domain @base
        }
        'verify' {
            return Verify-Domain @base
        }
        'remove' {
            return Remove-Domain @base
        }
        'setDefault' {
            return Set-DomainDefault @base
        }
        default {
            throw "domains.unknown_action: unknown domain action '$Action'; expected one of: $(Get-DomainActions -join ', ')"
        }
    }
    return $null
}

function Read-DomainActionJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into Invoke-DomainAction parameters.
    .DESCRIPTION
        Validates the envelope schema version, tenant, domain, and action,
        then merges the dry-run and confirmation flags. The envelope carries
        references only; secrets are never present and never needed here.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-DomainActionJob -Path './run/domain-action-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Domain action job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Domain action job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Domain action job is missing required field: tenantId'
    }
    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $domain = [string]$payload['domain']
    if ([string]::IsNullOrWhiteSpace($domain)) {
        throw 'Domain action job is missing required field: payload.domain'
    }
    $action = [string]$payload['action']
    if ((Get-DomainActions) -notcontains $action) {
        throw "Domain action job has unsupported action: $action"
    }

    return @{
        TenantId      = $tenantId
        Domain        = $domain
        Action        = $action
        DryRun        = [bool]$payload['dryRun']
        Confirmed     = [bool]$payload['confirmed']
        Actor         = [string]$payload['actor']
        Reason        = [string]$payload['reason']
        CorrelationId = [string]$job['correlationId']
    }
}
