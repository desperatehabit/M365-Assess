<#
.SYNOPSIS
    Worker entrypoint for EPIC-015 Conditional Access change history.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly), queries
    Graph directoryAudits for Conditional Access policy changes (add, update,
    delete policy), and emits the JSON envelope on stdout. The BFF merges these
    with the portal's own before/after audit_events rows. Read-only: only Graph
    GET requests are issued; results are ephemeral (returned on stdout only).
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER PolicyId
    Optional policy id to scope the history to one policy.
.PARAMETER Top
    Maximum records returned.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-ca-history.ps1 -JobFile './run/ca-history-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-ca-history.ps1 -TenantId 'tenant-a' -PolicyId 'pol-1'
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter()]
    [string]$PolicyId = '',

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Top = 100
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-CaHistory.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-CaHistoryJob -Path $JobFile
        $TenantId = $job['TenantId']
        $PolicyId = $job['PolicyId']
        if (-not $PSBoundParameters.ContainsKey('Top')) {
            $Top = if ($job['Top'] -gt 0) { $job['Top'] } else { 100 }
        }
    }

    $result = Get-CaHistory -TenantId $TenantId -PolicyId $PolicyId -Top $Top
    $result | ConvertTo-Json -Depth 10 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
