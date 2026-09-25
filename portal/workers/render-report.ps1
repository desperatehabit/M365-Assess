<#
.SYNOPSIS
    Report render worker child entrypoint: renders one report HTML to PDF in its own pwsh process.
.DESCRIPTION
    Reads a report job envelope from -JobFile, renders the referenced HTML with the
    M365Portal.Workers render handler (pinned headless Chromium, ADR-0016), then writes the
    PDF artifact plus a versioned result envelope (result.json) and exits with a code
    reflecting the outcome. One child pwsh per render keeps Chromium's cost and failure
    blast radius off the supervisor. Exit code plus result.json are the supervisor contract;
    stdout/stderr are diagnostics only. Render bytes live on the artifact tier; the DB holds
    only metadata and the artifactRef (EPIC-005 SPEC.md section 11.5).

    The module is imported via its .psm1 rather than the manifest so the render handler is
    available without a manifest change (the manifest owns the assessment entrypoint surface).
.PARAMETER JobFile
    Path to the report job envelope JSON the supervisor wrote for this render.
.PARAMETER OutputFolder
    Output folder receiving the rendered PDF and result.json.
.PARAMETER ChromiumPath
    Chromium binary for the render. Defaults to M365_CHROMIUM_PATH/CHROMIUM_PATH discovery.
.PARAMETER TimeoutSec
    Render timeout in seconds. Defaults to the handler default when 0.
.PARAMETER JobId
    Job id override. Defaults to the envelope jobId.
.PARAMETER RunId
    Run id override. Defaults to the envelope runId.
.PARAMETER RequestId
    Request id for log correlation. Defaults to the envelope requestId.
.PARAMETER CorrelationId
    Correlation id for log correlation. Defaults to the envelope correlationId.
.EXAMPLE
    PS> pwsh -NoProfile -File portal/workers/render-report.ps1 -JobFile './run/report-job.json' -OutputFolder './run/report'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputFolder,

    [Parameter()]
    [string]$ChromiumPath = '',

    [Parameter()]
    [ValidateRange(0, 3600)]
    [int]$TimeoutSec = 0,

    [Parameter()]
    [string]$JobId = '',

    [Parameter()]
    [string]$RunId = '',

    [Parameter()]
    [string]$RequestId = '',

    [Parameter()]
    [string]$CorrelationId = ''
)

$ErrorActionPreference = 'Stop'

function Get-RenderUtcNow {
    return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

function Read-ReportJobEnvelope {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Report job file not found: $Path"
    }
    $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($job['schemaVersion'] -ne 'v1') {
        throw "Report job has unsupported schemaVersion: $($job['schemaVersion'])"
    }
    if ($job['jobType'] -ne 'report') {
        throw "Report job has unexpected jobType: $($job['jobType'])"
    }
    foreach ($field in @('jobId', 'tenantId', 'runId', 'requestId', 'correlationId')) {
        if ([string]::IsNullOrWhiteSpace($job[$field])) {
            throw "Report job is missing required field: $field"
        }
    }
    $payload = $job['payload']
    if ($null -eq $payload -or [string]::IsNullOrWhiteSpace($payload['htmlRef'])) {
        throw 'Report job payload is missing required field: htmlRef'
    }
    return $job
}

$startedAt = Get-RenderUtcNow
$status = 'failed'
$exitCode = 2
$artifacts = @()
$errorCode = 'worker.startup_failed'
$errorMessage = ''
$retryable = $false
$tenantId = 'unknown'
$envelopeJobId = [guid]::NewGuid().ToString()
$envelopeRunId = [guid]::NewGuid().ToString()
$envelopeRequestId = $envelopeJobId
$envelopeCorrelationId = $envelopeJobId

