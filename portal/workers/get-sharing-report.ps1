<#
.SYNOPSIS
    Worker entrypoint for the EPIC-027 sharing-links report.
.DESCRIPTION
    Reads a job envelope from -JobFile (or parameters directly), enumerates the
    tenant's sharing links live from Graph via Get-SharingReport, and emits the
    filtered cursor page as JSON on stdout. The worker is read-only.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id.
.PARAMETER LinkType
    Link-type filter (anonymous, organization, people).
.PARAMETER Permissions
    Permission filter (view, edit).
.PARAMETER Site
    Site id, name, or URL substring filter.
.PARAMETER CreatedAfter
    Only links created on or after this date-time.
.PARAMETER AnonymousOnly
    When set, only anonymous links are returned.
.PARAMETER Top
    Page size (1-1000, default 100).
.PARAMETER Cursor
    Opaque cursor from a previous page.
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
    [ValidateSet('', 'anonymous', 'organization', 'people')]
    [string]$LinkType = '',

    [Parameter()]
    [ValidateSet('', 'view', 'edit')]
    [string]$Permissions = '',

    [Parameter()]
    [string]$Site = '',

    [Parameter()]
    [string]$CreatedAfter = '',

    [Parameter()]
    [switch]$AnonymousOnly,

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-SharingReport.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SharingReportJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('LinkType', 'Permissions', 'Site', 'CreatedAfter', 'AnonymousOnly', 'Top', 'Cursor')) {
            if (-not $PSBoundParameters.ContainsKey($name) -and $job.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    $invokeParams = @{
        TenantId      = $TenantId
        LinkType      = $LinkType
        Permissions   = $Permissions
        Site          = $Site
        CreatedAfter  = $CreatedAfter
        AnonymousOnly = [bool]$AnonymousOnly
        Top           = $Top
        Cursor        = $Cursor
    }

    $result = Get-SharingReport @invokeParams
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
