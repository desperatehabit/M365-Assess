<#
.SYNOPSIS
    Worker entrypoint for EPIC-030 Purview sensitivity-label and SIT read.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    connects app-only to Purview via the T-0582 session seam, reads sensitivity
    labels (Get-PurviewLabels) or sensitive information types (Get-PurviewSits)
    live, and emits the filtered cursor page as JSON on stdout. The worker is
    read-only.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
.PARAMETER TenantId
    Direct tenant id.
.PARAMETER Kind
    Which collection to read: labels (default) or sits.
.PARAMETER Search
    Case-insensitive substring match against the name.
.PARAMETER State
    Label state filter: enabled, disabled, or empty for all.
.PARAMETER Type
    SIT type filter: builtin, custom, or empty for all.
.PARAMETER Top
    Page size.
.PARAMETER Cursor
    Opaque page cursor from a previous result.
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
    [ValidateSet('labels', 'sits')]
    [string]$Kind = 'labels',

    [Parameter()]
    [string]$Search = '',

    [Parameter()]
    [ValidateSet('', 'enabled', 'disabled')]
    [string]$State = '',

    [Parameter()]
    [ValidateSet('', 'builtin', 'custom')]
    [string]$Type = '',

    [Parameter()]
    [ValidateRange(1, 1000)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-PurviewLabels.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerPurview -JobFile $JobFile
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-PurviewLabelsJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('Kind', 'Search', 'State', 'Type', 'Top', 'Cursor')) {
            if (-not $PSBoundParameters.ContainsKey($name) -and $job.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    $invokeParams = @{
        TenantId = $TenantId
        Search   = $Search
        Top      = $Top
        Cursor   = $Cursor
    }

    if ($Kind -eq 'sits') {
        $invokeParams['Type'] = $Type
        $result = Get-PurviewSits @invokeParams
    }
    else {
        $invokeParams['State'] = $State
        $result = Get-PurviewLabels @invokeParams
    }

    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerPurview -Session $tenantSession
}
