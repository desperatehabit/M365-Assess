<#
.SYNOPSIS
    Worker entrypoint for the EPIC-022 tenant allow/block list write.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly),
    executes or previews an allow/block entry create/edit/delete, and emits
    JSON on stdout. Stdout is the response transport; allow/block entries are
    never mirrored to disk. The supervisor connects EXO in this child process
    after materializing the tenant credential (T-0011) before invoking this
    script, so no secret handling lives here.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Type
    Direct entry type for runs without a job envelope: sender, domain, url,
    or file.
.PARAMETER Action
    Direct change action for runs without a job envelope: create, edit, or
    delete.
.PARAMETER Value
    Direct entry value for runs without a job envelope.
.PARAMETER EntryAction
    Direct allow/block action for runs without a job envelope.
.PARAMETER ExpiresOn
    Direct optional expiry (ISO date) for runs without a job envelope.
.PARAMETER Notes
    Direct optional notes for runs without a job envelope.
.PARAMETER DryRun
    Direct dry-run flag for runs without a job envelope.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-allow-block-entry.ps1 -JobFile './run/set-allow-block-entry-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-allow-block-entry.ps1 -TenantId 'tenant-a' -Type 'sender' -Action 'create' -Value 'bad.example' -EntryAction 'block'
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateSet('sender', 'domain', 'url', 'file')]
    [string]$Type,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateSet('create', 'edit', 'delete')]
    [string]$Action,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateNotNullOrEmpty()]
    [string]$Value,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateSet('allow', 'block')]
    [string]$EntryAction,

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$ExpiresOn = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$Notes = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-AllowBlockEntry.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SetAllowBlockEntryJob -Path $JobFile
        $TenantId    = $job['TenantId']
        $Type        = $job['Type']
        $Action      = $job['Action']
        $Value       = $job['Value']
        $EntryAction = $job['EntryAction']
        $ExpiresOn   = $job['ExpiresOn']
        $Notes       = $job['Notes']
        $DryRun      = $job['DryRun']
    }

    $result = Invoke-SetAllowBlockEntry -TenantId $TenantId -Type $Type -Action $Action -Value $Value -EntryAction $EntryAction -ExpiresOn $ExpiresOn -Notes $Notes -DryRun $DryRun
    $result | ConvertTo-Json -Depth 10 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
