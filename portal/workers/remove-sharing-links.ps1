# remove-sharing-links.ps1 - worker entrypoint for bulk sharing-link removal (T-0527).
#
# Emits the Remove-SharingLinks response object as JSON on stdout. The BFF
# runs it with -JobFile (tenantId, links, mode, confirmCount, actor,
# correlationId, and the credential block for Connect-WorkerTenant, T-0826);
# direct parameters remain for manual runs that manage their own session.
# Plan is the default: a job that omits the mode does not write.

[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [object[]]$Links,

    [Parameter(ParameterSetName = 'ByParams')]
    [ValidateSet('Plan', 'Apply')]
    [string]$Mode = 'Plan',

    [Parameter(ParameterSetName = 'ByParams')]
    [int]$ConfirmCount = -1,

    [Parameter()]
    [string]$Actor = '',

    [Parameter()]
    [string]$CorrelationId = '',

    [Parameter()]
    [string]$JobId = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Remove-SharingLinks.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
if ($JobFile) {
    $job = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
    $TenantId = [string]$job.tenantId
    $Links = @($job.links)
    if (-not $TenantId) { throw "job envelope '$JobFile' is missing 'tenantId'" }
    if (-not $Links -or $Links.Count -eq 0) { throw "job envelope '$JobFile' is missing 'links'" }
    if ($job.mode) { $Mode = [string]$job.mode }
    if ($null -ne $job.confirmCount) { $ConfirmCount = [int]$job.confirmCount }
    if ($job.actor) { $Actor = [string]$job.actor }
    if ($job.correlationId) { $CorrelationId = [string]$job.correlationId }
    if ($job.jobId) { $JobId = [string]$job.jobId }
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $params = @{
        TenantId = $TenantId
        Links    = $Links
        Mode     = $Mode
    }
    if ($ConfirmCount -ge 0) { $params['ConfirmCount'] = $ConfirmCount }
    if ($Actor) { $params['Actor'] = $Actor }
    if ($CorrelationId) { $params['CorrelationId'] = $CorrelationId }
    if ($JobId) { $params['JobId'] = $JobId }
    $result = Remove-SharingLinks @params
    $result | ConvertTo-Json -Depth 12 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
