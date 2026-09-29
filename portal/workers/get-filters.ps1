<#
.SYNOPSIS
    Worker entrypoint for the EPIC-022 filter policy read.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or a tenant id plus filter
    type directly), reads the filter policies live from Exchange Online via
    Get-Filters, and emits the result as JSON on stdout. Stdout is the
    response transport; filter policies are never mirrored to disk. The
    supervisor connects EXO in this child process after materializing the
    tenant credential (T-0011) before invoking this script, so no secret
    handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER FilterType
    Direct filter type for runs without a job envelope: spam, antiphish,
    malware, or connection.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-filters.ps1 -JobFile './run/filters-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-filters.ps1 -TenantId 'tenant-a' -FilterType 'spam'
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
    [string]$FilterType
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-Filters.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-FiltersJob -Path $JobFile
        $TenantId = $job['TenantId']
        if (-not $PSBoundParameters.ContainsKey('FilterType')) {
            Set-Variable -Name FilterType -Value $job['FilterType']
        }
    }

    $result = Get-Filters -TenantId $TenantId -FilterType $FilterType
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
