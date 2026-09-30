<#
.SYNOPSIS
    Worker entrypoint for the EPIC-025 SharePoint site delete/restore and recycle-bin lifecycle.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly), runs
    the requested lifecycle action through Invoke-SharePointSiteAction, and
    emits the result as JSON on stdout. Stdout is the response transport; site
    objects are never mirrored to disk. The supervisor connects Graph in this
    child process after materializing the tenant credential (T-0011) before
    invoking this script, so no secret handling lives here. -DryRun plans with
    no tenant write; delete and empty apply require -Confirmed.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    delete | restore | recyclebin-list | recyclebin-restore | recyclebin-empty.
.PARAMETER SiteId
    Site identity for delete/restore runs without a job envelope.
.PARAMETER RecycleBinIds
    Recycle-bin identities for restore/empty runs without a job envelope.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for delete/empty apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-sharepoint-site-action.ps1 -JobFile './run/site-action-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-sharepoint-site-action.ps1 -TenantId 'tenant-a' -Action 'restore' -SiteId 'site-1' -DryRun
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateSet('delete', 'restore', 'recyclebin-list', 'recyclebin-restore', 'recyclebin-empty')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$SiteId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [AllowEmptyCollection()]
    [string[]]$RecycleBinIds = @(),

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-SharePointSiteAction.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $Actor = ''
    $CorrelationId = ''
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SharePointSiteActionJob -Path $JobFile
        $TenantId = $job['TenantId']
        $Action = $job['Action']
        $SiteId = $job['SiteId']
        $RecycleBinIds = $job['RecycleBinIds']
        $Actor = $job['Actor']
        $CorrelationId = $job['CorrelationId']
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }

    $result = Invoke-SharePointSiteAction -TenantId $TenantId -Action $Action -SiteId $SiteId -RecycleBinIds $RecycleBinIds -DryRun ([bool]$DryRun) -Confirmed ([bool]$Confirmed) -Actor $Actor -CorrelationId $CorrelationId
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
