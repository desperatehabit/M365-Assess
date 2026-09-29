<#
.SYNOPSIS
    Worker entrypoint for EPIC-028 incident list.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    queries incidents live from Graph via Get-Incidents, and emits the filtered
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
    [string]$Severity = '',

    [Parameter()]
    [string]$Status = '',

    [Parameter()]
    [string]$Classification = '',

    [Parameter()]
    [string]$Assigned = '',

    [Parameter()]
    [string]$From = '',

    [Parameter()]
    [string]$To = '',

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-Incidents.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-IncidentsJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('Severity', 'Status', 'Classification', 'Assigned', 'From', 'To', 'Top', 'Cursor')) {
            if (-not $PSBoundParameters.ContainsKey($name) -and $job.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    $invokeParams = @{
        TenantId       = $TenantId
        Severity       = $Severity
        Status         = $Status
        Classification = $Classification
        Assigned       = $Assigned
        From           = $From
        To             = $To
        Top            = $Top
        Cursor         = $Cursor
    }

    $result = Get-Incidents @invokeParams
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
