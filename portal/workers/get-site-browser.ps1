<#
.SYNOPSIS
    Worker entrypoint for the EPIC-025 site browser (T-0488).
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly), queries
    one site's libraries, items, permissions, and external users live via
    Get-SiteBrowser, and emits the result as JSON on stdout. The worker is
    read-only: permission changes are handed to EPIC-027 through the result's
    hand-off paths.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id.
.PARAMETER SiteId
    Direct Graph site id.
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
    [ValidateNotNullOrEmpty()]
    [string]$SiteId
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-SiteBrowser.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SiteBrowserJob -Path $JobFile
        $TenantId = $job['TenantId']
        $SiteId = $job['SiteId']
    }

    $result = Get-SiteBrowser -TenantId $TenantId -SiteId $SiteId
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
