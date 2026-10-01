# run-standards.ps1 — worker entrypoint for EPIC-008 standards runs (T-0841).
#
# Reads a `standards` job envelope whose payload carries the template id, its
# settings (variables already resolved by the route), and a `currentState` map
# (check id -> current value) the BFF built from the tenant's latest findings.
# Each setting runs through Invoke-Standard with its seams bound to the job's
# output folder: compare rows, alerts, and audit events are collected as JSON
# artifacts the BFF ingests after the job succeeds. Remediation keeps the
# EPIC-006 default seam (plan/apply); there is no private write path.

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
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-Standard.ps1')

function Get-StandardsJob {
    param([Parameter(Mandatory = $true)][string] $Path)

    $raw = Get-Content -LiteralPath $Path -Raw
    $job = $raw | ConvertFrom-Json -AsHashtable

    if ($job['schemaVersion'] -ne 'v1') {
        throw "run-standards.invalid_envelope: unsupported schemaVersion '$($job['schemaVersion'])'"
    }
    if ($job['jobType'] -ne 'standards') {
        throw "run-standards.invalid_envelope: expected jobType 'standards', got '$($job['jobType'])'"
    }
    foreach ($required in @('jobId', 'tenantId', 'runId', 'requestId', 'correlationId')) {
        if ([string]::IsNullOrWhiteSpace([string]$job[$required])) {
            throw "run-standards.invalid_envelope: missing '$required'"
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
$job = Get-StandardsJob -Path $JobFile

$tenantId = [string]$job['tenantId']
$templateId = [string](Get-PayloadValue -Job $job -Name 'templateId' -Default '')
$settings = @(Get-PayloadValue -Job $job -Name 'settings' -Default @())
$currentState = @(Get-PayloadValue -Job $job -Name 'currentState' -Default @())

$script:CurrentMap = @{}
foreach ($entry in $currentState) {
    if ($null -ne $entry -and $entry -is [System.Collections.IDictionary]) {
        $script:CurrentMap[[string]$entry['key']] = $entry['value']
    }
}

$script:CompareRows = [System.Collections.Generic.List[object]]::new()
$script:Alerts = [System.Collections.Generic.List[object]]::new()
$script:Audits = [System.Collections.Generic.List[object]]::new()
$script:Results = [System.Collections.Generic.List[object]]::new()

$script:ReadCurrentSeam = {
    param($check)
    $key = [string]$check
    if ($script:CurrentMap.ContainsKey($key)) { return $script:CurrentMap[$key] }
    return $null
}
$script:WriteCompareSeam = {
    param($row)
    $script:CompareRows.Add($row) | Out-Null
}
$script:RaiseAlertSeam = {
    param($event)
    $script:Alerts.Add($event) | Out-Null
}
$script:WriteAuditSeam = {
    param($event)
    $script:Audits.Add($event) | Out-Null
}

try {
    foreach ($setting in $settings) {
        if ($null -eq $setting -or $setting -isnot [System.Collections.IDictionary]) { continue }
        $check = [string]$setting['key']
        if ([string]::IsNullOrWhiteSpace($check)) { continue }
        $expected = $setting['value']

        $result = Invoke-Standard `
            -TenantId $tenantId `
            -Check $check `
            -Expected $expected `
            -TemplateId $templateId `
            -ReadCurrentState $script:ReadCurrentSeam `
            -WriteCompare $script:WriteCompareSeam `
            -RaiseAlert $script:RaiseAlertSeam `
            -WriteAudit $script:WriteAuditSeam `
            -CorrelationId ([string]$job['correlationId'])
        $script:Results.Add($result) | Out-Null
    }

    New-Item -Path $OutputFolder -ItemType Directory -Force | Out-Null
    $artifactRefs = [System.Collections.Generic.List[string]]::new()

    $comparePath = Join-Path -Path $OutputFolder -ChildPath 'compare-rows.json'
    $script:CompareRows | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $comparePath -Encoding UTF8
    $artifactRefs.Add('compare-rows.json') | Out-Null

    if ($script:Alerts.Count -gt 0) {
        $alertsPath = Join-Path -Path $OutputFolder -ChildPath 'alerts.json'
        $script:Alerts | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $alertsPath -Encoding UTF8
        $artifactRefs.Add('alerts.json') | Out-Null
    }
    if ($script:Audits.Count -gt 0) {
        $auditsPath = Join-Path -Path $OutputFolder -ChildPath 'audit-events.json'
        $script:Audits | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $auditsPath -Encoding UTF8
        $artifactRefs.Add('audit-events.json') | Out-Null
    }

    $resultsPath = Join-Path -Path $OutputFolder -ChildPath 'standards-run.json'
    $script:Results | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resultsPath -Encoding UTF8
    $artifactRefs.Add('standards-run.json') | Out-Null

    $finishedAt = [DateTime]::UtcNow.ToString('o')
    $null = Write-WorkerResult `
        -OutputFolder $OutputFolder `
        -JobId ([string]$job['jobId']) `
        -JobType 'standards' `
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
        -JobType 'standards' `
        -TenantId $tenantId `
        -RunId ([string]$job['runId']) `
        -RequestId ([string]$job['requestId']) `
        -CorrelationId ([string]$job['correlationId']) `
        -Status 'failed' `
        -ExitCode 1 `
        -StartedAt $startedAt `
        -FinishedAt $finishedAt `
        -ErrorCode 'standards.worker_failed' `
        -ErrorMessage $_.Exception.Message
    throw
}
