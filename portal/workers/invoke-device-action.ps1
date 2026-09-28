# invoke-device-action.ps1 - worker entrypoint for sync/retire device actions.
#
# Emits the Invoke-DeviceAction response object as JSON on stdout. The BFF
# runs it with -JobFile (tenantId, deviceId, action, reason, and the credential
# block for Connect-WorkerTenant, T-0826); direct parameters remain for manual
# runs that manage their own session.

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
    [string]$DeviceId,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateSet('sync', 'retire')]
    [string]$Action,

    [Parameter()]
    [string]$Reason = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-DeviceAction.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
if ($JobFile) {
    $job = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
    $TenantId = [string]$job.tenantId
    $DeviceId = [string]$job.deviceId
    $Action = [string]$job.action
    if (-not $DeviceId) { throw "job envelope '$JobFile' is missing 'deviceId'" }
    if (-not $Action) { throw "job envelope '$JobFile' is missing 'action'" }
    if ($job.reason) { $Reason = [string]$job.reason }
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $result = Invoke-DeviceAction -TenantId $TenantId -DeviceId $DeviceId -Action $Action -Reason $Reason
    $result | ConvertTo-Json -Depth 5 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
