<#
.SYNOPSIS
    Worker entrypoint for the EPIC-025 SharePoint site list.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    queries sites live from Graph via Get-SharePointSites, and emits the
    filtered cursor page as JSON on stdout. The worker is read-only.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id.
.PARAMETER Type
    Site type filter (team, communication).
.PARAMETER Sharing
    External sharing filter (disabled, externalUserSharingOnly,
    externalUserAndGuestSharing, existingExternalUserSharingOnly).
.PARAMETER StoragePercent
    Minimum storage-used percent of the site quota.
.PARAMETER LastActivity
    Only sites active on or after this date.
.PARAMETER Sensitivity
    Sensitivity label filter ('none' matches unlabeled sites).
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
    [ValidateSet('', 'team', 'communication')]
    [string]$Type = '',

    [Parameter()]
    [string]$Sharing = '',

    [Parameter()]
    [string]$StoragePercent = '',

    [Parameter()]
    [string]$LastActivity = '',

    [Parameter()]
    [string]$Sensitivity = '',

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-SharePointSites.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SharePointSitesJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('Type', 'Sharing', 'StoragePercent', 'LastActivity', 'Sensitivity', 'Top', 'Cursor')) {
            if (-not $PSBoundParameters.ContainsKey($name) -and $job.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    $invokeParams = @{
        TenantId       = $TenantId
        Type           = $Type
        Sharing        = $Sharing
        StoragePercent = $StoragePercent
        LastActivity   = $LastActivity
        Sensitivity    = $Sensitivity
        Top            = $Top
        Cursor         = $Cursor
    }

    $result = Get-SharePointSites @invokeParams
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
