# New-SharePointSiteBulk.ps1 — EPIC-025 bulk site create worker (SPEC §4.1, §6; T-0484).
#
# Parses the bulk CSV fixed in T-0484 (SPEC §11 item 3) and creates each row
# through New-SharePointSite with per-row results. A malformed file (empty,
# missing required columns, no rows) is rejected before any write; a row that
# fails validation or apply is reported per row without aborting its siblings,
# so a partial success is always explicit, never silent.

if (-not (Get-Command Test-SharePointSiteInput -CommandType Function -ErrorAction SilentlyContinue)) {
    . (Join-Path -Path $PSScriptRoot -ChildPath 'New-SharePointSite.ps1')
}

$script:SharePointSiteCsvRequiredColumns = @('name', 'alias', 'type', 'owners', 'sharing')

function Read-SharePointSiteCsv {
    <#
    .SYNOPSIS
        Parses bulk site-create CSV text into planned sites.
    .DESCRIPTION
        Enforces the T-0484 header (name, alias, type, owners, template,
        sharing) before returning anything: unknown columns are ignored, but a
        missing required column, an empty file, or a file with no data rows
        throws CsvValidationFailed and the caller must not write. Row-level
        value errors are left to New-SharePointSite so bulk results stay
        per-row.
    .PARAMETER CsvText
        Raw CSV text including the header row. Owners within a row are
        semicolon-separated UPNs.
    .EXAMPLE
        Read-SharePointSiteCsv -CsvText (Get-Content -LiteralPath './sites.csv' -Raw)
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$CsvText
    )

    if ([string]::IsNullOrWhiteSpace($CsvText)) {
        throw 'CsvValidationFailed: CSV is empty'
    }
    $rows = @($CsvText | ConvertFrom-Csv)
    if ($rows.Count -eq 0) {
        throw 'CsvValidationFailed: CSV has no site rows'
    }
    $header = @($rows[0].PSObject.Properties.Name | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() })
    $missing = @($script:SharePointSiteCsvRequiredColumns | Where-Object { $header -notcontains $_ })
    if ($missing.Count -gt 0) {
        throw "CsvValidationFailed: CSV is missing required column(s): $($missing -join ', ')"
    }

    $sites = [System.Collections.Generic.List[object]]::new()
    $row = 0
    foreach ($entry in $rows) {
        $row += 1
        $lookup = @{}
        foreach ($prop in $entry.PSObject.Properties) {
            $lookup[([string]$prop.Name).Trim().ToLowerInvariant()] = $prop.Value
        }
        $sites.Add([pscustomobject]@{
            row      = $row
            name     = [string]$lookup['name']
            alias    = [string]$lookup['alias']
            type     = [string]$lookup['type']
            owners   = [string]$lookup['owners']
            template = [string]$lookup['template']
            sharing  = [string]$lookup['sharing']
        })
    }
    return @($sites)
}

function New-SharePointSiteBulk {
    <#
    .SYNOPSIS
        Creates planned sites one by one with per-row results.
    .DESCRIPTION
        Calls New-SharePointSite per row inside its own trap so a row that
        fails validation or apply is reported per row without aborting
        siblings. A partial failure never rolls back successful rows, and the
        per-row results make that explicit.
    .PARAMETER TenantId
        Tenant the sites belong to.
    .PARAMETER Sites
        Planned site objects (from Read-SharePointSiteCsv or the job payload).
    .PARAMETER DryRun
        Report each intended change without writing to the tenant.
    .PARAMETER Actor
        Caller identity recorded on each audit event.
    .PARAMETER CorrelationId
        Correlation id recorded on each audit event.
    .PARAMETER WriteAudit
        Seam: scriptblock (event) -> void. Defaults to a no-op.
    .EXAMPLE
        New-SharePointSiteBulk -TenantId 'tenant-a' -Sites $sites
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Sites,

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [string]$Actor = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter()]
        [scriptblock]$WriteAudit = { param($AuditEvent) }
    )

    $results = [System.Collections.Generic.List[object]]::new()
    $row = 0
    foreach ($site in $Sites) {
        $row += 1
        $rowNumber = $row
        if ($null -ne $site -and $null -ne $site.PSObject.Properties['row'] -and [string]$site.row -ne '') {
            $rowNumber = [int]$site.row
        }
        try {
            $result = New-SharePointSite -TenantId $TenantId -Site $site -DryRun:$DryRun -Actor $Actor -CorrelationId $CorrelationId -WriteAudit $WriteAudit
            $result | Add-Member -NotePropertyName 'row' -NotePropertyValue $rowNumber -Force
            $results.Add($result)
        }
        catch {
            $name = ''
            $alias = ''
            if ($null -ne $site) {
                $name = [string]$site.name
                $alias = [string]$site.alias
            }
            $results.Add([pscustomobject]@{
                row    = $rowNumber
                name   = $name.Trim()
                alias  = $alias.Trim()
                type   = ''
                status = 'failed'
                id     = $null
                error  = $_.Exception.Message
                before = $null
                after  = $null
            })
        }
    }
    return @($results)
}

function Read-SharePointSiteBulkJob {
    <#
    .SYNOPSIS
        Reads a T-0007 job envelope file into New-SharePointSiteBulk parameters.
    .DESCRIPTION
        Validates the envelope schema version and tenant, then returns the
        planned sites (payload.sites), the raw bulk CSV (payload.csv), or the
        single planned site (payload.site) with the dry-run flag. CSV schema
        validation happens in Read-SharePointSiteCsv after this returns, still
        before any write.
    .PARAMETER Path
        Path to the job envelope JSON the supervisor wrote for this run.
    .EXAMPLE
        Read-SharePointSiteBulkJob -Path './run/site-bulk-job.json'
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "SharePoint site bulk job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "SharePoint site bulk job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    $tenantId = [string]$job['tenantId']
    if ([string]::IsNullOrWhiteSpace($tenantId)) {
        throw 'SharePoint site bulk job is missing required field: tenantId'
    }
    $payload = $job['payload']
    if ($payload -isnot [System.Collections.IDictionary]) {
        $payload = @{}
    }
    $sites = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in @($payload['sites'])) {
        if ($null -ne $entry) {
            $sites.Add($entry)
        }
    }
    if ($sites.Count -eq 0 -and $null -ne $payload['site']) {
        $sites.Add($payload['site'])
    }
    return @{
        TenantId = $tenantId
        Sites    = @($sites)
        Csv      = [string]$payload['csv']
        DryRun   = ($payload['dryRun'] -eq $true)
    }
}
