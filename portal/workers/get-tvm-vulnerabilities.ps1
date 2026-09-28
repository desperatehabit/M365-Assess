<#
.SYNOPSIS
    Worker entrypoint for EPIC-019 TVM vulnerabilities.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    queries TVM vulnerabilities live from the Graph security API via
    Get-TvmVulnerabilities (or Get-TvmVulnerabilityDevices when -CveId is set
    for drill-through), and emits the filtered cursor page as JSON on stdout.
    The worker is read-only.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id.
.PARAMETER CveId
    When set, lists affected devices for that CVE instead of the CVE list.
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
    [string]$Severity = '',

    [Parameter()]
    [string]$Software = '',

    [Parameter()]
    [string]$Device = '',

    [Parameter()]
    [string]$Search = '',

    [Parameter()]
    [string]$CveId = '',

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-TvmVulnerabilities.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-TvmVulnerabilitiesJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('Severity', 'Software', 'Device', 'Search', 'CveId', 'Top', 'Cursor')) {
            if (-not $PSBoundParameters.ContainsKey($name) -and $job.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($CveId)) {
        $result = Get-TvmVulnerabilityDevices -TenantId $TenantId -CveId $CveId -Top $Top -Cursor $Cursor
    }
    else {
        $invokeParams = @{
            TenantId = $TenantId
            Severity = $Severity
            Software = $Software
            Device   = $Device
            Search   = $Search
            Top      = $Top
            Cursor   = $Cursor
        }
        $result = Get-TvmVulnerabilities @invokeParams
    }
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
