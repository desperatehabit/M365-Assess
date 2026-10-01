<#
.SYNOPSIS
    Worker entrypoint for the EPIC-023 resource write actions.
.DESCRIPTION
    Reads a job envelope from -JobFile (or a tenant, kind, resource, and action
    directly), executes the resource action live against Exchange Online via
    Invoke-ResourceAction, and emits the result as JSON on stdout. The
    supervisor connects EXO in this child process after materializing the
    tenant credential before invoking this script, so no secret handling
    lives here. -DryRun plans the action with no tenant write; delete
    additionally requires -Confirm.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Kind
    Resource kind: rooms, equipment, or roomlists.
.PARAMETER Action
    Resource action: create, edit, delete, addMember, or removeMember.
.PARAMETER ResourceId
    Direct target resource id for edit, delete, addMember, and removeMember runs.
.PARAMETER DisplayName
    Display name for create; new display name for edit.
.PARAMETER Capacity
    Seat capacity for create and edit.
.PARAMETER Location
    Room location for create and edit.
.PARAMETER Hidden
    Hidden-from-GAL flag for create and edit.
.PARAMETER MemberId
    Member resource id for addMember and removeMember.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirm
    Explicit confirmation for delete.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-resource-action.ps1 -JobFile './run/resource-action-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-resource-action.ps1 -TenantId 'tenant-a' -Kind 'rooms' -Action 'create' -DisplayName 'Focus Room' -Capacity 8
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
    [ValidateSet('rooms', 'equipment', 'roomlists')]
    [string]$Kind,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$ResourceId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$DisplayName = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [object]$Capacity = $null,

    [Parameter(ParameterSetName = 'ByTenant')]
    [object]$Location = $null,

    [Parameter(ParameterSetName = 'ByTenant')]
    [object]$Hidden = $null,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$MemberId = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirm
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-ResourceAction.ps1')
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
        $job = Read-ResourceActionJob -Path $JobFile
        $TenantId = $job['TenantId']
        $Kind = $job['Kind']
        $ResourceId = $job['ResourceId']
        $Action = $job['Action']
        $DisplayName = $job['DisplayName']
        $Capacity = $job['Capacity']
        $Location = $job['Location']
        $Hidden = $job['Hidden']
        $MemberId = $job['MemberId']
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
        if (-not $PSBoundParameters.ContainsKey('Confirm')) {
            $Confirm = [bool]$job['Confirmed']
        }
        $Actor = $job['Actor']
        $CorrelationId = $job['CorrelationId']
    }

    $result = Invoke-ResourceAction -TenantId $TenantId -Kind $Kind -Action $Action -ResourceId $ResourceId -DisplayName $DisplayName -Capacity $Capacity -Location $Location -Hidden $Hidden -MemberId $MemberId -DryRun ([bool]$DryRun) -Confirmed ([bool]$Confirm) -Actor $Actor -CorrelationId $CorrelationId
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
