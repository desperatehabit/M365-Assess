<#
.SYNOPSIS
    Worker entrypoint for the EPIC-022 quarantine policies read.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or direct parameters), reads
    quarantine notification and permission policies live from Exchange Online
    via Get-QuarantinePolicies, and emits the result as JSON on stdout. Stdout
    is the response transport; policies are never mirrored to disk. The
    supervisor connects EXO in this child process after materializing the tenant
    credential before invoking this script, so no secret handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER PolicyType
    Optional policy type filter: notification or permission.
.PARAMETER PolicyName
    Optional policy name filter.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-quarantine-policies.ps1 -JobFile './run/quarantine-policies-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-quarantine-policies.ps1 -TenantId 'tenant-a' -PolicyType 'notification'
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
    [string]$PolicyType = '',

    [Parameter()]
    [string]$PolicyName = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-QuarantinePolicies.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-QuarantinePoliciesJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('PolicyType', 'PolicyName')) {
            if (-not $PSBoundParameters.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    $invokeParams = @{
        TenantId   = $TenantId
        PolicyType = $PolicyType
        PolicyName = $PolicyName
    }

    $result = Get-QuarantinePolicies @invokeParams
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
