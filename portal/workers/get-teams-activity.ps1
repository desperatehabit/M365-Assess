<#
.SYNOPSIS
    Worker entrypoint for the EPIC-026 Teams activity report (T-0507).
.DESCRIPTION
    Reads a job envelope from -JobFile (or parameters directly), queries Teams
    usage live via Get-TeamsActivity (Graph usage reports with the Teams admin
    report as fallback), and outputs the report JSON to stdout. The worker is
    strictly read-only.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id.
.PARAMETER Period
    Graph usage report period: D7, D30, D90, or D180 (default D7).
.PARAMETER StartDate
    Optional activity window start (yyyy-MM-dd); rows outside the window are dropped.
.PARAMETER EndDate
    Optional activity window end (yyyy-MM-dd); rows outside the window are dropped.
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
    [ValidateSet('D7', 'D30', 'D90', 'D180')]
    [string]$Period = 'D7',

    [Parameter()]
    [datetime]$StartDate = [datetime]::MinValue,

    [Parameter()]
    [datetime]$EndDate = [datetime]::MinValue
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-TeamsActivity.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-TeamsActivityJob -Path $JobFile
        $TenantId = $job['TenantId']
        if (-not $PSBoundParameters.ContainsKey('Period')) {
            $Period = $job['Period']
        }
        if ($job['StartDate'] -ne [datetime]::MinValue) {
            $StartDate = $job['StartDate']
        }
        if ($job['EndDate'] -ne [datetime]::MinValue) {
            $EndDate = $job['EndDate']
        }
    }

    $report = Get-TeamsActivityReport -TenantId $TenantId -Period $Period -StartDate $StartDate -EndDate $EndDate
    $report | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
