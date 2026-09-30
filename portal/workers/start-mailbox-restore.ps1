<#
.SYNOPSIS
    Worker entrypoint for the EPIC-024 mailbox restore.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly), builds
    the restore plan preview or applies the restore live against Exchange
    Online, and emits the JSON envelope on stdout. Stdout is the response
    transport; the RestoreJob state and before/after item counts are returned
    for the BFF to persist through the repository (T-0461) — mailbox contents
    are never mirrored to disk. The supervisor connects EXO in this child
    process after materializing the tenant credential (T-0011) before invoking
    this script, so no secret handling lives here. -DryRun (and -Action plan)
    plans with no tenant write; apply requires -Confirmed. Progress events flow
    on stderr; audit records flow to the app audit sink through -WriteAudit.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    'plan' returns the restore plan preview; 'apply' performs the restore.
.PARAMETER JobId
    Direct RestoreJob id for runs without a job envelope.
.PARAMETER MailboxId
    Direct mailbox identity for runs without a job envelope.
.PARAMETER Scope
    'mailbox' (whole mailbox, default), 'items', or 'date'.
.PARAMETER Target
    Target mailbox for item-level scopes.
.PARAMETER Query
    Optional item filter for scope 'items'.
.PARAMETER StartDate
    Optional window start for scope 'date'.
.PARAMETER EndDate
    Optional window end for scope 'date'.
.PARAMETER CreatedBy
    Actor that requested the restore.
.PARAMETER DryRun
    Report the intended restore without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/start-mailbox-restore.ps1 -JobFile './run/mailbox-restore-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/start-mailbox-restore.ps1 -TenantId 'tenant-a' -Action 'plan' -MailboxId 'mbx-1' -Scope 'mailbox'
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
    [ValidateSet('plan', 'apply')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$JobId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$MailboxId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [ValidateSet('mailbox', 'items', 'date')]
    [string]$Scope = 'mailbox',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Target = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Query = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$StartDate = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$EndDate = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$CreatedBy = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Start-MailboxRestore.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-MailboxRestoreJob -Path $JobFile
        $TenantId = $job['TenantId']
        $Action = $job['Action']
        $JobId = $job['JobId']
        $MailboxId = $job['MailboxId']
        $Scope = $job['Scope']
        $Target = $job['Target']
        $Query = $job['Query']
        $StartDate = $job['StartDate']
        $EndDate = $job['EndDate']
        $CreatedBy = $job['CreatedBy']
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }

    if ([string]::IsNullOrWhiteSpace($MailboxId)) {
        throw "mailbox.restore_invalid_mailbox: a mailbox id is required"
    }

    $isDryRun = ($Action -eq 'plan') -or [bool]$DryRun
    $result = Start-MailboxRestore -TenantId $TenantId -JobId $JobId -MailboxId $MailboxId -Scope $Scope -Target $Target -Query $Query -StartDate $StartDate -EndDate $EndDate -CreatedBy $CreatedBy -DryRun $isDryRun -Confirmed ([bool]$Confirmed)
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
