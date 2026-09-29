<#
.SYNOPSIS
    Worker entrypoint for EPIC-020 vacation mode enable/revert.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    executes or previews vacation OoO + forwarding enable/revert via
    Invoke-VacationSchedule, and emits the JSON envelope on stdout. A revert of
    an already-reverted mailbox returns a structured no-op with no EXO write;
    a failed revert is returned as success false with scheduleState failed and
    an alert event so the failure is recorded and raises an alert instead of
    silently ending. The supervisor connects EXO in this child process after
    materializing the tenant credential (T-0011) before invoking this script,
    so no secret handling lives here. -DryRun plans with no tenant write;
    apply requires -Confirmed.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Phase
    'enable' applies OoO + forwarding; 'revert' disables them.
.PARAMETER ScheduleId
    Direct vacation schedule id for runs without a job envelope.
.PARAMETER MailboxId
    Direct mailbox identity for runs without a job envelope.
.PARAMETER StartsAt
    Window start (ISO-8601) for runs without a job envelope.
.PARAMETER EndsAt
    Window end (ISO-8601) for runs without a job envelope.
.PARAMETER OooMessage
    Out-of-office message for enable runs without a job envelope.
.PARAMETER ForwardTo
    Forwarding target for enable runs without a job envelope.
.PARAMETER NotAfter
    Apply bound for runs without a job envelope; enable past it is skipped.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-vacation-schedule.ps1 -JobFile './run/vacation-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-vacation-schedule.ps1 -TenantId 'tenant-a' -Phase 'revert' -ScheduleId 'vac-1' -MailboxId 'mbx-1' -StartsAt '2026-10-01T00:00:00Z' -EndsAt '2026-10-08T00:00:00Z' -Confirmed -DryRun
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
    [ValidateSet('enable', 'revert')]
    [string]$Phase,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$ScheduleId,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$MailboxId,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$StartsAt = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$EndsAt = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$OooMessage = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$ForwardTo = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$NotAfter = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-VacationSchedule.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-VacationScheduleJob -Path $JobFile
        $TenantId   = $job['TenantId']
        $Phase      = $job['Phase']
        $ScheduleId = $job['ScheduleId']
        $MailboxId  = $job['MailboxId']
        $StartsAt   = $job['StartsAt']
        $EndsAt     = $job['EndsAt']
        $OooMessage = $job['OooMessage']
        $ForwardTo  = $job['ForwardTo']
        $NotAfter   = $job['NotAfter']
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }

    $invokeParams = @{
        TenantId   = $TenantId
        Phase      = $Phase
        ScheduleId = $ScheduleId
        MailboxId  = $MailboxId
        StartsAt   = $StartsAt
        EndsAt     = $EndsAt
        OooMessage = $OooMessage
        ForwardTo  = $ForwardTo
        NotAfter   = $NotAfter
        DryRun     = [bool]$DryRun
        Confirmed  = [bool]$Confirmed
    }

    $result = Invoke-VacationSchedule @invokeParams
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
