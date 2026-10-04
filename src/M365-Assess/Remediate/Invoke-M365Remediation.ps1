<#
.SYNOPSIS
    Plans and applies remediation for failed M365-Assess findings.
.DESCRIPTION
    Module entry point for the EPIC-006 remediation engine (SPEC.md sections 4.1
    and 4.3; 06-remediation.md section 3). -Plan is the read-only path that turns
    failed findings into a RemediationPlan; -Apply is the gated write path that
    executes approved actions through the typed executor.

    Both paths compose the Remediate/ domain functions instead of duplicating
    them: Resolve-Remediation classifies each finding (automated / manual /
    undetermined), Test-RemediationGate evaluates the six preconditions,
    Test-RemediationApplyEligibility enforces the validation hard gate, and
    Invoke-RemediationAction executes one allowlisted action with before/after
    capture. The portal workers dot-source the same domain functions; this
    function is the module's public surface over them, so there is one
    execution path per 06-remediation.md section 7.

    -Plan performs no tenant writes. -Apply requires confirmation
    (ConfirmImpact High), supports -WhatIf, honors -ContinueOnFailure, and
    stops on the first failure by default.
.PARAMETER Findings
    Finding objects exposing at least Id, CheckId, and Status. Only findings
    whose status is in -IncludeStatuses are planned.
.PARAMETER Actions
    Plan action objects exposing at least id and checkId, as produced by the
    -Plan path or the portal plan entity.
.PARAMETER TenantId
    Target tenant. Mandatory for -Plan; optional for -Apply (omitting it skips
    the tenant-scope gate check).
.PARAMETER RunId
    Run the findings came from (soft reference on the plan).
.PARAMETER PlanId
    Plan id; a new GUID is generated when omitted.
.PARAMETER CreatedBy
    Actor recorded on the plan and passed to the gate audit records.
.PARAMETER CreatedAt
    ISO-8601 plan creation timestamp; defaults to now (UTC).
.PARAMETER IncludeStatuses
    Finding statuses selected for remediation. Defaults to Fail, Warning, Review.
.PARAMETER RegistryPath
    Path to controls/registry.json, passed through to Resolve-Remediation.
.PARAMETER Actor
    Caller identity recorded on each apply result.
.PARAMETER CorrelationId
    Correlation id recorded on each plan action.
.PARAMETER ContinueOnFailure
    Continue past a failed action instead of stopping the batch.
.PARAMETER CallerContext
    Caller shape from the BFF (Permissions + TenantScope), passed to the
    gates unchanged.
.PARAMETER AllowlistPath
    Path to the admin-managed allowlist file, passed to the gates.
.PARAMETER AllowlistCheckIds
    Explicit allowlist membership, forwarded to the gates. When omitted, the
    gates load the allowlist file.
.PARAMETER TenantReadOnly
    Tenant or global read-only flag, passed to the gates.
.PARAMETER TenantServicePlans
    Service plan IDs active in the target tenant, passed to the gates.
.PARAMETER ServiceAvailable
    Whether the backing service for the check section is connected.
.PARAMETER RequiredPermission
    Permission the caller must hold. Defaults to remediation.apply.
.PARAMETER TestEligibility
    Seam: scriptblock (CheckId) -> eligibility. Defaults to
    Test-RemediationApplyEligibility (the validation hard gate).
.PARAMETER ExecuteAction
    Seam: scriptblock (action) -> executor result. Defaults to
    Invoke-RemediationAction with the gate pass-through options.
.EXAMPLE
    PS> Invoke-M365Remediation -Plan -Findings $findings -TenantId 'tenant-a' -AllowlistCheckIds @('SPO-SHARING-001')
.EXAMPLE
    PS> Invoke-M365Remediation -Apply -Actions $plan.Actions -TenantId 'tenant-a' -Confirm:$false
