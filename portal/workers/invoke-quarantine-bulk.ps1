<#
.SYNOPSIS
    Worker entrypoint for the EPIC-022 capped bulk quarantine release/delete.
.DESCRIPTION
    Reads a job envelope from -JobFile (or a tenant, action, and messages
    directly), executes the capped batch live against Exchange Online via
    Invoke-QuarantineBulk, and emits the result as JSON on stdout. The
    supervisor connects EXO in this child process after materializing the
    tenant credential before invoking this script, so no secret handling lives
    here. -DryRun plans the batch with no tenant write; release, release-to-all,
    and delete additionally require -Confirm. Each item runs through the T-0424
    typed executor and the EPIC-006 gate; a failure on one message is reported
    per message without aborting the rest.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    Bulk quarantine action: release, releaseAll, or delete.
.PARAMETER Messages
    Planned message objects with messageId, recipient, sender, and subject.
.PARAMETER Cap
    Per-action cap for a direct-parameter run.
.PARAMETER DryRun
    Report the intended batch without writing to the tenant.
.PARAMETER Confirm
    Explicit confirmation for the whole batch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-quarantine-bulk.ps1 -JobFile './run/quarantine-bulk-job.json'
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByDirect')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByDirect')]
    [string]$Action,

    [Parameter(Mandatory, ParameterSetName = 'ByDirect')]
    [AllowEmptyCollection()]
    [array]$Messages,

    [Parameter(ParameterSetName = 'ByDirect')]
    [int]$Cap = 0,

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirm
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-QuarantineBulk.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    $Actor = ''
    $CorrelationId = ''
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-QuarantineBulkJob -Path $JobFile
        $TenantId = $job['TenantId']
        $Action = $job['Action']
        $Messages = $job['Messages']
        if ($job['Cap'] -gt 0) {
            $Cap = [int]$job['Cap']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
        if (-not $PSBoundParameters.ContainsKey('Confirm')) {
            $Confirm = [bool]$job['Confirmed']
        }
        $Actor = $job['Actor']
        $CorrelationId = $job['CorrelationId']
    }

    $invokeParams = @{
        TenantId      = $TenantId
        Action        = $Action
        Messages      = $Messages
        Cap           = $Cap
        DryRun        = [bool]$DryRun
        Confirmed     = [bool]$Confirm
        Actor         = $Actor
        CorrelationId = $CorrelationId
    }
    $result = Invoke-QuarantineBulk @invokeParams
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
