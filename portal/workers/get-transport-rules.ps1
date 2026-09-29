<#
.SYNOPSIS
    Worker entrypoint for the EPIC-021 transport rules list read.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or a tenant id directly),
    reads the transport rules live from Exchange Online via Get-TransportRules,
    and emits the filtered cursor page as JSON on stdout. Stdout is the
    response transport; transport-rule state is never persisted. The supervisor
    connects EXO in this child process after materializing the tenant
    credential (T-0011) before invoking this script, so no secret handling
    lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Search
    Case-insensitive substring match against the rule name.
.PARAMETER State
    Filter by rule state: enabled, disabled, or empty for all.
.PARAMETER Top
    Page size.
.PARAMETER Cursor
    Opaque page cursor from a previous result.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-transport-rules.ps1 -JobFile './run/transport-rules-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-transport-rules.ps1 -TenantId 'tenant-a' -State 'enabled'
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
    [ValidateSet('', 'enabled', 'disabled')]
    [string]$State = '',

    [Parameter()]
    [ValidateRange(1, 999)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-TransportRules.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-TransportRulesJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('Search', 'State', 'Top', 'Cursor')) {
            if (-not $PSBoundParameters.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    $invokeParams = @{
        TenantId = $TenantId
        Search   = $Search
        State    = $State
        Top      = $Top
        Cursor   = $Cursor
    }

    $result = Get-TransportRules @invokeParams
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
