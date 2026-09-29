# get-incident-detail.ps1 - worker entrypoint for incident detail retrieval.
#
# Emits the Get-IncidentDetail response object as JSON on stdout. The worker is
# read-only. The BFF runs it with -JobFile (tenantId, incidentId, the
# credential block for Connect-WorkerTenant, and the T-0541 persisted portal
# notes and triage state changes to merge, T-0545); -TenantId/-IncidentId
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
    [string]$IncidentId
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-IncidentDetail.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
$portalNotes = @()
$stateChanges = @()
if ($JobFile) {
    $job = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
    $TenantId = [string]$job.tenantId
    $IncidentId = [string]$job.incidentId
    if (-not $IncidentId) { throw "job envelope '$JobFile' is missing 'incidentId'" }
    if ($job.portalNotes) { $portalNotes = @($job.portalNotes) }
    if ($job.stateChanges) { $stateChanges = @($job.stateChanges) }
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $result = Get-IncidentDetail -TenantId $TenantId -IncidentId $IncidentId -PortalNotes $portalNotes -StateChanges $stateChanges
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
