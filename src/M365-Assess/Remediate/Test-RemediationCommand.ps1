$script:RemediationCommandRegistryPath = Join-Path -Path $PSScriptRoot -ChildPath '../controls/registry.json'
$script:RemediationValidationMatrixPath = Join-Path -Path $PSScriptRoot -ChildPath '../../../docs/portal-specs/02-controls/remediation-matrix.csv'
$script:RemediationValidationAutoDir = Join-Path -Path $PSScriptRoot -ChildPath '../../../docs/portal-specs/02-controls/auto'

function New-RemediationValidationRecord {
    <#
    .SYNOPSIS
        Builds the per-check validation record emitted by the harness.
    .DESCRIPTION
        Single construction point for Test-RemediationCommand output so every
        path (validated, refused, gated) returns the same shape. Not exported;
        the module loader only exports the Test-/Get-/Set-/New- entry points.
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$CheckId,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$RegistryKey,

        [Parameter()]
        [string]$Command,

        [Parameter()]
        [string]$CommandName,

        [Parameter()]
        [bool]$CommandRuns,

        [Parameter()]
        [bool]$IsIdempotent,

        [Parameter()]
        [bool]$BeforeAfterCaptured,

        [Parameter()]
        [bool]$GatesExpressible,

        [Parameter()]
        [bool]$Validated,

        [Parameter(Mandatory)]
        [ValidateSet('not-started', 'drafted', 'approved')]
        [string]$SpecStatus,

        [Parameter()]
        [string]$Reason,

        [Parameter()]
        [object]$GateDecision,

        [Parameter()]
        [object]$FirstRun,

        [Parameter()]
        [object]$SecondRun,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$ValidatedAt
    )

    [PSCustomObject]@{
        CheckId             = $CheckId
        RegistryKey         = $registryKey
        Command             = $Command
        CommandName         = $CommandName
        CommandRuns         = $CommandRuns
        IsIdempotent        = $IsIdempotent
        BeforeAfterCaptured = $BeforeAfterCaptured
        GatesExpressible    = $GatesExpressible
        Validated           = $Validated
        SpecStatus          = $SpecStatus
        Reason              = $Reason
        GateDecision        = $GateDecision
        FirstRun            = $FirstRun
        SecondRun           = $SecondRun
        ValidatedAt         = $ValidatedAt
    }
}

function ConvertTo-ValidationStateJson {
    <#
    .SYNOPSIS
        Serializes a captured tenant state for idempotency comparison.
    .DESCRIPTION
        Idempotency is proven by comparing the post-apply state of two
        consecutive runs. States are opaque tenant values (strings, guids,
        hashtables), so both are normalized through ConvertTo-Json before
        comparison. Not exported.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [object]$Value
    )

    if ($null -eq $Value) { return '$null' }
    $Value | ConvertTo-Json -Depth 10 -Compress
}

function Get-RemediationAutoCandidates {
    <#
    .SYNOPSIS
        Lists the registry checks carrying a PowerShell remediation command.
    .DESCRIPTION
        Enumerates the auto-candidate set per EPIC-006 SPEC.md section 4.5:
        every registry check whose remediation.powershell.command is present
        (the 62 commands the harness must validate). Mirrors the
        remediationMode classification in generate-matrix.py
        (command present means auto-candidate). Sorted by checkId so piped
        validation runs are deterministic.
    .PARAMETER RegistryPath
        Path to controls/registry.json. Defaults to the module registry.
    .OUTPUTS
        [string[]] of registry checkIds with a PowerShell command.
    .EXAMPLE
        Get-RemediationAutoCandidates | Test-RemediationCommand -TenantId 'tenant-a'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$RegistryPath
    )

    process {
        if (-not $RegistryPath) { $RegistryPath = $script:RemediationCommandRegistryPath }

        $candidates = @()
        if (Test-Path -Path $RegistryPath -PathType Leaf) {
            $raw = Get-Content -Path $RegistryPath -Raw | ConvertFrom-Json
            foreach ($check in @($raw.checks)) {
                $command = [string]$check.remediation.powershell.command
                if (-not [string]::IsNullOrWhiteSpace($command)) {
                    $candidates += [string]$check.checkId
                }
            }
        }

        @($candidates | Sort-Object -Unique)
    }
}

