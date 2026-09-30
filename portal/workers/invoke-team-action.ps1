<#
.SYNOPSIS
    Worker entrypoint for the EPIC-026 team lifecycle: edit, archive, clone, and delete.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly), runs
    the requested team lifecycle action through Invoke-TeamAction, and emits the
    result as JSON on stdout. Stdout is the response transport; team objects are
    never mirrored to disk. The supervisor connects Graph in this child process
    after materializing the tenant credential (T-0011) before invoking this
    script, so no secret handling lives here. -DryRun plans with no tenant
    write; delete apply requires -Confirmed and -ConfirmName naming the team.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    edit | archive | clone | delete.
.PARAMETER TeamId
    Team identity the action targets.
.PARAMETER ChangesJson
    Editable fields for edit, as a JSON object (direct mode).
.PARAMETER NewName
    Clone display name.
.PARAMETER Description
    Clone description.
.PARAMETER Visibility
    Clone visibility.
.PARAMETER PartsToClone
    Clone parts list.
.PARAMETER ConfirmName
    Delete confirmation name that must match the team display name.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for delete apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-team-action.ps1 -JobFile './run/team-action-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/invoke-team-action.ps1 -TenantId 'tenant-a' -Action 'archive' -TeamId 'team-1' -DryRun
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
    [ValidateSet('edit', 'archive', 'clone', 'delete')]
    [string]$Action,

    [Parameter(Mandatory, ParameterSetName = 'ByTenant')]
    [ValidateNotNullOrEmpty()]
    [string]$TeamId,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$ChangesJson = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$NewName = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Description = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Visibility = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$PartsToClone = 'apps,tabs,settings,channels,members',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$ConfirmName = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-TeamAction.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    $Changes = $null
    $Actor = ''
    $CorrelationId = ''
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-TeamActionJob -Path $JobFile
        $TenantId = $job['TenantId']
        $Action = $job['Action']
        $TeamId = $job['TeamId']
        $Changes = $job['Changes']
        $NewName = $job['NewName']
        $Description = $job['Description']
        $Visibility = $job['Visibility']
        $PartsToClone = $job['PartsToClone']
        $ConfirmName = $job['ConfirmName']
        $Actor = $job['Actor']
        $CorrelationId = $job['CorrelationId']
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }
    elseif ($ChangesJson.Trim().Length -gt 0) {
        $Changes = $ChangesJson | ConvertFrom-Json -AsHashtable
    }

    $result = Invoke-TeamAction -TenantId $TenantId -Action $Action -TeamId $TeamId -Changes $Changes `
        -NewName $NewName -Description $Description -Visibility $Visibility -PartsToClone $PartsToClone `
        -ConfirmName $ConfirmName -DryRun ([bool]$DryRun) -Confirmed ([bool]$Confirmed) `
        -Actor $Actor -CorrelationId $CorrelationId
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
