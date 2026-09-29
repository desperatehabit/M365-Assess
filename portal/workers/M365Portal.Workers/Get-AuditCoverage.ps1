# Get-AuditCoverage.ps1 — EPIC-032 audit search coverage worker (SPEC §3.3, §4.2, §5, §6, §11.3; T-0624).
#
# Computes a tenant's audit search coverage live: whether unified audit log
# ingestion is enabled (Get-AdminAuditLogConfig on the tenant's Purview session),
# the last audit-search instant from portal search history, and the gaps that
# follow. A tenant with ingestion disabled carries a COMPLIANCE-AUDIT-001 gap
# that references the run-results finding (when the caller supplies one) and
# links to the EPIC-006 audit-enablement remediation. Read-only: only Get-
# cmdlets are issued against the tenant and nothing is written.

$script:AuditCoverageCheckId = 'COMPLIANCE-AUDIT-001'

function Read-AuditCoverageJob {
    <#
    .SYNOPSIS
        Reads the coverage job envelope's tenant and portal-side inputs.
    .DESCRIPTION
        The envelope carries the mandatory tenantId plus the portal-computed
        lastSearchAt (newest saved-search run instant) and an optional run-
        results finding reference for the coverage gap.
    .PARAMETER Path
        Path to the job envelope JSON.
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

    $lastSearchAt = ''
    if ($null -ne $json.lastSearchAt) {
        $value = $json.lastSearchAt
        # ConvertFrom-Json turns ISO date strings into DateTime; round-trip them.
        if ($value -is [datetime]) {
            $lastSearchAt = $value.ToUniversalTime().ToString('o')
        }
        else {
            $lastSearchAt = "$value".Trim()
        }
    }

    return @{
        TenantId     = [string]$json.tenantId
        LastSearchAt = $lastSearchAt
        Finding     = if ($json.finding) { $json.finding } else { $null }
    }
}

function Get-AuditCoverage {
    <#
    .SYNOPSIS
        Computes the tenant's audit search coverage live.
    .DESCRIPTION
        Reads Get-AdminAuditLogConfig on the connected Purview session to decide
        whether unified audit log ingestion is enabled, carries the portal's
        last-search instant through, and compiles the gaps: a tenant with
        ingestion disabled yields one COMPLIANCE-AUDIT-001 gap referencing the
        run-results finding (when supplied) and linking to the EPIC-006
        audit-enablement remediation. Only Get- cmdlets are issued.
    .PARAMETER TenantId
        Tenant the coverage belongs to. Carried through to the result envelope.
    .PARAMETER LastSearchAt
        Newest saved-search run instant from portal search history; empty when none.
    .PARAMETER Finding
        Optional run-results finding reference (id, runId, checkId) the gap links to.
    .EXAMPLE
        PS> Get-AuditCoverage -TenantId 'tenant-a' -LastSearchAt '2026-09-20T10:00:00Z'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$LastSearchAt = '',

        [Parameter()]
        [object]$Finding = $null
    )

    $auditEnabled = $false
    try {
        $auditConfig = Get-AdminAuditLogConfig -ErrorAction Stop
        if ($auditConfig -and $null -ne $auditConfig.UnifiedAuditLogIngestionEnabled) {
            $flag = $auditConfig.UnifiedAuditLogIngestionEnabled
            if ($flag -is [bool]) {
                $auditEnabled = $flag
            }
            else {
                $auditEnabled = ([string]$flag).Trim().Equals('True', [System.StringComparison]::OrdinalIgnoreCase)
            }
        }
    }
    catch {
        throw "Could not read unified audit log configuration for tenant '$TenantId': $_"
    }

    $gaps = @()
    if (-not $auditEnabled) {
        $gap = [ordered]@{
            checkId     = $script:AuditCoverageCheckId
            title       = 'Microsoft 365 audit log search is disabled'
            description = 'Unified audit log ingestion is disabled for this tenant, so audit events are not recorded and audit-log searches return nothing.'
            remediation = 'Enable unified audit log ingestion (EPIC-006): run Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true, or in Microsoft Purview > Audit choose "Start recording user and admin activity".'
            findingId   = $null
            runId       = $null
        }
        if ($Finding) {
            $gap['findingId'] = [string]$Finding.id
            $gap['runId'] = [string]$Finding.runId
        }
        $gaps += [pscustomobject]$gap
    }

    return [pscustomobject]@{
        tenantId     = $TenantId
        auditEnabled = $auditEnabled
        lastSearchAt = if ($LastSearchAt.Trim().Length -gt 0) { $LastSearchAt } else { $null }
        gaps         = @($gaps)
    }
}

