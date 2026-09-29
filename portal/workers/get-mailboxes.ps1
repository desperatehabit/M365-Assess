<#
.SYNOPSIS
    Worker entrypoint for the EPIC-020 mailbox list and detail read.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or a tenant id directly),
    reads the mailboxes live from Exchange Online via Get-Mailboxes, and emits
    the filtered cursor page as JSON on stdout. With -MailboxId (or a payload
    mailboxId) the off-canvas detail (settings, permissions, calendar
    permissions, rules) is emitted instead. Stdout is the response transport;
    mailbox objects are never mirrored to disk. The supervisor connects EXO in
    this child process after materializing the tenant credential (T-0011)
    before invoking this script, so no secret handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER MailboxId
    Direct mailbox identity for detail runs without a job envelope.
.PARAMETER Search
    Case-insensitive substring match against display name and primary SMTP.
.PARAMETER Type
    Filter by mailbox type: user, shared, room, or equipment.
.PARAMETER Hold
    'true' keeps held mailboxes, 'false' the rest, empty both.
.PARAMETER Forwarding
    'true' keeps forwarded mailboxes, 'false' the rest, empty both.
.PARAMETER Archive
    'true' keeps archive-enabled mailboxes, 'false' the rest, empty both.
.PARAMETER QuotaPercent
    Keeps mailboxes at or above this quota percent. 0 disables.
.PARAMETER InactiveDays
    Keeps mailboxes inactive longer than this many days, or never active.
.PARAMETER Top
    Page size.
.PARAMETER Cursor
    Opaque page cursor from a previous result.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-mailboxes.ps1 -JobFile './run/mailboxes-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/get-mailboxes.ps1 -TenantId 'tenant-a' -Type 'shared'
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$MailboxId = '',

    [Parameter()]
    [string]$Search = '',

    [Parameter()]
    [ValidateSet('', 'user', 'shared', 'room', 'equipment')]
    [string]$Type = '',

    [Parameter()]
    [ValidateSet('', 'true', 'false')]
    [string]$Hold = '',

    [Parameter()]
    [ValidateSet('', 'true', 'false')]
    [string]$Forwarding = '',

    [Parameter()]
    [ValidateSet('', 'true', 'false')]
    [string]$Archive = '',

    [Parameter()]
    [ValidateRange(0, 100)]
    [int]$QuotaPercent = 0,

    [Parameter()]
    [ValidateRange(0, 3650)]
    [int]$InactiveDays = 0,

    [Parameter()]
    [ValidateRange(1, 999)]
    [int]$Top = 100,

    [Parameter()]
    [string]$Cursor = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Get-Mailboxes.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-MailboxesJob -Path $JobFile
        $TenantId = $job['TenantId']
        foreach ($name in @('MailboxId', 'Search', 'Type', 'Hold', 'Forwarding', 'Archive', 'QuotaPercent', 'InactiveDays', 'Top', 'Cursor')) {
            if (-not $PSBoundParameters.ContainsKey($name)) {
                Set-Variable -Name $name -Value $job[$name]
            }
        }
    }

    if ($MailboxId.Trim().Length -gt 0) {
        $result = Get-MailboxDetail -TenantId $TenantId -MailboxId $MailboxId
    }
    else {
        $invokeParams = @{
            TenantId     = $TenantId
            Search       = $Search
            Type         = $Type
            Hold         = $Hold
            Forwarding   = $Forwarding
            Archive      = $Archive
            QuotaPercent = $QuotaPercent
            InactiveDays = $InactiveDays
            Top          = $Top
            Cursor       = $Cursor
        }

        $result = Get-Mailboxes @invokeParams
    }
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
