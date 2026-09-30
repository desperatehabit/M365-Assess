# Get-PurviewLabels.ps1 — EPIC-030 Purview sensitivity-label and SIT read
# (SPEC §3.3, §3.4, §6; T-0587).
#
# Live Purview reads only: sensitivity labels are read with Get-Label and
# Get-LabelPolicy and shaped to the §3.3 columns (name, scope, priority,
# encryption, marking, state plus the publishing policies a label is assigned
# to); sensitive information types are read with Get-DlpSensitiveInformationType
# and shaped to the §3.4 columns (name, type, pattern confidence, based on).
# Filtering and cursor paging happen over that single read. Only Get- cmdlets are
# issued; nothing is written to the tenant and nothing is persisted to disk. The
# caller (child entrypoint) runs with the Purview session the supervisor
# connected after materializing the tenant credential in-process; this file never
# touches secrets.

function Read-PurviewLabelsJob {
    <#
    .SYNOPSIS
        Parses a job envelope JSON for Get-PurviewLabels.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Purview labels job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Purview labels job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'Purview labels job is missing required field: tenantId'
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

    $kind = [string]$filters['kind']
    if ([string]::IsNullOrWhiteSpace($kind)) {
        $kind = 'labels'
    }
    if ($kind -ne 'labels' -and $kind -ne 'sits') {
        throw "Purview labels job has unsupported kind: $kind"
    }

    return @{
        TenantId = $tenantId
        Kind     = $kind
        Search   = [string]$filters['search']
        State    = [string]$filters['state']
        Type     = [string]$filters['type']
        Top      = ConvertFrom-PurviewLabelsJobInt -Value $filters['top'] -Default 100
        Cursor   = [string]$filters['cursor']
    }
}

function ConvertFrom-PurviewLabelsJobInt {
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

function ConvertTo-PurviewLabelsCursor {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [int]$Offset
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Offset")
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function ConvertFrom-PurviewLabelsCursor {
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
        Write-Verbose 'Ignoring undecodable Purview labels cursor and starting at the first page.'
    }
    return 0
}

function ConvertTo-PurviewLabelScope {
    <#
    .SYNOPSIS
        Shapes the label scope list from Scope or the ContentType fallback.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [object]$Label
    )

    $scope = [System.Collections.Generic.List[string]]::new()
    if ($Label.Scope -and @($Label.Scope).Count -gt 0) {
        foreach ($item in @($Label.Scope)) {
            $text = [string]$item
            if ($text.Trim().Length -gt 0) { $scope.Add($text.Trim()) }
        }
    }
    elseif ($Label.ContentType) {
        foreach ($item in ([string]$Label.ContentType -split ',')) {
            $text = $item.Trim()
            if ($text.Length -gt 0) { $scope.Add($text) }
        }
    }
    return @($scope | Select-Object -Unique)
}

function ConvertTo-PurviewLabelEncryption {
    <#
    .SYNOPSIS
        Shapes the §3.3 encryption cell, or $null when the label encrypts nothing.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Label
    )

    $rights = [System.Collections.Generic.List[string]]::new()
    if ($Label.EncryptionRightsDefinitions) {
        foreach ($item in @($Label.EncryptionRightsDefinitions)) {
            foreach ($part in ([string]$item -split ',')) {
                $text = $part.Trim()
                if ($text.Length -gt 0) { $rights.Add($text) }
            }
        }
    }

    $enabled = $Label.EncryptionEnabled -eq $true
    if (-not $enabled -and -not $Label.EncryptionProtectionType -and -not $Label.EncryptionTemplateId -and $rights.Count -eq 0) {
        return $null
    }

    $protectionType = $null
    if ($Label.EncryptionProtectionType) { $protectionType = [string]$Label.EncryptionProtectionType }
    $templateId = $null
    if ($Label.EncryptionTemplateId) { $templateId = [string]$Label.EncryptionTemplateId }
    $contentExpiration = $null
    if ($Label.EncryptionContentExpiredOnDateInDaysOrNever) {
        $contentExpiration = [string]$Label.EncryptionContentExpiredOnDateInDaysOrNever
    }
    $offlineAccess = $false
    if ($Label.EncryptionOfflineAccessDays -eq $true) {
        $offlineAccess = $true
    }
    elseif ($null -ne $Label.EncryptionOfflineAccessDays) {
        $days = 0
        if ([int]::TryParse([string]$Label.EncryptionOfflineAccessDays, [ref]$days) -and $days -gt 0) {
            $offlineAccess = $true
        }
    }

    return [pscustomobject]@{
        enabled           = $enabled
        protectionType    = $protectionType
        templateId        = $templateId
        rights            = @($rights)
        contentExpiration = $contentExpiration
        offlineAccess     = $offlineAccess
    }
}