function Test-RemediationCommand {
    <#
    .SYNOPSIS
        Validates one registry remediation command against a tenant.
    .DESCRIPTION
        Validation harness per EPIC-006 SPEC.md section 4.5 (US-7) and
        06-remediation.md section 2.2: before any apply ships, each of the 62
        remediation.powershell.command strings must be proven against a real
        tenant. The command is never evaluated as a string. The check resolves
        to its typed binding via Get-RemediationCommand (T-0107); checks
        without a typed binding are refused with reason 'not-implemented' and
        nothing executes. Validated checks run twice through the typed
        executor (Invoke-RemediationAction) inside the tenant's connected
        child process: the first run proves the command runs with
        before/after captured, the second run proves idempotency by converging
        on the same post-apply state. Gates flow through Test-RemediationGate
        via the executor, so the record also proves the gates are expressible.

        Live runs pass -TenantId (credential resolution reuses the EPIC-001
        Resolve-TenantCredential seam inside the executor). Tests inject
        -GetState/-ApplyChange seams instead of touching a tenant.
    .PARAMETER CheckId
        The finding CheckId, with or without the sub-number suffix.
    .PARAMETER TenantId
        Target tenant for the validation runs.
    .PARAMETER TenantCredential
        Opaque tenant credential passed through to the typed executor.
    .PARAMETER CallerContext
        Caller shape from the BFF (Permissions + TenantScope), passed to the
        gates unchanged.
    .PARAMETER RegistryPath
        Path to controls/registry.json. Defaults to the module registry.
    .PARAMETER LicenseMinimum
        Registry licensing.minimum override; defaults to the resolved value.
    .PARAMETER RequiredServicePlans
        Service plan IDs from licensing-overlay.json for the check.
    .PARAMETER TenantServicePlans
        Service plan IDs active in the target tenant.
    .PARAMETER ServiceAvailable
        Whether the backing service for the check section is connected.
    .PARAMETER TenantReadOnly
        Tenant or global read-only flag.
    .PARAMETER RequiredPermission
        Permission the caller must hold. Defaults to remediation.apply.
    .PARAMETER AllowlistPath
        Path to the admin-managed allowlist file. Used unless
        AllowlistCheckIds is supplied.
    .PARAMETER AllowlistCheckIds
        Explicit allowlist membership, forwarded to the gates.
    .PARAMETER Actor
        Optional caller identity recorded on the runs.
    .PARAMETER GetState
        Test seam: scriptblock returning current state instead of calling the
        tenant. Production callers omit it.
    .PARAMETER ApplyChange
        Test seam: scriptblock performing the change and returning the
        post-apply state instead of calling the tenant. Never invoked for a
        refused check. Production callers omit it.
    .OUTPUTS
        [PSCustomObject] with CheckId, RegistryKey, Command, CommandName,
        CommandRuns, IsIdempotent, BeforeAfterCaptured, GatesExpressible,
        Validated, SpecStatus (not-started | drafted | approved), Reason,
        GateDecision, FirstRun, SecondRun, and ValidatedAt.
    .EXAMPLE
        Test-RemediationCommand -CheckId 'SPO-SHARING-001.1' -TenantId 'tenant-a' -CallerContext $ctx -AllowlistCheckIds @('SPO-SHARING-001')
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [string]$CheckId,

        [Parameter()]
        [string]$TenantId,

        [Parameter()]
        [object]$TenantCredential,

        [Parameter()]
        [object]$CallerContext,

        [Parameter()]
        [string]$RegistryPath,

        [Parameter()]
        [string]$LicenseMinimum,

        [Parameter()]
        [string[]]$RequiredServicePlans = @(),

        [Parameter()]
        [string[]]$TenantServicePlans = @(),

        [Parameter()]
        [bool]$ServiceAvailable = $true,

        [Parameter()]
        [bool]$TenantReadOnly = $false,

        [Parameter()]
        [string]$RequiredPermission = 'remediation.apply',

        [Parameter()]
        [string]$AllowlistPath,

        [Parameter()]
        [string[]]$AllowlistCheckIds,

        [Parameter()]
        [string]$Actor,

        [Parameter()]
        [scriptblock]$GetState,

        [Parameter()]
        [scriptblock]$ApplyChange
    )

    process {
        $registryKey = $CheckId -replace '\.\d+$', ''
        $validatedAt = (Get-Date).ToUniversalTime().ToString('o')

        $siblings = @(
            @{ FunctionName = 'Resolve-Remediation'; FileName = 'Resolve-Remediation.ps1' }
            @{ FunctionName = 'Get-RemediationCommand'; FileName = 'Get-RemediationCommand.ps1' }
            @{ FunctionName = 'Test-RemediationGate'; FileName = 'Test-RemediationGate.ps1' }
            @{ FunctionName = 'Invoke-RemediationAction'; FileName = 'Invoke-RemediationAction.ps1' }
        )
        foreach ($sibling in $siblings) {
            if ($null -eq (Get-Command -Name $sibling.FunctionName -ErrorAction SilentlyContinue)) {
                . (Join-Path -Path $PSScriptRoot -ChildPath $sibling.FileName)
            }
        }

        $resolveParams = @{ CheckId = $CheckId }
        if (-not [string]::IsNullOrWhiteSpace($RegistryPath)) { $resolveParams['RegistryPath'] = $RegistryPath }
        $resolution = Resolve-Remediation @resolveParams

        $gateParams = @{
            CheckId            = $CheckId
            ServiceAvailable   = $ServiceAvailable
            TenantReadOnly     = $TenantReadOnly
            RequiredPermission = $RequiredPermission
        }
        if (-not [string]::IsNullOrWhiteSpace($TenantId)) { $gateParams['TenantId'] = $TenantId }
        if ($null -ne $CallerContext) { $gateParams['CallerContext'] = $CallerContext }
        $licenseFloor = $LicenseMinimum
        if ([string]::IsNullOrWhiteSpace($licenseFloor)) { $licenseFloor = $resolution.LicenseMinimum }
        if (-not [string]::IsNullOrWhiteSpace($licenseFloor)) { $gateParams['LicenseMinimum'] = $licenseFloor }
        if ($RequiredServicePlans.Count -gt 0) { $gateParams['RequiredServicePlans'] = $RequiredServicePlans }
        if ($TenantServicePlans.Count -gt 0) { $gateParams['TenantServicePlans'] = $TenantServicePlans }
        if (-not [string]::IsNullOrWhiteSpace($AllowlistPath)) { $gateParams['AllowlistPath'] = $AllowlistPath }
        if ($null -ne $AllowlistCheckIds) { $gateParams['AllowlistCheckIds'] = $AllowlistCheckIds }
        if (-not [string]::IsNullOrWhiteSpace($Actor)) { $gateParams['Actor'] = $Actor }

        $binding = Get-RemediationCommand -CheckId $CheckId

        if ($resolution.Mode -ne 'automated' -or [string]::IsNullOrWhiteSpace($resolution.Command)) {
            $gateDecision = $null
            try { $gateDecision = Test-RemediationGate @gateParams } catch { $gateDecision = $null }
            New-RemediationValidationRecord -CheckId $CheckId -RegistryKey $registryKey `
                -Command ([string]$resolution.Command) -CommandName ([string]$binding.CommandName) `
                -CommandRuns $false -IsIdempotent $false -BeforeAfterCaptured $false `
                -GatesExpressible ($null -ne $gateDecision) -Validated $false `
                -SpecStatus 'not-started' -Reason 'not-automated' `
                -GateDecision $gateDecision -ValidatedAt $validatedAt
            return
        }

        if ($binding.Kind -ne 'typed') {
            $gateDecision = $null
            try { $gateDecision = Test-RemediationGate @gateParams } catch { $gateDecision = $null }
            New-RemediationValidationRecord -CheckId $CheckId -RegistryKey $registryKey `
                -Command ([string]$resolution.Command) -CommandName ([string]$binding.CommandName) `
                -CommandRuns $false -IsIdempotent $false -BeforeAfterCaptured $false `
                -GatesExpressible ($null -ne $gateDecision) -Validated $false `
                -SpecStatus 'not-started' -Reason 'not-implemented' `
                -GateDecision $gateDecision -ValidatedAt $validatedAt
            return
        }

        $executorParams = $gateParams.Clone()
        $executorParams['CommandBinding'] = $binding
        if ($null -ne $TenantCredential) { $executorParams['TenantCredential'] = $TenantCredential }
        if ($null -ne $GetState) { $executorParams['GetState'] = $GetState }
        if ($null -ne $ApplyChange) { $executorParams['ApplyChange'] = $ApplyChange }

        $first = Invoke-RemediationAction @executorParams -Confirm:$false
        $second = Invoke-RemediationAction @executorParams -Confirm:$false

        $commandRuns = ($first.State -eq 'applied') -and ($second.State -eq 'applied')
        $beforeAfterCaptured = ($null -ne $first.Before) -and ($null -ne $first.After) -and `
            ($null -ne $second.Before) -and ($null -ne $second.After)
        $gatesExpressible = ($null -ne $first.GateDecision) -and ($null -ne $second.GateDecision)

        $isIdempotent = $false
        if ($commandRuns) {
            $firstAfter = ConvertTo-ValidationStateJson -Value $first.After
            $isIdempotent = ($firstAfter -eq (ConvertTo-ValidationStateJson -Value $second.After)) -and `
                ($firstAfter -eq (ConvertTo-ValidationStateJson -Value $second.Before))
        }

        $validated = $commandRuns -and $isIdempotent -and $beforeAfterCaptured -and $gatesExpressible

        $specStatus = 'not-started'
        if ($validated) { $specStatus = 'approved' }
        elseif ($commandRuns) { $specStatus = 'drafted' }

        $reason = $null
        if (-not $validated) {
            if (-not $commandRuns) {
                $reason = if ([string]::IsNullOrWhiteSpace($first.Reason)) { [string]$first.State } else { [string]$first.Reason }
            }
            elseif (-not $beforeAfterCaptured) { $reason = 'before-after-missing' }
            elseif (-not $isIdempotent) { $reason = 'not-idempotent' }
            else { $reason = 'gates-missing' }
        }

        New-RemediationValidationRecord -CheckId $CheckId -RegistryKey $registryKey `
            -Command ([string]$resolution.Command) -CommandName ([string]$binding.CommandName) `
            -CommandRuns $commandRuns -IsIdempotent $isIdempotent -BeforeAfterCaptured $beforeAfterCaptured `
            -GatesExpressible $gatesExpressible -Validated $validated `
            -SpecStatus $specStatus -Reason $reason `
            -GateDecision $first.GateDecision -FirstRun $first -SecondRun $second -ValidatedAt $validatedAt
    }
}

function Test-RemediationApplyEligibility {
    <#
    .SYNOPSIS
        Hard gate: only matrix-approved checks may reach the apply path.
    .DESCRIPTION
        Implements the EPIC-006 SPEC.md section 4.5 hard gate (section 8):
        a remediation command is eligible for apply only when its
        remediation-matrix.csv specStatus is 'approved'. Every other status
        (not-started, drafted, or a checkId absent from the matrix) is
        ineligible with reason 'not-validated', so an unvalidated command is
        never applied. Read-only against the matrix; the harness records
        validation via Set-RemediationValidationStatus.
    .PARAMETER CheckId
        The finding CheckId, with or without the sub-number suffix.
    .PARAMETER MatrixPath
        Path to remediation-matrix.csv. Defaults to the repository matrix.
    .OUTPUTS
        [PSCustomObject] with CheckId, RegistryKey, SpecStatus, Eligible,
        Reason (approved | not-validated), and MatrixPath.
    .EXAMPLE
        Test-RemediationApplyEligibility -CheckId 'SPO-SHARING-001.1'
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [string]$CheckId,

        [Parameter()]
        [string]$MatrixPath
    )

    process {
        $registryKey = $CheckId -replace '\.\d+$', ''
        if (-not $MatrixPath) { $MatrixPath = $script:RemediationValidationMatrixPath }

        $specStatus = 'not-started'
        if (Test-Path -Path $MatrixPath -PathType Leaf) {
            $row = Import-Csv -Path $MatrixPath | Where-Object { $_.checkId -eq $registryKey } | Select-Object -First 1
            if (($null -ne $row) -and (-not [string]::IsNullOrWhiteSpace($row.specStatus))) {
                $specStatus = [string]$row.specStatus
            }
        }

        $eligible = $specStatus -eq 'approved'
        $reason = 'not-validated'
        if ($eligible) { $reason = 'approved' }

        [PSCustomObject]@{
            CheckId     = $CheckId
            RegistryKey = $registryKey
            SpecStatus  = $specStatus
            Eligible    = $eligible
            Reason      = $reason
            MatrixPath  = $MatrixPath
        }
    }
}

function Set-RemediationValidationStatus {
    <#
    .SYNOPSIS
        Records a harness result in remediation-matrix.csv (merge-preserving).
    .DESCRIPTION
        Moves one check along specStatus (not-started to drafted to approved)
        per the generator contract in generate-matrix.py: the CSV is keyed on
        checkId, so only the matched row's specStatus (and ticket when given)
        is touched and every other row and column round-trips unchanged.
    .PARAMETER CheckId
        The finding CheckId, with or without the sub-number suffix.
    .PARAMETER SpecStatus
        The validated status to record: not-started, drafted, or approved.
    .PARAMETER MatrixPath
        Path to remediation-matrix.csv. Defaults to the repository matrix.
    .PARAMETER Ticket
        Optional child ticket id recorded in the ticket column.
    .OUTPUTS
        [PSCustomObject] the updated matrix row.
    .EXAMPLE
        Set-RemediationValidationStatus -CheckId 'SPO-SHARING-001' -SpecStatus 'approved'
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [string]$CheckId,

        [Parameter(Mandatory)]
        [ValidateSet('not-started', 'drafted', 'approved')]
        [string]$SpecStatus,

        [Parameter()]
        [string]$MatrixPath,

        [Parameter()]
        [string]$Ticket
    )

    process {
        $registryKey = $CheckId -replace '\.\d+$', ''
        if (-not $MatrixPath) { $MatrixPath = $script:RemediationValidationMatrixPath }
        if (-not (Test-Path -Path $MatrixPath -PathType Leaf)) {
            throw [System.IO.FileNotFoundException]::new("Remediation matrix not found: $MatrixPath.")
        }

        $rows = @(Import-Csv -Path $MatrixPath)
        $match = $rows | Where-Object { $_.checkId -eq $registryKey } | Select-Object -First 1
        if ($null -eq $match) {
            throw [System.ArgumentException]::new("CheckId '$registryKey' is not present in the remediation matrix.")
        }

        $match.specStatus = $SpecStatus
        if (-not [string]::IsNullOrWhiteSpace($Ticket)) { $match.ticket = $Ticket }
        $rows | Export-Csv -Path $MatrixPath -NoTypeInformation -UseQuotes AsNeeded -Encoding UTF8

        $match
    }
}

function New-RemediationValidationDoc {
    <#
    .SYNOPSIS
        Authors the auto/NNN-<checkId>.md spec for a validated check.
    .DESCRIPTION
        Writes the per-control automated remediation spec described in
        02-controls/README.md section 4, following the
        auto/001-COMPLIANCE-AUDIT-001.md exemplar: desired state, validated
        command, preconditions, before/after capture, verification, rollback,
        test plan, plus the harness validation result. Numbering NNN is
        sequential within auto/ ordered by checkId; an existing doc for the
        check keeps its number and is left untouched unless -Force is given,
        so human edits are never clobbered by re-runs.
    .PARAMETER CheckId
        The finding CheckId, with or without the sub-number suffix.
    .PARAMETER ValidationRecord
        Test-RemediationCommand output recorded in the Validation result
        section. Optional; the doc states not-yet-validated when omitted.
    .PARAMETER AutoDir
        Directory holding auto/ specs. Defaults to the repository auto/.
    .PARAMETER RegistryPath
        Path to controls/registry.json. Defaults to the module registry.
    .PARAMETER Force
        Rewrite the doc when one already exists for the check.
    .OUTPUTS
        [PSCustomObject] with CheckId, RegistryKey, Path, and Created.
    .EXAMPLE
        New-RemediationValidationDoc -CheckId 'SPO-SHARING-001' -ValidationRecord $record
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, ValueFromPipelineByPropertyName)]
        [ValidateNotNullOrEmpty()]
        [string]$CheckId,

        [Parameter()]
        [object]$ValidationRecord,

        [Parameter()]
        [string]$AutoDir,

        [Parameter()]
        [string]$RegistryPath,

        [Parameter()]
        [switch]$Force
    )

    process {
        $registryKey = $CheckId -replace '\.\d+$', ''
        if (-not $AutoDir) { $AutoDir = $script:RemediationValidationAutoDir }
        if (-not $RegistryPath) { $RegistryPath = $script:RemediationCommandRegistryPath }
        if (-not (Test-Path -Path $RegistryPath -PathType Leaf)) {
            throw [System.IO.FileNotFoundException]::new("Control registry not found: $RegistryPath.")
        }

        $raw = Get-Content -Path $RegistryPath -Raw | ConvertFrom-Json
        $entry = @($raw.checks) | Where-Object { $_.checkId -eq $registryKey } | Select-Object -First 1
        if ($null -eq $entry) {
            throw [System.ArgumentException]::new("CheckId '$registryKey' is not present in the control registry.")
        }

        if (-not (Test-Path -Path $AutoDir)) {
            New-Item -ItemType Directory -Path $AutoDir -Force | Out-Null
        }

        $existing = Get-ChildItem -Path $AutoDir -File -Filter '*.md' | Where-Object {
            $_.BaseName -match ('^\d+-' + [regex]::Escape($registryKey) + '$')
        } | Select-Object -First 1
        if (($null -ne $existing) -and (-not $Force.IsPresent)) {
            [PSCustomObject]@{
                CheckId     = $CheckId
                RegistryKey = $registryKey
                Path        = $existing.FullName
                Created     = $false
            }
            return
        }

        $docPath = $null
        if ($null -ne $existing) {
            $docPath = $existing.FullName
        }
        else {
            $numbers = @(Get-ChildItem -Path $AutoDir -File -Filter '*.md' | ForEach-Object {
                    if ($_.BaseName -match '^(\d+)-') { [int]$Matches[1] }
                })
            $sequence = 1
            if ($numbers.Count -gt 0) { $sequence = ($numbers | Measure-Object -Maximum).Maximum + 1 }
            $docPath = Join-Path -Path $AutoDir -ChildPath (('{0:000}' -f $sequence) + '-' + $registryKey + '.md')
        }

        $name = [string]$entry.name
        $severity = [string]$entry.impactRating.severity
        $license = [string]$entry.licensing.minimum
        $collector = [string]$entry.collector
        $category = [string]$entry.category
        $command = [string]$entry.remediation.powershell.command
        $portalPath = [string]$entry.remediation.portal.path
        $notes = [string]$entry.remediation.notes

        $validationLine = 'Not yet validated — `specStatus` stays `not-started` until the harness approves it.'
        $validationSection = '- **Validated:** $false (harness has not approved this command yet).'
        $recordStatus = 'not-started'
        if ($null -ne $ValidationRecord) {
            if ([bool]$ValidationRecord.Validated) {
                $validationLine = 'Validated ' + [string]$ValidationRecord.ValidatedAt + ' via `Test-RemediationCommand`.'
                $recordStatus = 'approved'
            }
            elseif (-not [string]::IsNullOrWhiteSpace([string]$ValidationRecord.SpecStatus)) {
                $recordStatus = [string]$ValidationRecord.SpecStatus
            }
            $validationSection = '- **Validated:** ' + [string][bool]$ValidationRecord.Validated + ' at ' + [string]$ValidationRecord.ValidatedAt + "`n" + `
                '- **Command runs:** ' + [string][bool]$ValidationRecord.CommandRuns + "`n" + `
                '- **Idempotent:** ' + [string][bool]$ValidationRecord.IsIdempotent + "`n" + `
                '- **Before/after captured:** ' + [string][bool]$ValidationRecord.BeforeAfterCaptured + "`n" + `
                '- **Gates expressible:** ' + [string][bool]$ValidationRecord.GatesExpressible + "`n" + `
                '- **Reason:** ' + [string]$ValidationRecord.Reason + "`n" + `
                '- **specStatus:** ' + $recordStatus
        }

        $rollbackNotes = 'Reverse with the inverse of the command above; record the reversal as its own `RemediationAction`.'
        if (-not [string]::IsNullOrWhiteSpace($notes)) { $rollbackNotes = $notes }

        $doc = @"
# $registryKey — $name

- **Mode:** automated
- **Severity:** $severity
- **License:** $license
- **Collector:** $collector
- **Category:** $category
- **Registry:** ``src/M365-Assess/controls/registry.json`` → checkId ``$registryKey``
- **Command source:** ``remediation.powershell.command`` (registry)
- **Validation:** $validationLine

## Desired state

$name. The tenant converges on:

````powershell
$command
````

## Command

````powershell
$command
````

- Deterministic, idempotent (re-running on an already-remediated tenant is a no-op).
- Runs inside the tenant's connected child process through the typed executor
  (``Invoke-RemediationAction``), never from string evaluation.
- **Must be hand-validated against a real tenant before the apply path ships**
  (``00-guides/06-remediation.md`` §2.2). This doc records the validation result.

## Preconditions

| Gate | Requirement |
|---|---|
| License | $license minimum (registry ``licensing.minimum``) |
| Service | $collector section connected |
| RBAC | Caller holds an allowlisted remediation permission |
| Scope | Tenant in caller's ``UserScope`` |
| Allowlist | ``$registryKey`` on the remediation allowlist |
| Tenant flag | Tenant not marked read-only |
| Validation | Matrix ``specStatus`` is ``approved`` (``Test-RemediationApplyEligibility``) |

## Before / After capture

- **Before:** current state read via the typed state reader before apply.
- **After:** same reader, re-read after apply; both recorded on the validation
  record and the ``RemediationAction``.
- Portal equivalent: $portalPath

## Verification

- Re-run the ``$collector`` collector and confirm ``$registryKey`` reports ``Pass``.

## Rollback / safety

- $rollbackNotes

## Test plan

- [ ] Unit: gate — a tenant missing $license is ``skipped`` with ``license-missing``.
- [ ] Unit: gate — a non-allowlisted checkId is ``skipped`` with ``not-allowlisted``.
- [ ] Unit: gate — a non-approved checkId is ineligible with ``not-validated``.
- [ ] Unit: idempotency — second apply converges on the same state.
- [ ] Integration (live tenant, gated): apply changes the setting; re-check passes.
- [ ] Audit: ``before``/``after``/command/actor/timestamp recorded.

## Validation result

$validationSection
"@

        Set-Content -Path $docPath -Value $doc -Encoding UTF8

        [PSCustomObject]@{
            CheckId     = $CheckId
            RegistryKey = $registryKey
            Path        = $docPath
            Created     = ($null -eq $existing)
        }
    }
}
