# verify-remediation.ps1 — worker entrypoint for EPIC-006 gated verify (T-0839).
#
# Reads a `remediation` job envelope carrying { actionId, check, section, actor },
# re-collects the check's finding through Invoke-RemediationVerify, and writes
# `remediation-verify.json` plus the standard result envelope (`result.json`).
#
# Verify is read-only against the tenant: it re-reads state, it never writes to
# the tenant. The action update, finding re-evaluation, and audit event are
# captured through the verify seams and persisted by the BFF's ingestion.

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
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-RemediationVerify.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Connect-WorkerTenant.ps1')

# Sign in to the job's tenant (T-0826). Verify re-reads tenant state, so it needs
# the same session the apply worker used.
$tenantSession = $null
if ($JobFile) {
    $tenantSession = Connect-WorkerTenant -JobFile $JobFile -Service Graph
}
try {
    function Get-VerifyRemediationJob {
        param([Parameter(Mandatory = $true)][string] $Path)

        $raw = Get-Content -LiteralPath $Path -Raw
        $job = $raw | ConvertFrom-Json -AsHashtable

        if ($job['schemaVersion'] -ne 'v1') {
            throw "verify-remediation.invalid_envelope: unsupported schemaVersion '$($job['schemaVersion'])'"
        }
        if ($job['jobType'] -ne 'remediation') {
            throw "verify-remediation.invalid_envelope: expected jobType 'remediation', got '$($job['jobType'])'"
        }
        foreach ($required in @('jobId', 'tenantId', 'runId', 'requestId', 'correlationId')) {
            if ([string]::IsNullOrWhiteSpace([string]$job[$required])) {
                throw "verify-remediation.invalid_envelope: missing '$required'"
            }
        }
        return $job
    }

    function Get-JobPayloadValue {
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
    $job = Get-VerifyRemediationJob -Path $JobFile

    $tenantId = [string]$job['tenantId']
    $actionId = [string](Get-JobPayloadValue -Job $job -Name 'actionId' -Default '')
    $checkId = [string](Get-JobPayloadValue -Job $job -Name 'check' -Default '')
    $section = [string](Get-JobPayloadValue -Job $job -Name 'section' -Default '')
    $actor = [string](Get-JobPayloadValue -Job $job -Name 'actor' -Default '')

    if ([string]::IsNullOrWhiteSpace($actionId)) {
        throw "verify-remediation.invalid_envelope: missing 'actionId'"
    }
    if ([string]::IsNullOrWhiteSpace($checkId)) {
        throw "verify-remediation.invalid_envelope: missing 'check'"
    }

    $action = [ordered]@{ id = $actionId; checkId = $checkId }
    if ($section) { $action['section'] = $section }

    # The verify seams capture what the BFF ingestion persists: the action update,
    # the finding re-evaluation, and the audit event. The worker holds no db.
    $actionUpdates = [System.Collections.Generic.List[object]]::new()
    $findingUpdates = [System.Collections.Generic.List[object]]::new()
    $auditEvents = [System.Collections.Generic.List[object]]::new()
    $alerts = [System.Collections.Generic.List[object]]::new()

    # Re-collection (SPEC §11 item 5): re-run the section's collectors through the
    # assessment and project the emitted settings into the finding shape the verify
    # logic matches on. Single-check re-collection is not wired here; the section
    # re-run is the fallback path.
    $assessmentScript = Join-Path -Path $PSScriptRoot -ChildPath '../../src/M365-Assess/Invoke-M365Assessment.ps1'
    $verifyOutputFolder = Join-Path -Path $OutputFolder -ChildPath 'verify-recollect'
    $collectSection = {
        param($sectionName)
        if ([string]::IsNullOrWhiteSpace($sectionName)) {
            return @()
        }
        $script:verifyFindings = [System.Collections.Generic.List[object]]::new()
        $assessmentParams = @{
            TenantId    = $tenantId
            Section     = @($sectionName)
            OutputFolder = $verifyOutputFolder
            NonInteractive = $true
        }
        $credential = $job['credential']
        if ($credential -and $credential.record) {
            $record = $credential.record
            if ($record['clientId']) { $assessmentParams['ClientId'] = [string]$record['clientId'] }
            if ($record['thumbprint']) { $assessmentParams['CertificateThumbprint'] = [string]$record['thumbprint'] }
            if ($record['environment']) { $assessmentParams['M365Environment'] = [string]$record['environment'] }
        }
        try {
            & $script:verifyAssessmentScript @assessmentParams
        }
        catch {
            Write-Warning "verify-remediation: section re-collection failed: $($_.Exception.Message)"
        }
        return @($script:verifyFindings)
    }
    $script:verifyAssessmentScript = $assessmentScript

    try {
        $verifyResult = Invoke-RemediationVerify `
            -Action $action `
            -TenantId $tenantId `
            -Section $section `
            -SingleCheckSupported:$false `
            -CollectSection $collectSection `
            -UpdateAction { param($id, $update) $script:actionUpdates.Add([PSCustomObject]@{ actionId = $id; update = $update }) | Out-Null } `
            -UpdateFinding { param($id, $update) $script:findingUpdates.Add([PSCustomObject]@{ findingId = $id; update = $update }) | Out-Null } `
            -WriteAudit { param($event) $script:auditEvents.Add($event) | Out-Null } `
            -RaiseAlert { param($event) $script:alerts.Add($event) | Out-Null } `
            -Actor $actor `
            -CorrelationId ([string]$job['correlationId'])

        New-Item -Path $OutputFolder -ItemType Directory -Force | Out-Null
        [ordered]@{
            ActionId      = $verifyResult.ActionId
            CheckId       = $verifyResult.CheckId
            Strategy      = $verifyResult.Strategy
            FindingStatus = $verifyResult.FindingStatus
            Passed        = $verifyResult.Passed
            ActionState   = $verifyResult.ActionState
            ReEvaluated   = $verifyResult.ReEvaluated
            Alerted       = $verifyResult.Alerted
            ActionUpdates = @($actionUpdates)
            FindingUpdates = @($findingUpdates)
            AuditEvents   = @($auditEvents)
            Alerts        = @($alerts)
        } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path -Path $OutputFolder -ChildPath 'remediation-verify.json') -Encoding UTF8

        $finishedAt = [DateTime]::UtcNow.ToString('o')
        $null = Write-WorkerResult `
            -OutputFolder $OutputFolder `
            -JobId ([string]$job['jobId']) `
            -JobType 'remediation' `
            -TenantId $tenantId `
            -RunId ([string]$job['runId']) `
            -RequestId ([string]$job['requestId']) `
            -CorrelationId ([string]$job['correlationId']) `
            -Status 'succeeded' `
            -ExitCode 0 `
            -ArtifactRefs @('remediation-verify.json') `
            -StartedAt $startedAt `
            -FinishedAt $finishedAt
    }
    catch {
        $finishedAt = [DateTime]::UtcNow.ToString('o')
        $null = Write-WorkerResult `
            -OutputFolder $OutputFolder `
            -JobId ([string]$job['jobId']) `
            -JobType 'remediation' `
            -TenantId $tenantId `
            -RunId ([string]$job['runId']) `
            -RequestId ([string]$job['requestId']) `
            -CorrelationId ([string]$job['correlationId']) `
            -Status 'failed' `
            -ExitCode 1 `
            -StartedAt $startedAt `
            -FinishedAt $finishedAt `
            -ErrorCode 'remediation.verify_failed' `
            -ErrorMessage $_.Exception.Message
        throw
    }
}
finally {
    Disconnect-WorkerTenant -Session $tenantSession
}
