<#
.SYNOPSIS
    Worker entrypoint for EPIC-028 alert list.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    queries alerts live from Graph via Get-Alerts, and emits the normalized
    cursor page as JSON on stdout. The worker is read-only.
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
    [string]$TenantId,

    [Parameter()]
    [string]$Source = '',

    [Parameter()]
    [string]$Severity = '',

    [Parameter()]
    [string]$Status = '',

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-Alerts.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-AlertsJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('Source', 'Severity', 'Status', 'Top', 'Cursor')) {
            if (-not $PSBoundParameters.ContainsKey($name) -and $job.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    $invokeParams = @{
        TenantId = $TenantId
        Source   = $Source
        Severity = $Severity
        Status   = $Status
        Top      = $Top
        Cursor   = $Cursor
    }

    $result = Get-Alerts @invokeParams
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