function Connect-WorkerPurview {
    <#
    .SYNOPSIS
        Signs a feature worker in to its tenant's Purview (Security & Compliance) endpoint.
    .DESCRIPTION
        The T-0582 Purview session seam: resolves the job file's credential block in this
        child process, connects app-only to Purview through the module's Connect-Service,
        and returns a session that Disconnect-WorkerPurview closes. Purview and Exchange
        Online share the ExchangeOnlineManagement module and are mutually exclusive
        per-tenant (EPIC-001 T-0006), so this connects Purview alone. Errors are coded
        (worker.credential_*, worker.connect_failed) and scrubbed of secret material.
    .PARAMETER JobFile
        Path to the job envelope JSON (tenantId plus credential { credentialRef, record }).
    .PARAMETER CredentialStore
        Secret lookup for client-secret and PFX credentials (T-0827). Certificate-thumbprint
        credentials need none.
    .PARAMETER ConnectScript
        Path to Connect-Service.ps1; defaults to the module's copy. Tests pass a stub.
    .EXAMPLE
        $session = Connect-WorkerPurview -JobFile $JobFile
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$JobFile,

        [scriptblock]$CredentialStore,

        [string]$ConnectScript = ''
    )

    $block = Read-WorkerCredentialBlock -JobFile $JobFile
    $resolveParams = @{
        TenantId         = $block.TenantId
        CredentialRef    = $block.CredentialRef
        CredentialRecord = $block.Record
        Sections         = @('Security')
    }
    if ($CredentialStore) { $resolveParams['CredentialStore'] = $CredentialStore }
    $auth = Resolve-TenantCredential @resolveParams

    if (-not $ConnectScript) { $ConnectScript = Get-DefaultConnectServiceScript }
    if (-not (Test-Path -LiteralPath $ConnectScript -PathType Leaf)) {
        throw "Connect-Service script not found at '$ConnectScript' (code: worker.connect_failed)"
    }

    $connectParams = @{ Service = 'Purview'; TenantId = $block.TenantId }
    foreach ($key in @('ClientId', 'CertificateThumbprint', 'Certificate', 'CertificatePath', 'CertificatePassword', 'M365Environment')) {
        if ($null -ne $auth[$key] -and [string]$auth[$key] -ne '') { $connectParams[$key] = $auth[$key] }
    }
    try {
        $connected = & $ConnectScript @connectParams
        if ($connected -eq $false) { throw "Connect-Service returned false" }
    }
    catch {
        $message = Protect-WorkerSecret -Message $_.Exception.Message -Secrets @($auth.ClientSecret, $auth.CertificatePassword)
        throw "Failed to connect Purview for tenant '$($block.TenantId)' (code: worker.connect_failed): $message"
    }

    return [pscustomobject]@{
        TenantId = $block.TenantId
        Services = [System.Collections.Generic.List[string]]::new()
    }
}

function Disconnect-WorkerPurview {
    <#
    .SYNOPSIS
        Closes the Purview session Connect-WorkerPurview opened. Safe to call with $null.
    .PARAMETER Session
        The session Connect-WorkerPurview returned, or $null when no connection was made.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Session
    )

    if ($null -eq $Session) { return }
    try {
        if (Get-Command -Name 'Disconnect-IPPSSession' -ErrorAction SilentlyContinue) {
            Disconnect-IPPSSession -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
    catch {
        Write-Verbose "Disconnect of Purview failed: $($_.Exception.Message)"
    }
    $Session.Services.Clear()
}
