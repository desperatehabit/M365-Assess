<#
.SYNOPSIS
    Worker entrypoint for the EPIC-027 site/OneDrive permissions report read.
.DESCRIPTION
    Reads a feature job envelope from -JobFile (tenant id, role, principal type,
    and pagination fields), reads the permissions live from Graph via
    Get-PermissionsReport, and emits the cursor page as JSON on stdout. With
    -TenantId the report is read directly for manual runs that manage their own
    session. Stdout is the response transport; permission objects are never
    mirrored to disk. The supervisor connects Graph in this child process after
    materializing the tenant credential (T-0011) before invoking this script, so
    no secret handling lives here. Read-only: only GET requests are issued.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Role
    Case-insensitive exact match against a row's roles (read/write/owner/...).
.PARAMETER PrincipalType
    user, group, or servicePrincipal.
.PARAMETER Top
    Page size.
.PARAMETER Cursor
    Opaque page cursor from a previous result.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-permissions-report.ps1 -JobFile './run/permissions-report-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-permissions-report.ps1 -TenantId 'tenant-a' -Role 'owner'
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
    [string]$Role = '',

    [Parameter()]
    [ValidateSet('', 'user', 'group', 'servicePrincipal')]
    [string]$PrincipalType = '',

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-PermissionsReport.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $job = Read-PermissionsReportJob -Path $JobFile
    $TenantId = $job['TenantId']
    foreach ($name in @('Role', 'PrincipalType', 'Top', 'Cursor')) {
        if (-not $PSBoundParameters.ContainsKey($name)) {
            Set-Variable -Name $name -Value $job[$name]
        }
    }
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $result = Get-PermissionsReport -TenantId $TenantId -Role $Role -PrincipalType $PrincipalType -Top $Top -Cursor $Cursor
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
