<#
.SYNOPSIS
    Worker entrypoint for the EPIC-023 contacts write actions.
.DESCRIPTION
    Reads a job envelope from -JobFile (or a tenant, contact, and action
    directly), executes the contact action live against Exchange Online via
    Invoke-ContactAction, and emits the result as JSON on stdout. The
    supervisor connects EXO in this child process after materializing the
    tenant credential before invoking this script, so no secret handling
    lives here. -DryRun plans the action with no tenant write; delete
    additionally requires -Confirm.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER ContactId
    Direct target contact id for edit, hideFromGal, and delete runs.
.PARAMETER Action
    Contact action: create, edit, hideFromGal, or delete.
.PARAMETER DisplayName
    Display name for create; new display name for edit.
.PARAMETER ExternalAddress
    External email address for create; new external address for edit.
.PARAMETER Type
    Contact type for create: mailContact (default) or mailUser.
.PARAMETER HiddenFromGal
    Hidden-from-GAL flag for create and edit.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirm
    Explicit confirmation for delete.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-contact-action.ps1 -JobFile './run/contact-action-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-contact-action.ps1 -TenantId 'tenant-a' -Action 'hideFromGal' -ContactId 'contact-1'
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
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$ContactId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$DisplayName = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$ExternalAddress = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [ValidateSet('mailContact', 'mailUser')]
    [string]$Type = 'mailContact',

    [Parameter(ParameterSetName = 'ByTenant')]
    [object]$HiddenFromGal = $null,

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirm
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-ContactAction.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-ContactActionJob -Path $JobFile
        $TenantId = $job['TenantId']
        $ContactId = $job['ContactId']
        $Action = $job['Action']
        $DisplayName = $job['DisplayName']
        $ExternalAddress = $job['ExternalAddress']
        $Type = $job['Type']
        $HiddenFromGal = $job['HiddenFromGal']
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
        if (-not $PSBoundParameters.ContainsKey('Confirm')) {
            $Confirm = [bool]$job['Confirmed']
        }
        $Actor = $job['Actor']
        $CorrelationId = $job['CorrelationId']
    }

    $result = Invoke-ContactAction -TenantId $TenantId -ContactId $ContactId -Action $Action -DisplayName $DisplayName -ExternalAddress $ExternalAddress -Type $Type -HiddenFromGal $HiddenFromGal -DryRun:$DryRun -Confirmed:$Confirm -Actor $Actor -CorrelationId $CorrelationId
    $result | ConvertTo-Json -Depth 6 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
