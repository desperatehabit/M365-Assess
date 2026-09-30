<#
.SYNOPSIS
    Worker entrypoint for EPIC-033 Licence Consumption report.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    queries subscribed SKUs and their consumption from Graph, joins pricing
    from the portal database, and emits JSON on stdout. The worker is read-only.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id.
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-LicenseReport.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $pricing = @()
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-LicenseReportJob -Path $JobFile
        $TenantId = $job['TenantId']
        $pricing = $job['Pricing']
    }

    $result = Get-LicenseReport -TenantId $TenantId -Pricing $pricing
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}