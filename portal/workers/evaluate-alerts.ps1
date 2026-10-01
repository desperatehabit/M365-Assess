# evaluate-alerts.ps1 — worker entrypoint for batched per-tenant alert
# evaluation (EPIC-029 SPEC.md §4.1, §11.4; T-0564).
#
# The EPIC-007 scheduler dispatches this once per tenant. It reads the job
# envelope (tenantId, the tenant's rules, the correlation id, and the
# prefetched log-source rows), runs the Invoke-AlertEvaluation handler, and
# emits the result object as JSON on stdout. Live log-source reads are a
# supervisor concern (ADR-0014): the envelope carries the prefetched rows so the
# batch is deterministic and the entrypoint stays thin. The handler emits fired
# events through its seams; a wiring ticket connects EmitEvent/WriteAudit to the
# alert pipeline.

[CmdletBinding(DefaultParameterSetName = 'ByJobFile')]
param(
    [Parameter(Mandatory, ParameterSetName = 'ByJobFile')]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile,

    [Parameter(Mandatory, ParameterSetName = 'ByParams')]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$RulesFile = '',

    [Parameter(ParameterSetName = 'ByParams')]
    [string]$SourceDataFile = '',

    [Parameter()]
    [string]$CorrelationId = '',

    # object so a JSON-parsed DateTime reaches the handler, which normalises it
    # to ISO-8601.
    [Parameter()]
    [AllowNull()]
    [object]$RunAt = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-AlertEvaluation.ps1')

$rules = @()
$sourceData = @{}
if ($JobFile) {
    $job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    $TenantId = [string]$job['tenantId']
    if (-not $TenantId) { throw "job envelope '$JobFile' is missing 'tenantId'" }
    if ($job.Contains('rules')) { $rules = @($job['rules']) }
    if ($job.Contains('sourceData')) { $sourceData = $job['sourceData'] }
    if ($job.Contains('correlationId')) { $CorrelationId = [string]$job['correlationId'] }
    if ($job.Contains('runAt')) { $RunAt = $job['runAt'] }
}
else {
    if ($RulesFile) {
        $rules = @(Get-Content -LiteralPath $RulesFile -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable)
    }
    if ($SourceDataFile) {
        $sourceData = Get-Content -LiteralPath $SourceDataFile -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    }
}

$readLogSource = {
    param($source)
    if ($sourceData.Contains($source)) { return @($sourceData[$source]) }
    return @()
}

$invokeParams = @{
    TenantId      = $TenantId
    Rules         = $rules
    ReadLogSource = $readLogSource
    CorrelationId = $CorrelationId
    RunAt         = $RunAt
}
$result = Invoke-AlertEvaluation @invokeParams

$result | ConvertTo-Json -Depth 12 -Compress
