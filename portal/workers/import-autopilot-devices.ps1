<#
.SYNOPSIS
    Worker entrypoint for EPIC-017 Autopilot devices and import (T-0328).
.DESCRIPTION
    Reads the job document, signs in to the job's tenant, runs the requested action
    (list-devices, get-device, list-profiles, import), and prints the result as JSON.
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

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Import-AutopilotDevices.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
try {
    $job = Read-AutopilotJob -Path $JobFile
    $tenantId = [string]$job['tenantId']
    $result = switch ($job['action']) {
        'list-devices' {
            $listParams = @{
                TenantId        = $tenantId
                Search          = [string]$job['search']
                GroupTag        = [string]$job['groupTag']
                EnrollmentState = [string]$job['enrollmentState']
                Top             = if ($job['top']) { [int]$job['top'] } else { 100 }
                Cursor          = [string]$job['cursor']
            }
            Get-AutopilotDevices @listParams
        }
        'get-device' {
            $device = Get-AutopilotDevice -DeviceId ([string]$job['deviceId'])
            if ($device) { $device } else { @{ error = 'autopilot.device.not_found'; message = 'Autopilot device not found'; statusCode = 404 } }
        }
        'list-profiles' { Get-AutopilotProfiles -TenantId $tenantId }
        'import' {
            $importParams = @{
                TenantId = $tenantId
                Source   = [string]$job['source']
                Rows     = @($job['rows'] | Where-Object { $null -ne $_ })
                Csv      = [string]$job['csv']
                Preview  = [bool]($job['preview'] -eq $true)
                Actor    = if ($job['actor']) { [string]$job['actor'] } else { 'system' }
                Confirm  = $false
            }
            Invoke-AutopilotImport @importParams
        }
    }
    ConvertTo-Json -InputObject $result -Depth 20 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
