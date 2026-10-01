<#
.SYNOPSIS
    Worker entrypoint for the EPIC-023 contact template deploy.
.DESCRIPTION
    Reads a job envelope from -JobFile (or a template and targets directly),
    resolves the template variables per target, and either previews or applies
    the deployment via Invoke-DeployContactTemplate, emitting the per-target
    result as JSON on stdout. Valid targets are applied one at a time through
    the EPIC-006 gated contact executor and audited. The supervisor connects
    EXO in this child process after materializing the tenant credential before
    invoking this script, so no secret handling lives here. Preview performs no
    tenant write.
.PARAMETER JobFile
    Path to the job envelope JSON the supervisor wrote for this run.
.PARAMETER Template
    Direct ContactTemplate (id, name, properties, variables) for runs without a
    job envelope.
.PARAMETER Targets
    Direct deploy targets. Each target carries a tenantId and optional
    variables.
.PARAMETER DryRun
    Report the resolved contacts without writing to the tenant.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/deploy-contact-template.ps1 -JobFile './run/contact-template-deploy-job.json'
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/deploy-contact-template.ps1 -Template $template -Targets $targets -DryRun
#>
[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByTargets')]
    [object]$Template,

    [Parameter(Mandatory, ParameterSetName = 'ByTargets')]
    [object[]]$Targets,

    [Parameter(ParameterSetName = 'ByTargets')]
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Deploy-ContactTemplate.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-ContactAction.ps1')
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
        $job = Read-DeployContactTemplateJob -Path $JobFile
        $Template = $job['Template']
        $Targets = $job['Targets']
        if (-not $PSBoundParameters.ContainsKey('DryRun')) {
            $DryRun = [bool]$job['DryRun']
        }
        $Actor = $job['Actor']
        $CorrelationId = $job['CorrelationId']
    }

    $result = Invoke-DeployContactTemplate -Template $Template -Targets $Targets -DryRun:$DryRun -Actor $Actor -CorrelationId $CorrelationId
    $result | ConvertTo-Json -Depth 8 -Compress
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
