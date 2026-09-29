# run-drift.ps1 — worker entrypoint for EPIC-009 drift refresh (T-0841).
#
# Reads a `drift` job envelope whose payload carries the drift template's
# settings, a `currentState` map ("key|resourceId" -> current value), and the
# tenant's `extraPolicies` (CA + Intune). Invoke-Drift runs with its seams
# bound to the job's output folder: deviations are collected as a JSON artifact
# the BFF ingests through the T-0162 upsert (which preserves triage). Drift is
# report-only unless a setting key is opted into auto-remediation.

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
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-Drift.ps1')

function Get-DriftJob {
    param([Parameter(Mandatory = $true)][string] $Path)

    $raw = Get-Content -LiteralPath $Path -Raw
    $job = $raw | ConvertFrom-Json -AsHashtable

    if ($job['schemaVersion'] -ne 'v1') {
        throw "run-drift.invalid_envelope: unsupported schemaVersion '$($job['schemaVersion'])'"
    }
    if ($job['jobType'] -ne 'drift') {
        throw "run-drift.invalid_envelope: expected jobType 'drift', got '$($job['jobType'])'"
    }
    foreach ($required in @('jobId', 'tenantId', 'runId', 'requestId', 'correlationId')) {
        if ([string]::IsNullOrWhiteSpace([string]$job[$required])) {
            throw "run-drift.invalid_envelope: missing '$required'"
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
$job = Get-DriftJob -Path $JobFile

$tenantId = [string]$job['tenantId']
$templateId = [string](Get-PayloadValue -Job $job -Name 'templateId' -Default '')
$settings = @(Get-PayloadValue -Job $job -Name 'settings' -Default @())
$currentState = @(Get-PayloadValue -Job $job -Name 'currentState' -Default @())
$extraPolicies = @(Get-PayloadValue -Job $job -Name 'extraPolicies' -Default @())
$autoRemediateKeys = @(Get-PayloadValue -Job $job -Name 'autoRemediateKeys' -Default @())

$script:CurrentMap = @{}
foreach ($entry in $currentState) {
    if ($null -ne $entry -and $entry -is [System.Collections.IDictionary]) {
        $script:CurrentMap[[string]$entry['key']] = $entry['value']
    }
}

$script:Deviations = [System.Collections.Generic.List[object]]::new()

$script:CollectCurrentSeam = {
    param($key, $resourceId)
    $mapKey = "$key|$resourceId"
    if ($script:CurrentMap.ContainsKey($mapKey)) { return $script:CurrentMap[$mapKey] }
    return $null
}
$script:CollectExtraSeam = { @($script:ExtraPolicies) }
$script:UpsertSeam = {
    param($tenantId, $deviations)
    foreach ($deviation in $deviations) {
        $script:Deviations.Add($deviation) | Out-Null
    }
    return [PSCustomObject]@{ inserted = $deviations.Count; updated = 0; preserved = 0 }
}
$script:ApplyRemediationSeam = {
    param($standardKey, $resourceId, $expected)
    return $null
}

try {
    $script:ExtraPolicies = @($extraPolicies)

    $result = Invoke-Drift `
        -TenantId $tenantId `
        -TemplateId $templateId `
        -ExpectedSettings $settings `
        -CollectCurrentState $script:CollectCurrentSeam `
        -CollectExtraPolicies $script:CollectExtraSeam `
        -UpsertDeviations $script:UpsertSeam `
        -AutoRemediateKeys $autoRemediateKeys `
        -ApplyRemediation $script:ApplyRemediationSeam `
        -CorrelationId ([string]$job['correlationId'])

    New-Item -Path $OutputFolder -ItemType Directory -Force | Out-Null
    $artifactRefs = [System.Collections.Generic.List[string]]::new()

    $deviationsPath = Join-Path -Path $OutputFolder -ChildPath 'deviations.json'
    $script:Deviations | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $deviationsPath -Encoding UTF8
    $artifactRefs.Add('deviations.json') | Out-Null

    $resultPath = Join-Path -Path $OutputFolder -ChildPath 'drift-result.json'
    $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resultPath -Encoding UTF8
    $artifactRefs.Add('drift-result.json') | Out-Null

    $finishedAt = [DateTime]::UtcNow.ToString('o')
    $null = Write-WorkerResult `
        -OutputFolder $OutputFolder `
        -JobId ([string]$job['jobId']) `
        -JobType 'drift' `
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
        -JobType 'drift' `
        -TenantId $tenantId `
        -RunId ([string]$job['runId']) `
        -RequestId ([string]$job['requestId']) `
        -CorrelationId ([string]$job['correlationId']) `
        -Status 'failed' `
        -ExitCode 1 `
        -StartedAt $startedAt `
        -FinishedAt $finishedAt `
        -ErrorCode 'drift.worker_failed' `
        -ErrorMessage $_.Exception.Message
    throw
}
