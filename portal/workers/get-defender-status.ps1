<#
.SYNOPSIS
    Worker entrypoint for EPIC-019 Defender status.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    reads Defender configuration state per policy area (current vs
    recommended) via Get-DefenderStatus, and emits JSON on stdout.
    The worker is read-only.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id.
.PARAMETER Area
    Optional single policy area (av, edr, asr, compliance, firewall, exclusions).
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
    [ValidateSet('', 'av', 'edr', 'asr', 'compliance', 'firewall', 'exclusions')]
    [string]$Area = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-DefenderStatus.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph, ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-DefenderStatusJob -Path $JobFile
        $TenantId = $job['TenantId']
        if (-not $PSBoundParameters.ContainsKey('Area') -and $job.ContainsKey('Area')) {
            Set-Variable -Name Area -Value $job['Area']
        }
    }

    $result = Get-DefenderStatus -TenantId $TenantId -Area $Area
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
