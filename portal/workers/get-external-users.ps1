<#
.SYNOPSIS
    Worker entrypoint for the EPIC-027 SharePoint external-users report.
.DESCRIPTION
    Reads a feature job envelope from -JobFile (tenant id, search, drill-through
    user, and pagination fields), aggregates external users live from Graph via
    Get-ExternalUsers, and emits the cursor page as JSON on stdout. With
    -ExternalUserId it emits the sites/items that one user can access instead.
    With -TenantId the report is read directly for manual runs that manage their
    own session. Stdout is the response transport; nothing is mirrored to disk.
    The supervisor connects Graph in this child process after materializing the
    tenant credential (T-0011) before invoking this script, so no secret
    handling lives here. Read-only: only GET requests are issued.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Search
    Case-insensitive substring match against external-user display name and email.
.PARAMETER ExternalUserId
    Drill through to the sites/items this external user can access.
.PARAMETER Top
    Page size.
.PARAMETER Cursor
    Opaque page cursor from a previous result.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-external-users.ps1 -JobFile './run/external-users-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-external-users.ps1 -TenantId 'tenant-a' -Search 'partner'
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
    [string]$Search = '',

    [Parameter()]
    [string]$ExternalUserId = '',

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-ExternalUsers.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $job = Read-ExternalUsersJob -Path $JobFile
    $TenantId = $job['TenantId']
    foreach ($name in @('Search', 'ExternalUserId', 'Top', 'Cursor')) {
        if (-not $PSBoundParameters.ContainsKey($name)) {
            Set-Variable -Name $name -Value $job[$name]
        }
    }
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if (-not [string]::IsNullOrWhiteSpace($ExternalUserId)) {
        $result = Get-ExternalUserAccess -TenantId $TenantId -ExternalUserId $ExternalUserId -Top $Top -Cursor $Cursor
    }
    else {
        $result = Get-ExternalUsers -TenantId $TenantId -Search $Search -Top $Top -Cursor $Cursor
    }
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
