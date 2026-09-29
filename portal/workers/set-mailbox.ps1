<#
.SYNOPSIS
    Worker entrypoint for EPIC-020 shared-mailbox create/convert.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    executes or previews shared-mailbox create/convert via Invoke-SetMailbox,
    and emits the JSON envelope on stdout. A convert of an already-shared
    mailbox returns a structured no-op with no EXO write. The supervisor
    connects EXO in this child process after materializing the tenant
    credential (T-0011) before invoking this script, so no secret handling
    lives here. -DryRun plans with no tenant write; apply requires -Confirmed.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    'create' provisions a shared mailbox; 'convert' converts one to shared.
.PARAMETER MailboxId
    Direct mailbox identity for convert runs without a job envelope.
.PARAMETER DisplayName
    Display name for create runs without a job envelope.
.PARAMETER Alias
    Alias for create runs without a job envelope.
.PARAMETER PrimarySmtpAddress
    Primary SMTP address for create runs without a job envelope.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-mailbox.ps1 -JobFile './run/mailbox-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-mailbox.ps1 -TenantId 'tenant-a' -Action 'convert' -MailboxId 'mbx-2' -Confirmed -DryRun
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
    [ValidateSet('create', 'convert')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$MailboxId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$DisplayName = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Alias = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$PrimarySmtpAddress = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-Mailbox.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SetMailboxJob -Path $JobFile
        $TenantId           = $job['TenantId']
        $Action             = $job['Action']
        $MailboxId          = $job['MailboxId']
        $DisplayName        = $job['DisplayName']
        $Alias              = $job['Alias']
        $PrimarySmtpAddress = $job['PrimarySmtpAddress']
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }

    $invokeParams = @{
        TenantId           = $TenantId
        Action             = $Action
        MailboxId          = $MailboxId
        DisplayName        = $DisplayName
        Alias              = $Alias
        PrimarySmtpAddress = $PrimarySmtpAddress
        DryRun             = [bool]$DryRun
        Confirmed          = [bool]$Confirmed
    }

    $result = Invoke-SetMailbox @invokeParams
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
