<#
.SYNOPSIS
    Worker entrypoint for the EPIC-025 SharePoint single site create.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or a planned site directly),
    applies the planned create live against Graph via New-SharePointSite, and
    emits the result as JSON on stdout. Stdout is the response transport. The
    supervisor connects Graph in this child process after materializing the
    tenant credential (T-0011) before invoking this script, so no secret
    handling lives here. -DryRun plans the create with no tenant write.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER SiteJson
    Single planned site as a JSON object (direct mode).
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/new-sharepoint-site.ps1 -JobFile './run/site-create-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/new-sharepoint-site.ps1 -TenantId 'tenant-a' -SiteJson '{"name":"Project Alpha","alias":"project-alpha","type":"team","owners":["owner@example.invalid"],"sharing":"disabled"}' -DryRun
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
    [string]$SiteJson = '',

    [Parameter()]
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/New-SharePointSite.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SharePointSiteCreateJob -Path $JobFile
        $TenantId = $job['TenantId']
        $site = $job['Site']
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }
    else {
        if ($SiteJson.Trim().Length -eq 0) {
            throw 'SharePoint site create needs -SiteJson in direct mode.'
        }
        $site = $SiteJson | ConvertFrom-Json
    }

    $result = New-SharePointSite -TenantId $TenantId -Site $site -DryRun:$DryRun
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