function ConvertTo-PurviewLabelMarking {
    <#
    .SYNOPSIS
        Shapes the §3.3 marking cell (header, footer, watermark) for a label.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [object]$Label
    )

    $marking = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace([string]$Label.ApplyContentMarkingHeaderText)) {
        $marking.Add('header')
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Label.ApplyContentMarkingFooterText)) {
        $marking.Add('footer')
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Label.ApplyWatermarkText)) {
        $marking.Add('watermark')
    }
    return @($marking)
}

function ConvertTo-PurviewLabelRow {
    <#
    .SYNOPSIS
        Shapes one Get-Label record into the §3.3 list row.
    .PARAMETER Label
        The Get-Label record.
    .PARAMETER PublishingPolicies
        Names of the Get-LabelPolicy records this label is assigned to.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Label,

        [Parameter()]
        [string[]]$PublishingPolicies = @()
    )

    $id = [string]$Label.Identity
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Label.Name
    }
    $name = [string]$Label.DisplayName
    if ($name.Trim().Length -eq 0) {
        $name = [string]$Label.Name
    }

    $priority = $null
    if ($null -ne $Label.Priority -and ([string]$Label.Priority).Trim().Length -gt 0) {
        $parsed = 0
        if ([int]::TryParse([string]$Label.Priority, [ref]$parsed)) { $priority = $parsed }
    }

    $state = 'enabled'
    if ($Label.Disabled -eq $true) { $state = 'disabled' }

    $published = @($PublishingPolicies).Count -gt 0

    return [pscustomobject]@{
        id                = $id
        name              = $name
        scope             = @(ConvertTo-PurviewLabelScope -Label $Label)
        priority          = $priority
        encryption        = ConvertTo-PurviewLabelEncryption -Label $Label
        marking           = @(ConvertTo-PurviewLabelMarking -Label $Label)
        state             = $state
        published         = $published
        publishingPolicies = @($PublishingPolicies | Select-Object -Unique)
    }
}

function ConvertTo-PurviewSitRow {
    <#
    .SYNOPSIS
        Shapes one Get-DlpSensitiveInformationType record into the §3.4 list row.
    .PARAMETER Sit
        The Get-DlpSensitiveInformationType record.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [object]$Sit
    )

    $id = [string]$Sit.Guid
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Sit.Identity
    }
    if ($id.Trim().Length -eq 0) {
        $id = [string]$Sit.Name
    }

    $kind = 'builtin'
    if ($Sit.IsCustom -eq $true) { $kind = 'custom' }

    $patternConfidence = $null
    if ($null -ne $Sit.RecommendedConfidence -and ([string]$Sit.RecommendedConfidence).Trim().Length -gt 0) {
        $patternConfidence = [string]$Sit.RecommendedConfidence
    }
    elseif ($null -ne $Sit.Confidence -and ([string]$Sit.Confidence).Trim().Length -gt 0) {
        $patternConfidence = [string]$Sit.Confidence
    }

    $basedOn = $null
    if (-not [string]::IsNullOrWhiteSpace([string]$Sit.BasedOn)) {
        $basedOn = [string]$Sit.BasedOn
    }

    return [pscustomobject]@{
        id                = $id
        name              = [string]$Sit.Name
        type              = $kind
        patternConfidence = $patternConfidence
        basedOn           = $basedOn
    }
}

function Test-PurviewLabelFilter {
    <#
    .SYNOPSIS
        Applies the label list filters to one shaped row.
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

function Test-PurviewSitFilter {
    <#
    .SYNOPSIS
        Applies the SIT list filters to one shaped row.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Row,

        [Parameter()]
        [string]$Search = '',

        [Parameter()]
        [string]$Type = ''
    )

    if ($Search.Trim().Length -gt 0) {
        $needle = $Search.Trim().ToLowerInvariant()
        if (-not ([string]$Row.name).ToLowerInvariant().Contains($needle)) {
            return $false
        }
    }
    if ($Type.Trim().Length -gt 0 -and [string]$Row.type -ne $Type.Trim().ToLowerInvariant()) {
        return $false
    }
    return $true
}

