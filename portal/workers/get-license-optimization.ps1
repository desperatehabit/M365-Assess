<#
.SYNOPSIS
    Worker entrypoint for EPIC-033 Licence Optimization.
.DESCRIPTION
    Reads a job envelope from -JobFile (or parameters directly), gathers per-user
    licence assignments, activity, assignment errors, and SKU expiries from
    Graph, and emits the raw classification input as JSON on stdout. The BFF
    domain classifies unused/overused/expiring; the worker is read-only.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id.
.PARAMETER InactivityDays
    Days without activity before an assignment is unused (default 30).
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
    [ValidateRange(1, 3650)]
    [int]$InactivityDays = 30
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-LicenseOptimization.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-LicenseOptimizationJob -Path $JobFile
        $TenantId = $job['TenantId']
        $InactivityDays = $job['InactivityDays']
    }

    $result = Get-LicenseOptimization -TenantId $TenantId -InactivityDays $InactivityDays
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
