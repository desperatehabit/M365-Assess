# Plan-Remediation.ps1
# EPIC-006 SPEC.md §4.1, §5 — plan generation (US-2).
#
# Turns a run's findings into a persisted-shaped RemediationPlan plus one
# RemediationAction per selected finding. This is the *plan-only* path: it
# performs no tenant writes, and it never invokes a remediation command. Apply
# is T-0107/T-0108.
#
# Classification and gating are delegated to the already-implemented domain
# functions so the plan agrees with the apply path:
#   - Resolve-Remediation (T-0102): sub-number stripping + auto/manual/undetermined
#   - Test-RemediationGate (T-0104): rbac/scope/license/service/read-only/allowlist
#
# Both are injectable (`-ResolveRemediation`, `-EvaluateGate`) so unit tests do
# not need the real registry or a DB. The defaults dot-source the module copies.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Load the domain functions from the module (idempotent; guarded so a test that
# injects both seams and runs where the module is absent still works).
$script:RemediationDomainRoot = Join-Path $PSScriptRoot '../../../src/M365-Assess/Remediate'
if (Test-Path -LiteralPath $script:RemediationDomainRoot -PathType Container) {
    foreach ($domainFile in @('Resolve-Remediation.ps1', 'Test-RemediationGate.ps1')) {
        $domainPath = Join-Path -Path $script:RemediationDomainRoot -ChildPath $domainFile
        if (Test-Path -LiteralPath $domainPath -PathType Leaf) {
            . $domainPath
        }
    }
}

