# run-baseline.ps1 — worker entrypoint for EPIC-010 baseline evaluation (T-0841).
#
# Reads a `baseline` job envelope whose payload carries a `baselines` array
# (each entry: baseline id + the tenant's current stage) and a `currentState`
# map (standard key -> current value). Invoke-Baseline runs per baseline with
# its seams bound to the job's output folder: the evaluation results are
# collected as a JSON artifact the BFF ingests (rollout, history, trend).
# Apply keeps the default no-op seam; the EPIC-006 contract gates any real write.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $JobFile,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $OutputFolder
)

$ErrorActionPreference = 'Stop'

Import-Module (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/M365Portal.Workers.psd1') -Force
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-Baseline.ps1')

function Get-BaselineJob {
    param([Parameter(Mandatory = $true)][string] $Path)

    $raw = Get-Content -LiteralPath $Path -Raw
    $job = $raw | ConvertFrom-Json -AsHashtable

    if ($job['schemaVersion'] -ne 'v1') {
        throw "run-baseline.invalid_envelope: unsupported schemaVersion '$($job['schemaVersion'])'"
    }
    if ($job['jobType'] -ne 'baseline') {
        throw "run-baseline.invalid_envelope: expected jobType 'baseline', got '$($job['jobType'])'"
    }
    foreach ($required in @('jobId', 'tenantId', 'runId', 'requestId', 'correlationId')) {
        if ([string]::IsNullOrWhiteSpace([string]$job[$required])) {
            throw "run-baseline.invalid_envelope: missing '$required'"
        }
    }
    return $job
}

function Get-PayloadValue {
    param(
        [Parameter(Mandatory = $true)] $Job,
        [Parameter(Mandatory = $true)][string] $Name,
        $Default = $null
    )
    $payload = $Job['payload']
    if ($payload -is [System.Collections.IDictionary] -and $payload.Contains($Name)) {
        return $payload[$Name]
    }
    return $Default
}

$startedAt = [DateTime]::UtcNow.ToString('o')
$job = Get-BaselineJob -Path $JobFile

$tenantId = [string]$job['tenantId']
$baselines = @(Get-PayloadValue -Job $job -Name 'baselines' -Default @())
$currentState = @(Get-PayloadValue -Job $job -Name 'currentState' -Default @())

$script:CurrentMap = @{}
foreach ($entry in $currentState) {
    if ($null -ne $entry -and $entry -is [System.Collections.IDictionary]) {
        $script:CurrentMap[[string]$entry['key']] = $entry['value']
    }
}

$script:Audits = [System.Collections.Generic.List[object]]::new()
$script:Results = [System.Collections.Generic.List[object]]::new()

$script:CollectStageSeam = {
    param($key)
    if ($script:CurrentMap.ContainsKey([string]$key)) { return $script:CurrentMap[[string]$key] }
    return $null
}
$script:ApplyRemediationSeam = {
    param($standardKey, $expected)
    return $null
}
$script:WriteAuditSeam = {
    param($event)
    $script:Audits.Add($event) | Out-Null
}

try {
    foreach ($baseline in $baselines) {
        if ($null -eq $baseline -or $baseline -isnot [System.Collections.IDictionary]) { continue }
        $baselineId = [string]$baseline['baselineId']
        if ([string]::IsNullOrWhiteSpace($baselineId)) { continue }
        $stages = @($baseline['stages'])

        $result = Invoke-Baseline `
            -TenantId $tenantId `
            -BaselineId $baselineId `
            -Stages $stages `
            -CollectStageState $script:CollectStageSeam `
            -ApplyRemediation $script:ApplyRemediationSeam `
            -WriteAudit $script:WriteAuditSeam `
            -CorrelationId ([string]$job['correlationId'])
        $script:Results.Add($result) | Out-Null
    }

    New-Item -Path $OutputFolder -ItemType Directory -Force | Out-Null
    $artifactRefs = [System.Collections.Generic.List[string]]::new()

    if ($script:Audits.Count -gt 0) {
        $auditsPath = Join-Path -Path $OutputFolder -ChildPath 'audit-events.json'
        $script:Audits | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $auditsPath -Encoding UTF8
        $artifactRefs.Add('audit-events.json') | Out-Null
    }

    $resultPath = Join-Path -Path $OutputFolder -ChildPath 'baseline-evaluation.json'
    $script:Results | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resultPath -Encoding UTF8
    $artifactRefs.Add('baseline-evaluation.json') | Out-Null

    $finishedAt = [DateTime]::UtcNow.ToString('o')
    $null = Write-WorkerResult `
        -OutputFolder $OutputFolder `
        -JobId ([string]$job['jobId']) `
        -JobType 'baseline' `
        -TenantId $tenantId `
        -RunId ([string]$job['runId']) `
        -RequestId ([string]$job['requestId']) `
        -CorrelationId ([string]$job['correlationId']) `
        -Status 'succeeded' `
        -ExitCode 0 `
        -ArtifactRefs $artifactRefs.ToArray() `
        -StartedAt $startedAt `
        -FinishedAt $finishedAt
}
catch {
    $finishedAt = [DateTime]::UtcNow.ToString('o')
    $null = Write-WorkerResult `
        -OutputFolder $OutputFolder `
        -JobId ([string]$job['jobId']) `
        -JobType 'baseline' `
        -TenantId $tenantId `
        -RunId ([string]$job['runId']) `
        -RequestId ([string]$job['requestId']) `
        -CorrelationId ([string]$job['correlationId']) `
        -Status 'failed' `
        -ExitCode 1 `
        -StartedAt $startedAt `
        -FinishedAt $finishedAt `
        -ErrorCode 'baseline.worker_failed' `
        -ErrorMessage $_.Exception.Message
    throw
}
