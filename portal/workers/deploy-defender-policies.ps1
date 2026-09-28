<#
.SYNOPSIS
    Worker entrypoint for EPIC-019 Defender setup deployment (T-0364).
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly), plans or
    applies the Defender policy deploy for one target tenant, and emits JSON on stdout.
    The BFF runs one job per target tenant.
.PARAMETER JobFile
    Path to the job envelope JSON written by the supervisor.
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
    [string[]]$PolicyAreas,

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$TargetScope = 'allDevices',

    [Parameter(ParameterSetName = 'ByParams')]
    [switch]$Overwrite,

    [Parameter(ParameterSetName = 'ByParams')]
    [switch]$DryRun,

    [Parameter(ParameterSetName = 'ByParams')]
    [switch]$SaveAsTemplate,

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$TemplateName = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Deploy-DefenderPolicies.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-DefenderDeployJob -Path $JobFile
        $TenantId       = $job['TenantId']
        $PolicyAreas    = @($job['PolicyAreas'])
        $TargetScope    = $job['TargetScope']
        $Overwrite      = [bool]$job['Overwrite']
        $DryRun         = [bool]$job['DryRun']
        $SaveAsTemplate = [bool]$job['SaveAsTemplate']
        $TemplateName   = $job['TemplateName']
        $CreatedBy      = $job['Actor']
    }

    $invokeParams = @{
        TenantId       = $TenantId
        PolicyAreas    = @($PolicyAreas)
        TargetScope    = $TargetScope
        Overwrite      = [bool]$Overwrite
        DryRun         = [bool]$DryRun
        SaveAsTemplate = [bool]$SaveAsTemplate
        TemplateName   = $TemplateName
    }
    if ($CreatedBy) { $invokeParams['CreatedBy'] = $CreatedBy }

    $result = Invoke-DeployDefenderPolicies @invokeParams
    $result | ConvertTo-Json -Depth 20 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
