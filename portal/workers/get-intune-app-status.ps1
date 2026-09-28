<#
.SYNOPSIS
    Worker entrypoint for EPIC-017 deployment and enrollment status (T-0844).
.DESCRIPTION
    Reads the job document, signs in to the job's tenant, and prints per-device app install
    status ('apps') or enrollment state ('enrollment') as JSON. Read-only.
.PARAMETER JobFile
    Path to the job document JSON written by the BFF.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-IntuneAppStatus.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
try {
    $job = Read-IntuneAppStatusJob -Path $JobFile
    $rows = if ($job['action'] -eq 'apps') { Get-AppDeviceStatuses } else { Get-EnrollmentDeviceStatuses }
    # Wrap the list so a single row or none still prints as a JSON array.
    ConvertTo-Json -InputObject @{ items = @($rows) } -Depth 10 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