function New-RemediationPlan {
    <#
    .SYNOPSIS
        Builds a RemediationPlan and its RemediationAction rows from findings.
    .DESCRIPTION
        Implements EPIC-006 SPEC.md §4.1:
          1. Select findings whose status is in -IncludeStatuses (default
             Fail, Warning, Review).
          2. Resolve each finding's CheckId through Resolve-Remediation. The
             stored id may be sub-numbered (CA-REPORTONLY-001.1); the resolver
             strips the trailing \.\d+ to key the registry.
          3. Classify: a registry command -> automated action (state planned);
             otherwise a portal path -> manual action + ManualInstruction;
             otherwise undetermined (action state skipped, flagged for triage).
          4. Evaluate gates per action; an unmet gate records state skipped and
             the reason on the action.
          5. Return the plan. Nothing is written to the tenant or the DB here.

        The return value is a pure [PSCustomObject]; persistence is the caller's
        job (the entrypoint hands it to the repository seam, the BFF serves it).
    .PARAMETER Findings
        Finding objects exposing at least Id, CheckId, and Status.
    .PARAMETER TenantId
        Tenant the plan belongs to.
    .PARAMETER RunId
        Run the findings came from (soft reference).
    .PARAMETER PlanId
        Optional plan id; a new GUID is generated when omitted.
    .PARAMETER CreatedBy
        Actor that requested the plan.
    .PARAMETER CreatedAt
        Optional ISO-8601 creation timestamp; defaults to now (UTC).
    .PARAMETER IncludeStatuses
        Finding statuses selected for remediation. Defaults to Fail, Warning, Review.
    .PARAMETER RegistryPath
        Passed through to Resolve-Remediation (the default resolver).
    .PARAMETER CallerContext
        Passed through to Test-RemediationGate for RBAC/scope evaluation.
    .PARAMETER AllowlistPath
    .PARAMETER AllowlistCheckIds
    .PARAMETER TenantReadOnly
    .PARAMETER TenantServicePlans
    .PARAMETER ServiceAvailable
        Passed through to Test-RemediationGate.
    .PARAMETER RequiredPermission
        Permission the gate checks for apply. Defaults to remediation.apply.
    .PARAMETER ResolveRemediation
        Seam: scriptblock (CheckId) -> Resolve-Remediation output. Defaults to Resolve-Remediation.
    .PARAMETER EvaluateGate
        Seam: scriptblock (CheckId, LicenseMinimum) -> Test-RemediationGate output.
        Defaults to Test-RemediationGate with the pass-through options.
    .PARAMETER CorrelationId
        Correlation id recorded on each action.
    .OUTPUTS
        [PSCustomObject] with Plan, Actions, Instructions, and Summary.
    .EXAMPLE
        New-RemediationPlan -Findings $findings -TenantId 'contoso' -RunId 'run-1'
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Findings,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$TenantId,

        [Parameter()]
        [string]$RunId = '',

        [Parameter()]
        [string]$PlanId = '',

        [Parameter()]
        [string]$CreatedBy = '',

        [Parameter()]
        [string]$CreatedAt = '',

        [Parameter()]
        [string[]]$IncludeStatuses = @('Fail', 'Warning', 'Review'),

        [Parameter()]
        [string]$RegistryPath,

        [Parameter()]
        [object]$CallerContext,

        [Parameter()]
        [string]$AllowlistPath,

        [Parameter()]
        [string[]]$AllowlistCheckIds = @(),

        [Parameter()]
        [bool]$TenantReadOnly = $false,

        [Parameter()]
        [string[]]$TenantServicePlans = @(),

        [Parameter()]
        [bool]$ServiceAvailable = $true,

        [Parameter()]
        [string]$RequiredPermission = 'remediation.apply',

        [Parameter()]
        [scriptblock]$ResolveRemediation,

        [Parameter()]
        [scriptblock]$EvaluateGate,

        [Parameter()]
        [string]$CorrelationId = ''
    )

    if (-not $PlanId) { $PlanId = [guid]::NewGuid().ToString() }
    if (-not $CreatedAt) { $CreatedAt = [DateTime]::UtcNow.ToString('o') }

    if (-not $ResolveRemediation) {
        $ResolveRemediation = {
            param($CheckId)
            Resolve-Remediation -CheckId $CheckId -RegistryPath $RegistryPath
        }
    }
    if (-not $EvaluateGate) {
        $EvaluateGate = {
            param($CheckId, $LicenseMinimum)
            Test-RemediationGate `
                -CheckId $CheckId `
                -TenantId $TenantId `
                -CallerContext $CallerContext `
                -LicenseMinimum $LicenseMinimum `
                -TenantServicePlans $TenantServicePlans `
                -ServiceAvailable $ServiceAvailable `
                -TenantReadOnly $TenantReadOnly `
                -RequiredPermission $RequiredPermission `
                -AllowlistPath $AllowlistPath `
                -AllowlistCheckIds $AllowlistCheckIds
        }
    }

    $statusSet = @($IncludeStatuses | ForEach-Object { [string]$_ })
    $selected = @($Findings | Where-Object { $statusSet -contains [string]$_.Status })

    $actions = New-Object System.Collections.Generic.List[object]
    $instructions = New-Object System.Collections.Generic.List[object]
    $instructionKeys = @{}
    $findingIds = New-Object System.Collections.Generic.List[string]

    $automatedCount = 0
    $manualCount = 0
    $undeterminedCount = 0
    $skippedCount = 0

    foreach ($finding in $selected) {
        $findingId = [string]$finding.Id
        if ($findingId) { $findingIds.Add($findingId) | Out-Null }

        $checkId = [string]$finding.CheckId
        $resolved = & $ResolveRemediation $checkId

        $mode = [string]$resolved.Mode
        $command = ''
        $target = $null
        $isAutomated = $false

        switch ($mode) {
            'automated' {
                $isAutomated = $true
                $command = [string]$resolved.Command
            }
            'manual' {
                $target = [string]$resolved.PortalPath
            }
            default {
                $mode = 'undetermined'
            }
        }

        $gate = & $EvaluateGate $checkId $resolved.LicenseMinimum
        $gateDecision = if ($null -ne $gate) { [string]$gate.Decision } else { 'planned' }

        # Undetermined findings are never actionable; gate outcome otherwise decides.
        $state = if ($mode -eq 'undetermined') { 'skipped' } elseif ($gateDecision -eq 'planned') { 'planned' } else { 'skipped' }
        $gateReason = if ($null -ne $gate) { [string]$gate.Reason } else { $null }
        $errorReason = if ($state -eq 'skipped') {
            if ($mode -eq 'undetermined') { 'undetermined: no remediation defined in the registry' } else { $gateReason }
        }
        else { $null }

        $resultInfo = [ordered]@{
            registryKey  = [string]$resolved.RegistryKey
            mode         = $mode
            gateDecision = $gateDecision
            gateReason   = $gateReason
        }

        $actions.Add([ordered]@{
            id            = [guid]::NewGuid().ToString()
            checkId       = $checkId
            command       = $command
            target        = $target
            state         = $state
            before        = $null
            after         = $null
            appliedAt     = $null
            appliedBy     = $null
            result        = $resultInfo
            error         = $errorReason
            correlationId = if ($CorrelationId) { $CorrelationId } else { $null }
        }) | Out-Null

        if ($mode -eq 'automated') { $automatedCount++ }
        elseif ($mode -eq 'manual') { $manualCount++ }
        else { $undeterminedCount++ }
        if ($state -eq 'skipped') { $skippedCount++ }

        if ($mode -eq 'manual') {
            $instructionKey = [string]$resolved.RegistryKey
            if (-not $instructionKeys.ContainsKey($instructionKey)) {
                $instructionKeys[$instructionKey] = $true
                $instructions.Add([ordered]@{
                    checkId    = $instructionKey
                    portalPath = [string]$resolved.PortalPath
                    steps      = @($resolved.PortalSteps)
                    notes      = if ($resolved.Notes) { [string]$resolved.Notes } else { $null }
                }) | Out-Null
            }
        }
    }

    $planMode = 'manual'
    if ($automatedCount -gt 0 -and ($manualCount + $undeterminedCount) -gt 0) { $planMode = 'mixed' }
    elseif ($automatedCount -gt 0) { $planMode = 'automated' }

    $plan = [ordered]@{
        id         = $PlanId
        tenantId   = $TenantId
        runId      = $RunId
        findingIds = $findingIds.ToArray()
        mode       = $planMode
        createdAt  = $CreatedAt
        createdBy  = $CreatedBy
    }

    return [PSCustomObject]@{
        Plan         = [PSCustomObject]$plan
        Actions      = $actions.ToArray()
        Instructions = $instructions.ToArray()
        Summary      = [PSCustomObject]@{
            total        = $selected.Count
            automated    = $automatedCount
            manual       = $manualCount
            undetermined = $undeterminedCount
            skipped      = $skippedCount
        }
    }
}
