<#
.SYNOPSIS
    Worker entrypoint for the EPIC-020 soft-deleted mailbox view plus restore.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    lists soft-deleted mailboxes live from Exchange Online via
    Get-DeletedMailboxes, or previews/applies one restore via
    Invoke-RestoreMailbox, and emits the JSON envelope on stdout. Stdout is
    the response transport; mailbox objects are never mirrored to disk. The
    supervisor connects EXO in this child process after materializing the
    tenant credential (T-0011) before invoking this script, so no secret
    handling lives here. -DryRun plans with no tenant write; restore apply
    requires -Confirmed.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    'list' returns the soft-deleted mailbox page; 'restore' restores one.
.PARAMETER MailboxId
    Direct soft-deleted mailbox identity for restore runs without a job envelope.
.PARAMETER Search
    Case-insensitive substring match against display name and primary SMTP.
.PARAMETER Top
    Page size for list runs.
.PARAMETER Cursor
    Opaque page cursor from a previous list result.
.PARAMETER DryRun
    Report the intended restore without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for restore apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/restore-mailbox.ps1 -JobFile './run/restore-mailbox-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/restore-mailbox.ps1 -TenantId 'tenant-a' -Action 'restore' -MailboxId 'mbx-deleted-1' -Confirmed -DryRun
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
    [ValidateSet('list', 'restore')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$MailboxId = '',

    [Parameter()]
    [string]$Search = '',

    [Parameter()]
    [ValidateRange(1, 999)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Restore-Mailbox.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-RestoreMailboxJob -Path $JobFile
        $TenantId = $job['TenantId']
        $Action   = $job['Action']
        $MailboxId = $job['MailboxId']
        if (-not $PSBoundParameters.ContainsKey('Search')) {
            $Search = $job['Search']
        }
        if (-not $PSBoundParameters.ContainsKey('Top')) {
            $Top = $job['Top']
        }
        if (-not $PSBoundParameters.ContainsKey('Cursor')) {
            $Cursor = $job['Cursor']
        }
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }

    if ($Action -eq 'restore') {
        $result = Invoke-RestoreMailbox -TenantId $TenantId -MailboxId $MailboxId -DryRun ([bool]$DryRun) -Confirmed ([bool]$Confirmed)
    }
    else {
        $result = Get-DeletedMailboxes -TenantId $TenantId -Search $Search -Top $Top -Cursor $Cursor
    }
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