try {
    Import-Module -Name (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/M365Portal.Workers.psm1') -Force
}
catch {
    $errorMessage = $_.Exception.Message
    Write-Warning "render-report: failed to load M365Portal.Workers: $errorMessage"
}

if (Get-Module -Name 'M365Portal.Workers') {
    $errorCode = 'worker.invalid_job'
    try {
        $job = Read-ReportJobEnvelope -Path $JobFile
        $tenantId = $job['tenantId']
        if (-not $JobId) { $JobId = $job['jobId'] }
        if (-not $RunId) { $RunId = $job['runId'] }
        if (-not $RequestId) { $RequestId = $job['requestId'] }
        if (-not $CorrelationId) { $CorrelationId = $job['correlationId'] }
        $envelopeJobId = $JobId
        $envelopeRunId = $RunId
        $envelopeRequestId = $RequestId
        $envelopeCorrelationId = $CorrelationId

        New-Item -Path $OutputFolder -ItemType Directory -Force | Out-Null
        $jobDirectory = Split-Path -Path (Resolve-Path -LiteralPath $JobFile).Path -Parent
        $htmlRef = $job['payload']['htmlRef']
        $htmlPath = if ([System.IO.Path]::IsPathRooted($htmlRef)) { $htmlRef } else { Join-Path -Path $jobDirectory -ChildPath $htmlRef }
        $pdfFileName = $job['payload']['pdfFileName']
        if ([string]::IsNullOrWhiteSpace($pdfFileName)) {
            $pdfFileName = 'report.pdf'
        }
        $pdfPath = Join-Path -Path $OutputFolder -ChildPath $pdfFileName

        $renderParams = @{
            HtmlPath = $htmlPath
            PdfPath  = $pdfPath
        }
        if ($ChromiumPath) {
            $renderParams['ChromiumPath'] = $ChromiumPath
        }
        if ($TimeoutSec -gt 0) {
            $renderParams['TimeoutSec'] = $TimeoutSec
        }
        try {
            Invoke-ReportRender @renderParams | Out-Null
            $artifacts = Get-WorkerArtifacts -OutputFolder $OutputFolder
            $status = 'succeeded'
            $exitCode = 0
            $errorCode = ''
            $errorMessage = ''
        }
        catch {
            $artifacts = Get-WorkerArtifacts -OutputFolder $OutputFolder
            $exitCode = 1
            $inner = $_.Exception
            while ($inner.InnerException) {
                $inner = $inner.InnerException
            }
            if ($inner -is [System.TimeoutException] -or $inner -is [System.OutOfMemoryException]) {
                $errorCode = 'render.timeout'
                $retryable = $true
            }
            elseif ($inner -is [System.ArgumentException]) {
                $errorCode = 'render.invalid_input'
            }
            else {
                $errorCode = 'render.failed'
            }
            $errorMessage = $inner.Message
        }
    }
    catch {
        $exitCode = 2
        $errorCode = 'worker.invalid_job'
        $errorMessage = $_.Exception.Message
    }

    $resultParams = @{
        OutputFolder  = $OutputFolder
        JobId         = $envelopeJobId
        JobType       = 'report'
        TenantId      = $tenantId
        RunId         = $envelopeRunId
        RequestId     = $envelopeRequestId
        CorrelationId = $envelopeCorrelationId
        Status        = $status
        ExitCode      = $exitCode
        ArtifactRefs  = $artifacts
        StartedAt     = $startedAt
        FinishedAt    = (Get-RenderUtcNow)
        Retryable     = $retryable
    }
    if ($errorCode) {
        $resultParams['ErrorCode'] = $errorCode
        $resultParams['ErrorMessage'] = $errorMessage
    }
    try {
        Write-WorkerResult @resultParams | Out-Null
    }
    catch {
        Write-Error "render-report: failed to write result envelope: $($_.Exception.Message)"
        $exitCode = 2
    }
}
else {
    try {
        New-Item -Path $OutputFolder -ItemType Directory -Force | Out-Null
        [ordered]@{
            schemaVersion = 'v1'
            jobId         = $envelopeJobId
            jobType       = 'report'
            tenantId      = $tenantId
            runId         = $envelopeRunId
            requestId     = $envelopeRequestId
            correlationId = $envelopeCorrelationId
            status        = $status
            startedAt     = $startedAt
            finishedAt    = (Get-RenderUtcNow)
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
        Write-Error "render-report: failed to write fallback result envelope: $($_.Exception.Message)"
    }
}

exit $exitCode
