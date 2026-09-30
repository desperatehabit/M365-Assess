<#
.SYNOPSIS
    Worker entrypoint for the EPIC-022 quarantine release/delete actions.
.DESCRIPTION
    Reads a job envelope from -JobFile (or a tenant, message, and action
    directly), executes the quarantine action live against Exchange Online via
    Invoke-QuarantineAction, and emits the result as JSON on stdout. The
    supervisor connects EXO in this child process after materializing the
    tenant credential before invoking this script, so no secret handling
    lives here. -DryRun plans the action with no tenant write; release,
    release-to-all, and delete additionally require -Confirm. Per SPEC §11.1,
    release/delete use the EXO quarantine cmdlets and metadata-only actions
    fall back to Graph.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER MessageId
    Direct quarantined message id for runs without a job envelope.
.PARAMETER Action
    Quarantine action: release, releaseAll, delete, or preview.
.PARAMETER Recipient
    Release-to recipient for a release action.
.PARAMETER SenderAddress
    Message sender metadata for preview.
.PARAMETER Subject
    Message subject metadata for preview.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirm
    Explicit confirmation for release, release-to-all, and delete.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-quarantine-action.ps1 -JobFile './run/quarantine-action-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-quarantine-action.ps1 -TenantId 'tenant-a' -MessageId 'message-1' -Action 'delete' -Confirm
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
    [string]$MessageId,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Recipient = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$SenderAddress = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Subject = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirm
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-QuarantineAction.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-QuarantineActionJob -Path $JobFile
        $TenantId = $job['TenantId']
        $MessageId = $job['MessageId']
        $Action = $job['Action']
        $Recipient = $job['Recipient']
        $SenderAddress = $job['Sender']
        $Subject = $job['Subject']
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
        if (-not $PSBoundParameters.ContainsKey('Confirm')) {
            $Confirm = [bool]$job['Confirmed']
        }
        $Actor = $job['Actor']
        $CorrelationId = $job['CorrelationId']
    }

    $result = Invoke-QuarantineAction -TenantId $TenantId -MessageId $MessageId -Action $Action -Recipient $Recipient -SenderAddress $SenderAddress -Subject $Subject -DryRun:$DryRun -Confirmed:$Confirm -Actor $Actor -CorrelationId $CorrelationId
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
