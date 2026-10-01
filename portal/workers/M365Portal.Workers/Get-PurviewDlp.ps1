# Get-PurviewDlp.ps1 — EPIC-030 Purview DLP policy read (SPEC §2 US-1, §3.1, §6; T-0582).
#
# Live Purview reads only: DLP policies are read with Get-DlpCompliancePolicy and
# their rules with Get-DlpComplianceRule on every call and shaped to the §3.1
# columns (name, state, locations, rules, last modified). Filtering and cursor
# paging happen over that single read. Only Get- cmdlets are issued; nothing is
# written to the tenant and nothing is persisted to disk. The caller (child
# entrypoint) runs with the Purview session the supervisor connected after
# materializing the tenant credential in-process; this file never touches secrets.

function Read-PurviewDlpJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-PurviewDlp.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Purview DLP job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Purview DLP job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Purview DLP job is missing required field: tenantId'
    }

    $filters = $job['payload']
    if ($filters -is [System.Collections.IDictionary]) {
        $nested = $filters['filters']
        if ($nested -is [System.Collections.IDictionary]) {
            $filters = $nested
        }
    }
    else {
        $filters = @{}
    }

    return @{
        TenantId = $tenantId
        Search   = [string]$filters['search']
        State    = [string]$filters['state']
        Top      = ConvertFrom-PurviewDlpJobInt -Value $filters['top'] -Default 100
        Cursor   = [string]$filters['cursor']
    }
}

function ConvertFrom-PurviewDlpJobInt {
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

function ConvertTo-PurviewDlpCursor {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-PurviewDlpCursor {
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
        Write-Verbose 'Ignoring undecodable Purview DLP cursor and starting at the first page.'
    }
    return 0
}

function ConvertTo-PurviewDlpRow {
    <#
    .SYNOPSIS
        Shapes one Get-DlpCompliancePolicy record into the §3.1 list row.
    .PARAMETER Policy
        The Get-DlpCompliancePolicy record.
    .PARAMETER RuleCount
        Number of Get-DlpComplianceRule records attached to the policy.
    .EXAMPLE
        ConvertTo-PurviewDlpRow -Policy $policy -RuleCount 3
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Policy,

        [Parameter()]
        [int]$RuleCount = 0
    )

    $id = [string]$Policy.Identity
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Policy.Name
    }

    $state = 'disabled'
    if ($null -ne $Policy.Enabled) {
        if ($Policy.Enabled -eq $true) {
            $state = 'enabled'
        }
    }
    elseif ([string]$Policy.Mode -ne 'Disable') {
        $state = 'enabled'
    }

    $locations = [System.Collections.Generic.List[string]]::new()
    if ($Policy.ExchangeLocation -and @($Policy.ExchangeLocation).Count -gt 0) {
        $locations.Add('Exchange')
    }
    if ($Policy.SharePointLocation -and @($Policy.SharePointLocation).Count -gt 0) {
        $locations.Add('SharePoint')
    }
    if ($Policy.TeamsLocation -and @($Policy.TeamsLocation).Count -gt 0) {
        $locations.Add('Teams')
    }
    if ($Policy.EndpointDlpLocation -and @($Policy.EndpointDlpLocation).Count -gt 0) {
        $locations.Add('Endpoint')
    }

    $lastModified = [string]$Policy.WhenChanged
    if ($lastModified.Trim().Length -eq 0) {
        $lastModified = [string]$Policy.LastModifiedTime
    }

    return [pscustomobject]@{
        id           = $id
        name         = [string]$Policy.Name
        state        = $state
        locations    = @($locations | Select-Object -Unique)
        rules        = $RuleCount
        lastModified = $lastModified
    }
}

function Test-PurviewDlpFilter {
    <#
    .SYNOPSIS
        Applies the list filters to one shaped row.
    .PARAMETER Row
        The ConvertTo-PurviewDlpRow result.
    .PARAMETER Search
        Case-insensitive substring match against the policy name.
    .PARAMETER State
        Keeps enabled, disabled, or all when empty.
    .EXAMPLE
        Test-PurviewDlpFilter -Row $row -State 'enabled'
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

function Get-PurviewDlp {
    <#
    .SYNOPSIS
        Lists tenant Purview DLP policies live with §3.1 columns.
    .DESCRIPTION
        Reads Get-DlpCompliancePolicy and Get-DlpComplianceRule once, shapes the
        §3.1 rows (name, state, locations, rules, last modified) ordered by name,
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
        Get-PurviewDlp -TenantId 'tenant-a' -State 'enabled' -Top 50
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
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $policies = @(Get-DlpCompliancePolicy -ErrorAction Stop)
    $rules = @(Get-DlpComplianceRule -ErrorAction Stop)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($policy in $policies) {
        if ($null -eq $policy) {
            continue
        }
        $ruleCount = 0
        foreach ($rule in $rules) {
            if ($null -eq $rule) {
                continue
            }
            if ([string]$rule.ParentPolicyName -eq [string]$policy.Name -or
                [string]$rule.Policy -eq [string]$policy.Name) {
                $ruleCount++
            }
        }
        $row = ConvertTo-PurviewDlpRow -Policy $policy -RuleCount $ruleCount
        if (Test-PurviewDlpFilter -Row $row -Search $Search -State $State) {
            $rows.Add($row)
        }
    }

    $ordered = @($rows | Sort-Object -Property @{ Expression = { $_.name }; Ascending = $true })
    $offset = ConvertFrom-PurviewDlpCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-PurviewDlpCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
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
