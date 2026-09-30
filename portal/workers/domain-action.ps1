<#
.SYNOPSIS
    Worker entrypoint for the EPIC-034 domain management actions.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or a tenant, domain, and action
    directly), dispatches through Invoke-DomainAction, and emits the result as
    JSON on stdout. Stdout is the response transport; user data is never
    mirrored to disk. The supervisor connects Graph in this child process
    after materializing the tenant credential (T-0011) before invoking this
    script, so no secret handling lives here. -DryRun plans the action with
    no tenant write; apply requires -Confirmed.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Domain
    The domain name the action targets.
.PARAMETER Action
    add, verify, remove, or setDefault.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for the tenant write.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/domain-action.ps1 -JobFile './run/domain-action-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/domain-action.ps1 -TenantId 'tenant-a' -Domain 'contoso.com' -Action 'add' -Confirmed
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$Domain,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateSet('add', 'verify', 'remove', 'setDefault')]
    [string]$Action,

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-DomainAction.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
$Actor = ''
$Reason = ''
$CorrelationId = ''
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-DomainActionJob -Path $JobFile
        $TenantId = $job['TenantId']
        $Domain = $job['Domain']
        $Action = $job['Action']
        $Actor = $job['Actor']
        $Reason = $job['Reason']
        $CorrelationId = $job['CorrelationId']
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
    }

    $result = Invoke-DomainAction -TenantId $TenantId -Domain $Domain -Action $Action -DryRun:$DryRun -Confirmed:$Confirmed -Actor $Actor -CorrelationId $CorrelationId -Reason $Reason
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
