<#
.SYNOPSIS
    Worker entrypoint for EPIC-021 transport-rule create/edit/delete.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly), executes
    or previews a transport-rule create/edit/delete via Invoke-SetTransportRule,
    and emits the JSON envelope on stdout. An edit that changes nothing returns a
    structured no-op with no EXO write. The supervisor connects EXO in this child
    process after materializing the tenant credential (T-0011) before invoking
    this script, so no secret handling lives here. -DryRun plans with no tenant
    write; apply requires -Confirmed.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Action
    'create' adds a rule; 'edit' changes one; 'delete' removes one.
.PARAMETER RuleId
    Direct rule identity for edit/delete runs without a job envelope.
.PARAMETER Name
    Rule name for create, or the new name for edit.
.PARAMETER Enabled
    'true' or 'false' to set the rule state; empty leaves it unchanged.
.PARAMETER Priority
    Non-negative priority for create/edit; empty leaves it unchanged.
.PARAMETER ConditionsJson
    JSON object of condition fields for create/edit.
.PARAMETER ActionsJson
    JSON object of action fields for create/edit.
.PARAMETER ExceptionsJson
    JSON object of exception fields for create/edit.
.PARAMETER DryRun
    Report the intended change without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-transport-rule.ps1 -JobFile './run/transport-rule-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/set-transport-rule.ps1 -TenantId 'tenant-a' -Action 'delete' -RuleId 'rule-1' -Confirmed -DryRun
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
    [ValidateSet('create', 'edit', 'delete')]
    [string]$Action,

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$RuleId = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Name = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [ValidateSet('', 'true', 'false')]
    [string]$Enabled = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$Priority = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$ConditionsJson = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$ActionsJson = '',

    [Parameter(ParameterSetName = 'ByTenant')]
    [string]$ExceptionsJson = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-TransportRule.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    $jobEnabled = $null
    $jobPriority = $null
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-SetTransportRuleJob -Path $JobFile
        $TenantId       = $job['TenantId']
        $Action         = $job['Action']
        $RuleId         = $job['RuleId']
        $Name           = $job['Name']
        $ConditionsJson = $job['ConditionsJson']
        $ActionsJson    = $job['ActionsJson']
        $ExceptionsJson = $job['ExceptionsJson']
        $jobEnabled     = $job['Enabled']
        $jobPriority    = $job['Priority']
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
    }

    $invokeParams = @{
        TenantId       = $TenantId
        Action         = $Action
        RuleId         = $RuleId
        Name           = $Name
        ConditionsJson = $ConditionsJson
        ActionsJson    = $ActionsJson
        ExceptionsJson = $ExceptionsJson
        DryRun         = [bool]$DryRun
        Confirmed      = [bool]$Confirmed
    }
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        if ($null -ne $jobEnabled) {
            $invokeParams['Enabled'] = [bool]$jobEnabled
        }
        if ($null -ne $jobPriority) {
            $invokeParams['Priority'] = [int]$jobPriority
        }
    }
    else {
        if ($Enabled -ne '') {
            $invokeParams['Enabled'] = ($Enabled -eq 'true')
        }
        if ($Priority -ne '') {
            $invokeParams['Priority'] = [int]$Priority
        }
    }

    $result = Invoke-SetTransportRule @invokeParams
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
