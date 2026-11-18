<#
.SYNOPSIS
    Worker entrypoint for the EPIC-022 tenant allow/block list read.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or direct parameters), reads
    tenant allow/block list entries live from Exchange Online via Get-AllowBlock,
    and emits the result as JSON on stdout. Stdout is the response transport;
    entries are never mirrored to disk. The supervisor connects EXO in this
    child process after materializing the tenant credential before invoking this
    script, so no secret handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Type
    Optional entry type filter: sender, domain, url, or file.
.PARAMETER Action
    Optional entry action filter: allow or block.
.PARAMETER Value
    Optional case-insensitive value filter.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-allow-block.ps1 -JobFile './run/allow-block-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-allow-block.ps1 -TenantId 'tenant-a' -Type 'domain'
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
    [string]$Type = '',

    [Parameter()]
    [string]$Action = '',

    [Parameter()]
    [string]$Value = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-AllowBlock.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-AllowBlockJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('Type', 'Action', 'Value')) {
            if (-not $PSBoundParameters.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    $invokeParams = @{
        TenantId = $TenantId
        Type     = $Type
        Action   = $Action
        Value    = $Value
    }

    $result = Get-AllowBlock @invokeParams
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
