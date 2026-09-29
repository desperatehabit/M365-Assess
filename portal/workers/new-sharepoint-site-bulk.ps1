<#
.SYNOPSIS
    Worker entrypoint for the EPIC-025 SharePoint bulk site create.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    validates the bulk CSV schema before any write, creates each row via
    New-SharePointSiteBulk with one result per row, and emits the envelope as
    JSON on stdout. The supervisor connects Graph in this child process after
    materializing the tenant credential (T-0011) before invoking this script,
    so no secret handling lives here. -DryRun plans each row with no write.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER SitesJson
    Planned sites as a JSON array (direct bulk mode).
.PARAMETER CsvText
    Raw bulk CSV text (direct bulk mode). The schema is validated before any write.
.PARAMETER DryRun
    Report each intended change without writing to the tenant.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/new-sharepoint-site-bulk.ps1 -JobFile './run/site-bulk-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/new-sharepoint-site-bulk.ps1 -TenantId 'tenant-a' -CsvText 'name,alias,type,owners,template,sharing' -DryRun
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$SitesJson = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$CsvText = '',

    [Parameter()]
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/New-SharePointSite.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/New-SharePointSiteBulk.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SharePointSiteBulkJob -Path $JobFile
        $TenantId = $job['TenantId']
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
        $sites = @($job['Sites'])
        if ($sites.Count -eq 0 -and ([string]$job['Csv']).Trim().Length -gt 0) {
            $sites = @(Read-SharePointSiteCsv -CsvText ([string]$job['Csv']))
        }
        if ($sites.Count -eq 0) {
            throw 'SharePoint site bulk job carries no sites and no CSV.'
        }
    }
    else {
        if ($CsvText.Trim().Length -gt 0) {
            $sites = @(Read-SharePointSiteCsv -CsvText $CsvText)
        }
        elseif ($SitesJson.Trim().Length -gt 0) {
            $sites = @($SitesJson | ConvertFrom-Json)
        }
        else {
            throw 'SharePoint site bulk create needs -SitesJson or -CsvText in direct mode.'
        }
    }

    $results = @(New-SharePointSiteBulk -TenantId $TenantId -Sites $sites -DryRun:$DryRun)
    $envelope = [pscustomobject]@{
        tenantId = $TenantId
        total    = $results.Count
        created  = @($results | Where-Object { $_.status -eq 'created' }).Count
        planned  = @($results | Where-Object { $_.status -eq 'planned' }).Count
        failed   = @($results | Where-Object { $_.status -eq 'failed' }).Count
        dryRun   = [bool]$DryRun
        results  = @($results)
    }
    $envelope | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