#>
function Invoke-M365Remediation {
    [CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Plan', ConfirmImpact = 'High')]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(ParameterSetName = 'Plan')]
        [switch]$Plan,

        [Parameter(ParameterSetName = 'Apply')]
        [switch]$Apply,

        [Parameter(ParameterSetName = 'Plan', Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Findings,

        [Parameter(ParameterSetName = 'Apply', Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Actions,

        [Parameter(ParameterSetName = 'Apply')]
        [switch]$ContinueOnFailure,

        [Parameter()]
        [string]$TenantId,

        [Parameter()]
        [string]$PlanId = '',

        [Parameter()]
        [string]$CorrelationId = '',

        [Parameter(ParameterSetName = 'Plan')]
        [string]$RunId = '',

        [Parameter(ParameterSetName = 'Plan')]
        [string]$CreatedBy = '',

        [Parameter(ParameterSetName = 'Plan')]
        [string]$CreatedAt = '',

        [Parameter(ParameterSetName = 'Plan')]
        [string[]]$IncludeStatuses = @('Fail', 'Warning', 'Review'),

        [Parameter(ParameterSetName = 'Plan')]
        [string]$RegistryPath,

        [Parameter(ParameterSetName = 'Apply')]
        [string]$Actor = '',

        [Parameter(ParameterSetName = 'Plan')]
        [Parameter(ParameterSetName = 'Apply')]
        [object]$CallerContext,

        [Parameter(ParameterSetName = 'Plan')]
        [Parameter(ParameterSetName = 'Apply')]
        [string]$AllowlistPath,

        [Parameter(ParameterSetName = 'Plan')]
        [Parameter(ParameterSetName = 'Apply')]
        [string[]]$AllowlistCheckIds,

        [Parameter(ParameterSetName = 'Plan')]
        [Parameter(ParameterSetName = 'Apply')]
        [bool]$TenantReadOnly = $false,

        [Parameter(ParameterSetName = 'Plan')]
        [Parameter(ParameterSetName = 'Apply')]
        [string[]]$TenantServicePlans = @(),

        [Parameter(ParameterSetName = 'Plan')]
        [Parameter(ParameterSetName = 'Apply')]
        [bool]$ServiceAvailable = $true,

        [Parameter(ParameterSetName = 'Plan')]
        [Parameter(ParameterSetName = 'Apply')]
        [string]$RequiredPermission = 'remediation.apply',

        [Parameter(ParameterSetName = 'Apply')]
        [scriptblock]$TestEligibility,

        [Parameter(ParameterSetName = 'Apply')]
        [scriptblock]$ExecuteAction
    )

    if ($PSCmdlet.ParameterSetName -eq 'Apply') {
        if (-not $PSCmdlet.ShouldProcess(
                "$($Actions.Count) remediation action(s) on tenant $TenantId",
                'Apply remediation actions')) {
            return
        }

        if (-not $TestEligibility) {
            $TestEligibility = {
                param($CheckId)
                Test-RemediationApplyEligibility -CheckId $CheckId
            }
        }
        if (-not $ExecuteAction) {
            $ExecuteAction = {
                param($action)
                $execParams = @{
                    CheckId            = [string]$action.checkId
                    TenantId           = $TenantId
                    CallerContext      = $CallerContext
                    AllowlistCheckIds  = $AllowlistCheckIds
                    TenantReadOnly     = $TenantReadOnly
                    TenantServicePlans = $TenantServicePlans
                    ServiceAvailable   = $ServiceAvailable
                    RequiredPermission = $RequiredPermission
                    Confirm            = $false
                }
                if (-not [string]::IsNullOrWhiteSpace($AllowlistPath)) { $execParams['AllowlistPath'] = $AllowlistPath }
                if (-not [string]::IsNullOrWhiteSpace($Actor)) { $execParams['Actor'] = $Actor }
                Invoke-RemediationAction @execParams
            }
        }

        if (-not $PlanId) { $PlanId = [guid]::NewGuid().ToString() }

        $results = New-Object System.Collections.Generic.List[object]
        $appliedCount = 0
        $skippedCount = 0
        $failedCount = 0
        $dryRunCount = 0
        $stopped = $false

        foreach ($action in $Actions) {
            $actionId = [string]$action.id
            $checkId = [string]$action.checkId
            $command = if ($null -ne $action.command) { [string]$action.command } else { '' }

            if ($stopped) {
                $skippedCount++
                $results.Add([PSCustomObject]@{
                    actionId       = $actionId
                    checkId        = $checkId
                    state          = 'skipped'
                    command        = $command
                    before         = $null
                    after          = $null
                    intendedChange = $null
                    appliedAt      = $null
                    actor          = $Actor
                    result         = $null
                    error          = 'batch-stopped'
                    dryRun         = $false
                }) | Out-Null
                continue
            }

            $eligibility = & $TestEligibility $checkId
            $eligible = $false
            $specStatus = 'unknown'
            if ($null -ne $eligibility) {
                if ($null -ne $eligibility.PSObject.Properties['Eligible']) { $eligible = [bool]$eligibility.Eligible }
                if ($null -ne $eligibility.PSObject.Properties['SpecStatus']) { $specStatus = [string]$eligibility.SpecStatus }
            }
            if (-not $eligible) {
                $skippedCount++
                $reason = "not-approved: specStatus=$specStatus"
                $results.Add([PSCustomObject]@{
                    actionId       = $actionId
                    checkId        = $checkId
                    state          = 'skipped'
                    command        = $command
                    before         = $null
                    after          = $null
                    intendedChange = $null
                    appliedAt      = $null
                    actor          = $Actor
                    result         = $null
                    error          = $reason
                    dryRun         = $false
                }) | Out-Null
                continue
            }

            try {
                $execResult = & $ExecuteAction $action
            }
            catch {
                $failedCount++
                $failedAt = [DateTime]::UtcNow.ToString('o')
                $message = $_.Exception.Message
                $results.Add([PSCustomObject]@{
                    actionId       = $actionId
                    checkId        = $checkId
                    state          = 'failed'
                    command        = $command
                    before         = $null
                    after          = $null
                    intendedChange = $null
                    appliedAt      = $failedAt
                    actor          = $Actor
                    result         = $null
                    error          = $message
                    dryRun         = $false
                }) | Out-Null
                if (-not $ContinueOnFailure) { $stopped = $true }
                continue
            }

            $state = if ($null -ne $execResult -and $null -ne $execResult.PSObject.Properties['State']) {
                [string]$execResult.State
            }
            else { 'failed' }

            $before = if ($null -ne $execResult -and $null -ne $execResult.PSObject.Properties['Before']) { $execResult.Before } else { $null }
            $after = if ($null -ne $execResult -and $null -ne $execResult.PSObject.Properties['After']) { $execResult.After } else { $null }
            $intended = if ($null -ne $execResult -and $null -ne $execResult.PSObject.Properties['IntendedChange']) { $execResult.IntendedChange } else { $null }
            $reason = if ($null -ne $execResult -and $null -ne $execResult.PSObject.Properties['Reason']) { [string]$execResult.Reason } else { $null }

            switch ($state) {
                'applied' {
                    $appliedAt = if ($null -ne $execResult.PSObject.Properties['AppliedAt'] -and $execResult.AppliedAt) {
                        [string]$execResult.AppliedAt
                    }
                    else { [DateTime]::UtcNow.ToString('o') }
                    $appliedCount++
                    $results.Add([PSCustomObject]@{
                        actionId       = $actionId
                        checkId        = $checkId
                        state          = 'applied'
                        command        = $command
                        before         = $before
                        after          = $after
                        intendedChange = $intended
                        appliedAt      = $appliedAt
                        actor          = $Actor
                        result         = $after
                        error          = $null
                        dryRun         = $false
                    }) | Out-Null
                }
                'dryrun' {
                    $dryRunCount++
                    $results.Add([PSCustomObject]@{
                        actionId       = $actionId
                        checkId        = $checkId
                        state          = 'dryrun'
                        command        = $command
                        before         = $before
                        after          = $null
                        intendedChange = $intended
                        appliedAt      = $null
                        actor          = $Actor
                        result         = $null
                        error          = $null
                        dryRun         = $true
                    }) | Out-Null
                }
                'failed' {
                    $failedCount++
                    $failedAt = [DateTime]::UtcNow.ToString('o')
                    $message = if ($reason) { $reason } else { 'remediation.apply_failed' }
                    $results.Add([PSCustomObject]@{
                        actionId       = $actionId
                        checkId        = $checkId
                        state          = 'failed'
                        command        = $command
                        before         = $before
                        after          = $null
                        intendedChange = $intended
                        appliedAt      = $failedAt
                        actor          = $Actor
                        result         = $null
                        error          = $message
                        dryRun         = $false
                    }) | Out-Null
                    if (-not $ContinueOnFailure) { $stopped = $true }
                }
                default {
                    $skippedCount++
                    $skipReason = if ($reason) { $reason } else { $state }
                    $results.Add([PSCustomObject]@{
                        actionId       = $actionId
                        checkId        = $checkId
                        state          = 'skipped'
                        command        = $command
                        before         = $before
                        after          = $null
                        intendedChange = $intended
                        appliedAt      = $null
                        actor          = $Actor
                        result         = $null
                        error          = $skipReason
                        dryRun         = $false
                    }) | Out-Null
                    if ($state -eq 'rejected' -and -not $ContinueOnFailure) { $stopped = $true }
                }
            }
        }

        return [PSCustomObject]@{
            PlanId           = $PlanId
            TenantId         = $TenantId
            DryRun           = $false
            ContinueOnFailure = $ContinueOnFailure.IsPresent
            StoppedOnFailure = $stopped
            Results          = $results.ToArray()
            Summary          = [PSCustomObject]@{
                total   = $Actions.Count
                applied = $appliedCount
                skipped = $skippedCount
                failed  = $failedCount
                dryrun  = $dryRunCount
            }
        }
    }

    if ($PSCmdlet.ParameterSetName -eq 'Plan' -and [string]::IsNullOrWhiteSpace($TenantId)) {
        throw [System.Management.Automation.ParameterBindingException]::new(
            'The -TenantId parameter is required for the Plan parameter set.')
    }

    if (-not $PlanId) { $PlanId = [guid]::NewGuid().ToString() }
    if (-not $CreatedAt) { $CreatedAt = [DateTime]::UtcNow.ToString('o') }

    $statusSet = @($IncludeStatuses | ForEach-Object { [string]$_ })
    $selected = @($Findings | Where-Object { $statusSet -contains [string]$_.Status })

    $planActions = New-Object System.Collections.Generic.List[object]
    $planInstructions = New-Object System.Collections.Generic.List[object]
    $instructionKeys = @{}
    $planFindingIds = New-Object System.Collections.Generic.List[string]

    $automatedCount = 0
    $manualCount = 0
    $undeterminedCount = 0
    $skippedCount = 0

    foreach ($finding in $selected) {
        $findingId = [string]$finding.Id
        if ($findingId) { $planFindingIds.Add($findingId) | Out-Null }

        $checkId = [string]$finding.CheckId
        $resolved = Resolve-Remediation -CheckId $checkId -RegistryPath $RegistryPath

        $mode = [string]$resolved.Mode
        $command = ''
        $target = $null

        switch ($mode) {
            'automated' { $command = [string]$resolved.Command }
            'manual' { $target = [string]$resolved.PortalPath }
            default { $mode = 'undetermined' }
        }

        $gateParams = @{
            CheckId            = $checkId
            TenantId           = $TenantId
            ServiceAvailable   = $ServiceAvailable
            TenantReadOnly     = $TenantReadOnly
            RequiredPermission = $RequiredPermission
        }
        if ($null -ne $CallerContext) { $gateParams['CallerContext'] = $CallerContext }
        if (-not [string]::IsNullOrWhiteSpace($resolved.LicenseMinimum)) { $gateParams['LicenseMinimum'] = $resolved.LicenseMinimum }
        if ($TenantServicePlans.Count -gt 0) { $gateParams['TenantServicePlans'] = $TenantServicePlans }
        if (-not [string]::IsNullOrWhiteSpace($AllowlistPath)) { $gateParams['AllowlistPath'] = $AllowlistPath }
        if ($null -ne $AllowlistCheckIds) { $gateParams['AllowlistCheckIds'] = $AllowlistCheckIds }
        if (-not [string]::IsNullOrWhiteSpace($CreatedBy)) { $gateParams['Actor'] = $CreatedBy }
        $gate = Test-RemediationGate @gateParams

        $gateDecision = [string]$gate.Decision
        $gateReason = [string]$gate.Reason
        $state = if ($mode -eq 'undetermined') { 'skipped' } elseif ($gateDecision -eq 'planned') { 'planned' } else { 'skipped' }
        $errorReason = if ($state -eq 'skipped') {
            if ($mode -eq 'undetermined') { 'undetermined: no remediation defined in the registry' } else { $gateReason }
        }
        else { $null }

        $planActions.Add([PSCustomObject]@{
            id        = [guid]::NewGuid().ToString()
            checkId   = $checkId
            command   = $command
            target    = $target
            state     = $state
            before    = $null
            after     = $null
            appliedAt = $null
            appliedBy = $null
            result    = [PSCustomObject]@{
                registryKey  = [string]$resolved.RegistryKey
                mode         = $mode
                gateDecision = $gateDecision
                gateReason   = $gateReason
            }
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
                $planInstructions.Add([PSCustomObject]@{
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

    [PSCustomObject]@{
        Plan         = [PSCustomObject]@{
            id         = $PlanId
            tenantId   = $TenantId
            runId      = $RunId
            findingIds = $planFindingIds.ToArray()
            mode       = $planMode
            createdAt  = $CreatedAt
            createdBy  = $CreatedBy
        }
        Actions      = $planActions.ToArray()
        Instructions = $planInstructions.ToArray()
        Summary      = [PSCustomObject]@{
            total        = $selected.Count
            automated    = $automatedCount
            manual       = $manualCount
            undetermined = $undeterminedCount
            skipped      = $skippedCount
        }
    }
}