function Get-PurviewLabels {
    <#
    .SYNOPSIS
        Lists tenant sensitivity labels live with §3.3 columns.
    .DESCRIPTION
        Reads Get-Label and Get-LabelPolicy once, shapes the §3.3 rows (name,
        scope, priority, encryption, marking, state, publishing policies) ordered
        by priority then name, applies the requested filters, and returns one
        cursor page. Only Get- cmdlets are issued; nothing is written.
    .PARAMETER TenantId
        Tenant the labels belong to. Carried through to the result envelope.
    .PARAMETER Search
        Case-insensitive substring match against the label name.
    .PARAMETER State
        Filter by label state: enabled, disabled, or empty for all.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-PurviewLabels -TenantId 'tenant-a' -State 'enabled' -Top 50
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

    $labels = @(Get-Label -ErrorAction Stop)
    $policies = @(Get-LabelPolicy -ErrorAction Stop)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($label in $labels) {
        if ($null -eq $label) {
            continue
        }
        $id = [string]$label.Identity
        if ($id.Trim().Length -eq 0) { $id = [string]$label.Name }
        $name = [string]$label.DisplayName
        if ($name.Trim().Length -eq 0) { $name = [string]$label.Name }

        $assigned = [System.Collections.Generic.List[string]]::new()
        foreach ($policy in $policies) {
            if ($null -eq $policy) { continue }
            $members = @($policy.Labels)
            if ($members -contains $id -or $members -contains $name) {
                $assigned.Add([string]$policy.Name)
            }
        }

        $row = ConvertTo-PurviewLabelRow -Label $label -PublishingPolicies @($assigned)
        if (Test-PurviewLabelFilter -Row $row -Search $Search -State $State) {
            $rows.Add($row)
        }
    }

    $ordered = @($rows | Sort-Object -Property @(
            @{ Expression = { if ($null -eq $_.priority) { [int]::MaxValue } else { [int]$_.priority } }; Ascending = $true }
            @{ Expression = { $_.name }; Ascending = $true }
        ))
    $offset = ConvertFrom-PurviewLabelsCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-PurviewLabelsCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        kind        = 'labels'
        items       = $page
        nextCursor  = $nextCursor
        totalCount  = $ordered.Count
        retrievedAt = (Get-Date -Format 'o')
    }
}

function Get-PurviewSits {
    <#
    .SYNOPSIS
        Lists tenant sensitive information types live with §3.4 columns.
    .DESCRIPTION
        Reads Get-DlpSensitiveInformationType once, shapes the §3.4 rows (name,
        type, pattern confidence, based on) ordered by name, applies the requested
        filters, and returns one cursor page. Only Get- cmdlets are issued;
        nothing is written.
    .PARAMETER TenantId
        Tenant the SITs belong to. Carried through to the result envelope.
    .PARAMETER Search
        Case-insensitive substring match against the SIT name.
    .PARAMETER Type
        Filter by SIT type: builtin, custom, or empty for all.
    .PARAMETER Top
        Page size.
    .PARAMETER Cursor
        Opaque page cursor from a previous result. Empty starts at the first page.
    .EXAMPLE
        Get-PurviewSits -TenantId 'tenant-a' -Type 'custom' -Top 50
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
        [ValidateSet('', 'builtin', 'custom')]
        [string]$Type = '',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$Top = 100,

        [Parameter()]
        [string]$Cursor = ''
    )

    $sits = @(Get-DlpSensitiveInformationType -ErrorAction Stop)

    $rows = [System.Collections.Generic.List[object]]::new()
    foreach ($sit in $sits) {
        if ($null -eq $sit) {
            continue
        }
        $row = ConvertTo-PurviewSitRow -Sit $sit
        if (Test-PurviewSitFilter -Row $row -Search $Search -Type $Type) {
            $rows.Add($row)
        }
    }

    $ordered = @($rows | Sort-Object -Property @{ Expression = { $_.name }; Ascending = $true })
    $offset = ConvertFrom-PurviewLabelsCursor -Cursor $Cursor
    $page = @($ordered | Select-Object -Skip $offset -First $Top)
    $nextOffset = $offset + $page.Count
    $nextCursor = ''
    if ($nextOffset -lt $ordered.Count) {
        $nextCursor = ConvertTo-PurviewLabelsCursor -Offset $nextOffset
    }

    return [pscustomobject]@{
        tenantId    = $TenantId
        kind        = 'sits'
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
