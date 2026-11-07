<#
.SYNOPSIS
    Worker entrypoint for the EPIC-021 connector list read.
.DESCRIPTION
    Reads a flat job envelope from -JobFile (or a tenant id directly), reads the
    inbound and outbound connectors live from Exchange Online via Get-Connectors,
    and emits the filtered cursor page as JSON on stdout. Stdout is the response
    transport; connector state is never persisted. The supervisor connects EXO in
    this child process after materializing the tenant credential (T-0011) before
    invoking this script, so no secret handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Search
    Case-insensitive substring match against the connector name.
.PARAMETER Type
    Filter by connector type: inbound, outbound, or empty for all.
.PARAMETER State
    Filter by connector state: enabled, disabled, or empty for all.
.PARAMETER Top
    Page size.
.PARAMETER Cursor
    Opaque page cursor from a previous result.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-connectors.ps1 -JobFile './run/connectors-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-connectors.ps1 -TenantId 'tenant-a' -Type 'inbound'
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
    [ValidateSet('', 'inbound', 'outbound')]
    [string]$Type = '',

    [Parameter()]
    [ValidateSet('', 'enabled', 'disabled')]
    [string]$State = '',

    [Parameter()]
    [ValidateRange(1, 999)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-Connectors.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-ConnectorsJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('Search', 'Type', 'State', 'Top', 'Cursor')) {
            if (-not $PSBoundParameters.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    $invokeParams = @{
        TenantId = $TenantId
        Search   = $Search
        Type     = $Type
        State    = $State
        Top      = $Top
        Cursor   = $Cursor
    }

    $result = Get-Connectors @invokeParams
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
