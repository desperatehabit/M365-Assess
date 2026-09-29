<#
.SYNOPSIS
    Worker entrypoint for EPIC-020 mailbox settings (quota, archive, holds, locale, limits, calendar, GAL).
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    executes or previews mailbox settings via Invoke-SetMailboxSettings, and
    emits the JSON envelope on stdout. Settings that already match return a
    structured no-op with no EXO write. The supervisor connects EXO in this
    child process after materializing the tenant credential (T-0011) before
    invoking this script, so no secret handling lives here. -DryRun plans with
    no tenant write; apply requires -Confirmed, and archive or hold changes
    always require explicit confirmation.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER MailboxId
    Direct mailbox identity for runs without a job envelope.
.PARAMETER SettingsJson
    Planned settings as a JSON object for runs without a job envelope.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-mailbox-settings.ps1 -JobFile './run/mailbox-settings-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-mailbox-settings.ps1 -TenantId 'tenant-a' -MailboxId 'mbx-2' -SettingsJson '{"prohibitSendQuota":"50 GB"}' -Confirmed -DryRun
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
    [string]$MailboxId,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$SettingsJson,

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-MailboxSettings.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SetMailboxSettingsJob -Path $JobFile
        $TenantId  = $job['TenantId']
        $MailboxId = $job['MailboxId']
        $settings  = $job['Settings']
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }
    else {
        $parsed = $SettingsJson | ConvertFrom-Json -AsHashtable
        $settings = @{}
        foreach ($key in @($parsed.Keys)) {
            $settings[[string]$key] = $parsed[$key]
        }
    }

    $result = Invoke-SetMailboxSettings -TenantId $TenantId -MailboxId $MailboxId -Settings $settings -DryRun ([bool]$DryRun) -Confirmed ([bool]$Confirmed)
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
