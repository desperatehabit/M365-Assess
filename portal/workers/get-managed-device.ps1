# get-managed-device.ps1 - worker entrypoint for device detail retrieval.
#
# Emits the Get-ManagedDevice response object as JSON on stdout. The worker is
# read-only. The BFF runs it with -JobFile (tenantId, deviceId, and the
# credential block for Connect-WorkerTenant, T-0826); -TenantId/-DeviceId
# remain for manual runs that manage their own session.

[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateNotNullOrEmpty()]
    [string]$DeviceId
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-ManagedDevice.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
if ($JobFile) {
    $job = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
    $TenantId = [string]$job.tenantId
    $DeviceId = [string]$job.deviceId
    if (-not $DeviceId) { throw "job envelope '$JobFile' is missing 'deviceId'" }
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $result = Get-ManagedDevice -TenantId $TenantId -DeviceId $DeviceId
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
