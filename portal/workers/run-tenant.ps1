<#
.SYNOPSIS
    Per-tenant worker child entrypoint: runs one tenant assessment in its own pwsh process.
.DESCRIPTION
    Rehydrates a RunContext from -ContextFile, runs the assessment via the M365Portal.Workers
    module, then writes artifacts plus a versioned result envelope (result.json) and exits
    with a code reflecting the outcome. One child pwsh per tenant keeps the process-global
    M365 SDKs and the EXO/Purview mutual exclusion from crossing tenants. Exit code plus
    result.json are the supervisor contract; stdout/stderr are diagnostics only.
.PARAMETER ContextFile
    Path to the context.json file the supervisor wrote for this tenant run.
.PARAMETER OutputFolder
    Per-tenant output folder receiving assessment artifacts and result.json.
.PARAMETER JobId
    Job id for the result envelope. Defaults to a fresh GUID for standalone runs.
.PARAMETER RunId
    Run id for the result envelope. Defaults to a fresh GUID for standalone runs.
.PARAMETER RequestId
    Request id for log correlation. Defaults to the job id.
.PARAMETER CorrelationId
    Correlation id for log correlation. Defaults to the job id.
.PARAMETER AssessmentScript
    Assessment script to invoke instead of Invoke-M365Assessment.ps1. Test hook so Pester
    can drive this entrypoint without tenant credentials; the supervisor never sets it.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/run-tenant.ps1 -ContextFile './run/context.json' -OutputFolder './run/tenant'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ContextFile,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputFolder,

    [Parameter()]
    [string]$JobId = '',

    [Parameter()]
    [string]$RunId = '',

    [Parameter()]
    [string]$RequestId = '',

    [Parameter()]
    [string]$CorrelationId = '',

    [Parameter()]
    [string]$AssessmentScript = ''
)

$ErrorActionPreference = 'Stop'

function Get-WorkerUtcNow {
    return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

if (-not $JobId) { $JobId = [guid]::NewGuid().ToString() }
if (-not $RunId) { $RunId = [guid]::NewGuid().ToString() }
if (-not $RequestId) { $RequestId = $JobId }
if (-not $CorrelationId) { $CorrelationId = $JobId }

$startedAt = Get-WorkerUtcNow
$tenantId = 'unknown'
$status = 'failed'
$exitCode = 2
$artifacts = @()
$errorCode = 'worker.startup_failed'
$errorMessage = ''

try {
    Import-Module -Name (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/M365Portal.Workers.psd1')
}
catch {
    $errorMessage = $_.Exception.Message
    Write-Warning "run-tenant: failed to load M365Portal.Workers: $errorMessage"
}

if (Get-Module -Name 'M365Portal.Workers') {
    $errorCode = 'worker.invalid_context'
    try {
        $ctx = Read-WorkerRunContext -ContextFile $ContextFile
        if ($ctx.Tenant.TenantId) {
            $tenantId = $ctx.Tenant.TenantId
        }
        New-Item -Path $OutputFolder -ItemType Directory -Force | Out-Null
        $invokeParams = @{
            Context      = $ctx
            OutputFolder = $OutputFolder
        }
        if ($AssessmentScript) {
            $invokeParams['AssessmentScript'] = $AssessmentScript
        }
        try {
            Invoke-WorkerAssessment @invokeParams
            $artifacts = Get-WorkerArtifacts -OutputFolder $OutputFolder
            $status = 'succeeded'
            $exitCode = 0
            $errorCode = ''
            $errorMessage = ''
        }
        catch {
            # Assessment failures still report partial artifacts so the run is diagnosable.
            $artifacts = Get-WorkerArtifacts -OutputFolder $OutputFolder
            $exitCode = 1
            $errorCode = 'worker.assessment_failed'
            $errorMessage = $_.Exception.Message
        }
    }
    catch {
        $exitCode = 2
        $errorCode = 'worker.invalid_context'
        $errorMessage = $_.Exception.Message
    }

    $resultParams = @{
        OutputFolder  = $OutputFolder
        JobId         = $JobId
        TenantId      = $tenantId
        RunId         = $RunId
        RequestId     = $RequestId
        CorrelationId = $CorrelationId
        Status        = $status
        ExitCode      = $exitCode
        ArtifactRefs  = $artifacts
        StartedAt     = $startedAt
        FinishedAt    = (Get-WorkerUtcNow)
    }
    if ($errorCode) {
        $resultParams['ErrorCode'] = $errorCode
        $resultParams['ErrorMessage'] = $errorMessage
    }
    try {
        Write-WorkerResult @resultParams | Out-Null
    }
    catch {
        Write-Error "run-tenant: failed to write result envelope: $($_.Exception.Message)"
        $exitCode = 2
    }
}
else {
    # The worker module itself is unloadable, so the envelope below duplicates the
    # result.json shape inline; the supervisor contract requires result.json on every path.
    try {
        New-Item -Path $OutputFolder -ItemType Directory -Force | Out-Null
        [ordered]@{
            schemaVersion = 'v1'
            jobId         = $JobId
            jobType       = 'assessment'
            tenantId      = $tenantId
            runId         = $RunId
            requestId     = $RequestId
            correlationId = $CorrelationId
            status        = $status
            startedAt     = $startedAt
            finishedAt    = (Get-WorkerUtcNow)
            exitCode      = $exitCode
            artifactRefs  = @()
            error         = [ordered]@{
                code      = $errorCode
                message   = $errorMessage
                retryable = $false
            }
        } | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path -Path $OutputFolder -ChildPath 'result.json') -Encoding UTF8
    }
    catch {
        Write-Error "run-tenant: failed to write fallback result envelope: $($_.Exception.Message)"
    }
}

exit $exitCode
