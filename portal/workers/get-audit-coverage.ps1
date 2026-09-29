<#
.SYNOPSIS
    Worker entrypoint for the EPIC-032 audit search coverage report.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly), connects
    app-only to Purview via the T-0582 session seam, computes the tenant's audit
    search coverage live through Get-AuditCoverage, and emits the report as JSON
    on stdout. The worker is read-only.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER LastSearchAt
    Newest saved-search run instant from portal search history.
.PARAMETER Finding
    Optional run-results finding reference for the coverage gap.
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter()]
    [string]$LastSearchAt = '',

    [Parameter()]
    [object]$Finding = $null
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-AuditCoverage.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerPurview -JobFile $JobFile
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-AuditCoverageJob -Path $JobFile
        $TenantId = $job['TenantId']
        if (-not $PSBoundParameters.ContainsKey('LastSearchAt')) {
            $LastSearchAt = $job['LastSearchAt']
        }
        if (-not $PSBoundParameters.ContainsKey('Finding')) {
            $Finding = $job['Finding']
        }
    }

    $result = Get-AuditCoverage -TenantId $TenantId -LastSearchAt $LastSearchAt -Finding $Finding
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerPurview -Session $tenantSession
}
