<#
.SYNOPSIS
    Worker entrypoint for EPIC-021 transport template deploy.
.DESCRIPTION
    Reads a T-0007 job envelope from -JobFile (or parameters directly), resolves
    a transport-rule or connector template's variables, plans or applies it to
    the target tenant through Invoke-DeployTransportTemplate, and emits the JSON
    envelope on stdout. -DryRun plans with no tenant write; apply requires
    -Confirmed. The BFF fans out across targets and reports partial failures per
    target, so each invocation handles exactly one target.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER TenantId
    Direct tenant id for runs without a job envelope.
.PARAMETER Kind
    'rule' deploys ruleJson; 'connector' deploys connectorJson.
.PARAMETER TemplateJson
    Direct stored template JSON for runs without a job envelope.
.PARAMETER Variables
    Deploy-supplied variable values keyed by declared name.
.PARAMETER Actor
    Operator identity recorded on the audit event.
.PARAMETER DryRun
    Report the resolved plan without writing to the tenant.
.PARAMETER Confirmed
    Explicit confirmation for apply; the BFF confirms the plan before dispatch.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/deploy-transport-template.ps1 -JobFile './run/transport-job.json'
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByDirect')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory, ParameterSetName = 'ByDirect')]
    [ValidateSet('rule', 'connector')]
    [string]$Kind,

    [Parameter(Mandatory, ParameterSetName = 'ByDirect')]
    [ValidateNotNullOrEmpty()]
    [string]$TemplateJson,

    [Parameter(ParameterSetName = 'ByDirect')]
    [hashtable]$Variables = @{},

    [Parameter()]
    [string]$Actor = 'system',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Deploy-TransportTemplate.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-TransportRule.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Set-Connector.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Direct-parameter runs manage their own session.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service ExchangeOnline
}
try {
    if ($PSCmdlet.ParameterSetName -eq 'ByJobFile') {
        $job = Read-DeployTransportTemplateJob -Path $JobFile
        $TenantId = $job['TenantId']
        $Kind = $job['Kind']
        $TemplateJson = $job['Template'] | ConvertTo-Json -Depth 12 -Compress
        $Variables = $job['Variables']
        $Actor = $job['Actor']
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
        if (-not $PSBoundParameters.ContainsKey('Confirmed')) {
            $Confirmed = [bool]$job['Confirmed']
        }
    }

    $invokeParams = @{
        TenantId     = $TenantId
        Kind         = $Kind
        TemplateJson = $TemplateJson
        Variables    = $Variables
        Actor        = $Actor
        DryRun       = [bool]$DryRun
        Confirmed    = [bool]$Confirmed
    }

    $result = Invoke-DeployTransportTemplate @invokeParams
    $result | ConvertTo-Json -Depth 10 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
