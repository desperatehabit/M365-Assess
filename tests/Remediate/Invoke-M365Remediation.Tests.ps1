BeforeAll {
    $script:moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../src/M365-Assess')).Path
    $script:remediateDir = Join-Path $script:moduleRoot 'Remediate'
    $script:entrypoint   = Join-Path $script:remediateDir 'Invoke-M365Remediation.ps1'
    $script:psm1         = Join-Path $script:moduleRoot 'M365-Assess.psm1'

    . (Join-Path $script:remediateDir 'Get-RemediationAllowlist.ps1')
    . (Join-Path $script:remediateDir 'Resolve-Remediation.ps1')
    . (Join-Path $script:remediateDir 'Test-RemediationGate.ps1')
    . (Join-Path $script:remediateDir 'Get-RemediationCommand.ps1')
    . (Join-Path $script:remediateDir 'Invoke-RemediationAction.ps1')
    . (Join-Path $script:remediateDir 'Test-RemediationCommand.ps1')
    . $script:entrypoint

    function New-TestCaller {
        param(
            [string[]]$Permissions = @('remediation.apply'),
            [string[]]$TenantIds = @('tenant-a')
        )
        @{
            Permissions = $Permissions
            TenantScope = @{
                All       = $false
                TenantIds = $TenantIds
            }
        }
    }

    function New-TestFinding {
        param(
            [string]$Id,
            [string]$CheckId,
            [string]$Status
        )
        [PSCustomObject]@{ Id = $Id; CheckId = $CheckId; Status = $Status }
    }
}

Describe 'Invoke-M365Remediation module surface (T-0890)' {

    Context 'module placement' {
        It 'ships as a file under the Remediate folder' {
            $script:entrypoint | Should -Exist
        }

        It 'is dot-sourced by the module loader' {
            $psm1Body = Get-Content -Path $script:psm1 -Raw
            $psm1Body | Should -Match 'Remediate[\\/]Invoke-M365Remediation\.ps1'
        }

        It 'is exported when the module loads' {
            Import-Module $script:psm1 -Force -ErrorAction Stop
            try {
                $module = Get-Module -Name M365-Assess -ErrorAction Stop
                $module.ExportedFunctions.Keys |
                    Should -Contain 'Invoke-M365Remediation'
            }
            finally {
                Remove-Module -Name M365-Assess -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'parameter surface' {
        It 'exposes the -Plan and -Apply switches' {
            $command = Get-Command -Name Invoke-M365Remediation
            $command.Parameters.Keys | Should -Contain 'Plan'
            $command.Parameters.Keys | Should -Contain 'Apply'
        }

        It 'supports ShouldProcess (-WhatIf / -Confirm)' {
            $command = Get-Command -Name Invoke-M365Remediation
            $command.Parameters.Keys | Should -Contain 'WhatIf'
            $command.Parameters.Keys | Should -Contain 'Confirm'
        }

        It 'no longer raises NotImplementedException for -Plan or -Apply' {
            $planError = $null
            try {
                $null = Invoke-M365Remediation -Plan -Findings @() -TenantId 'tenant-a' -AllowlistCheckIds @()
            }
            catch {
                $planError = $_
            }
            $planError | Should -BeNullOrEmpty

            $applyError = $null
            try {
                $null = Invoke-M365Remediation -Apply -Actions @() -Confirm:$false
            }
            catch {
                $applyError = $_
            }
            $applyError | Should -BeNullOrEmpty
        }
    }
}

Describe 'Invoke-M365Remediation -Plan (T-0890)' {

    Context 'classification' {
        It 'classifies automated, manual, and undetermined findings' {
            $findings = @(
                New-TestFinding -Id 'f1' -CheckId 'SPO-SHARING-001.1' -Status 'Fail'
                New-TestFinding -Id 'f2' -CheckId 'CA-DEVICE-001.2' -Status 'Fail'
                New-TestFinding -Id 'f3' -CheckId 'NOPE-UNKNOWN-999.1' -Status 'Fail'
            )
            $plan = Invoke-M365Remediation -Plan -Findings $findings -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('SPO-SHARING-001')

            $plan.Actions.Count | Should -Be 3
            $plan.Actions[0].result.mode | Should -Be 'automated'
            $plan.Actions[0].command | Should -Not -BeNullOrEmpty
            $plan.Actions[0].state | Should -Be 'planned'
            $plan.Actions[1].result.mode | Should -Be 'manual'
            $plan.Actions[1].target | Should -Not -BeNullOrEmpty
            $plan.Actions[2].result.mode | Should -Be 'undetermined'
            $plan.Actions[2].state | Should -Be 'skipped'
            $plan.Actions[2].error | Should -Match 'undetermined'
            $plan.Summary.automated | Should -Be 1
            $plan.Summary.manual | Should -Be 1
            $plan.Summary.undetermined | Should -Be 1
        }

        It 'strips the sub-number suffix before registry lookup' {
            $findings = @(
                New-TestFinding -Id 'f1' -CheckId 'SPO-SHARING-001.2' -Status 'Fail'
            )
            $plan = Invoke-M365Remediation -Plan -Findings $findings -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('SPO-SHARING-001')

            $plan.Actions[0].result.registryKey | Should -Be 'SPO-SHARING-001'
            $plan.Actions[0].result.mode | Should -Be 'automated'
        }

        It 'excludes findings whose status is not selected' {
            $findings = @(
                New-TestFinding -Id 'f1' -CheckId 'SPO-SHARING-001.1' -Status 'Pass'
                New-TestFinding -Id 'f2' -CheckId 'SPO-SHARING-001.2' -Status 'Warning'
            )
            $plan = Invoke-M365Remediation -Plan -Findings $findings -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('SPO-SHARING-001')

            $plan.Actions.Count | Should -Be 1
            $plan.Actions[0].checkId | Should -Be 'SPO-SHARING-001.2'
            $plan.Summary.total | Should -Be 1
        }
    }

    Context 'gates' {
        It 'marks an allowlisted automated action planned' {
            $findings = @(
                New-TestFinding -Id 'f1' -CheckId 'SPO-SHARING-001.1' -Status 'Fail'
            )
            $plan = Invoke-M365Remediation -Plan -Findings $findings -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('SPO-SHARING-001')

            $plan.Actions[0].state | Should -Be 'planned'
            $plan.Actions[0].result.gateDecision | Should -Be 'planned'
            $plan.Summary.skipped | Should -Be 0
        }

        It 'skips a non-allowlisted automated action with the gate reason' {
            $findings = @(
                New-TestFinding -Id 'f1' -CheckId 'SPO-SHARING-001.1' -Status 'Fail'
            )
            $plan = Invoke-M365Remediation -Plan -Findings $findings -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('ENTRA-GUEST-001')

            $plan.Actions[0].state | Should -Be 'skipped'
            $plan.Actions[0].result.gateDecision | Should -Be 'skipped'
            $plan.Actions[0].result.gateReason | Should -Be 'not-allowlisted'
            $plan.Actions[0].error | Should -Be 'not-allowlisted'
            $plan.Summary.skipped | Should -Be 1
        }

        It 'rejects when the caller lacks the remediation.apply permission' {
            $findings = @(
                New-TestFinding -Id 'f1' -CheckId 'SPO-SHARING-001.1' -Status 'Fail'
            )
            $plan = Invoke-M365Remediation -Plan -Findings $findings -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller -Permissions @('remediation.read')) `
                -AllowlistCheckIds @('SPO-SHARING-001')

            $plan.Actions[0].state | Should -Be 'skipped'
            $plan.Actions[0].result.gateReason | Should -Be 'rbac-denied'
        }
    }

    Context 'plan shape' {
        It 'returns the SPEC plan entity with a generated id and deduped instructions' {
            $findings = @(
                New-TestFinding -Id 'f1' -CheckId 'CA-DEVICE-001.1' -Status 'Fail'
                New-TestFinding -Id 'f2' -CheckId 'CA-DEVICE-001.2' -Status 'Fail'
            )
            $plan = Invoke-M365Remediation -Plan -Findings $findings -TenantId 'tenant-a' `
                -RunId 'run-1' -CreatedBy 'tester'

            $plan.Plan.id | Should -Not -BeNullOrEmpty
            $plan.Plan.tenantId | Should -Be 'tenant-a'
            $plan.Plan.runId | Should -Be 'run-1'
            $plan.Plan.createdBy | Should -Be 'tester'
            $plan.Plan.mode | Should -Be 'manual'
            $plan.Plan.findingIds.Count | Should -Be 2
            $plan.Plan.findingIds[0] | Should -Be 'f1'
            $plan.Plan.findingIds[1] | Should -Be 'f2'
            $plan.Instructions.Count | Should -Be 1
            $plan.Instructions[0].checkId | Should -Be 'CA-DEVICE-001'
            $plan.Instructions[0].portalPath | Should -Not -BeNullOrEmpty
        }

        It 'reports a mixed plan mode when automated and manual findings combine' {
            $findings = @(
                New-TestFinding -Id 'f1' -CheckId 'SPO-SHARING-001.1' -Status 'Fail'
                New-TestFinding -Id 'f2' -CheckId 'CA-DEVICE-001.1' -Status 'Fail'
            )
            $plan = Invoke-M365Remediation -Plan -Findings $findings -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('SPO-SHARING-001')

            $plan.Plan.mode | Should -Be 'mixed'
        }

        It 'returns an empty plan for no findings' {
            $plan = Invoke-M365Remediation -Plan -Findings @() -TenantId 'tenant-a'

            $plan.Actions.Count | Should -Be 0
            $plan.Summary.total | Should -Be 0
            $plan.Plan.id | Should -Not -BeNullOrEmpty
        }
    }
}

Describe 'Invoke-M365Remediation -Apply (T-0890)' {

    Context 'validation hard gate' {
        It 'skips every action when the matrix has not approved the check' {
            $actions = @(
                [PSCustomObject]@{ id = 'a1'; checkId = 'SPO-SHARING-001.1'; command = 'Set-SPOTenant' }
            )
            $result = Invoke-M365Remediation -Apply -Actions $actions -TenantId 'tenant-a' -Confirm:$false

            $result.Results.Count | Should -Be 1
            $result.Results[0].state | Should -Be 'skipped'
            $result.Results[0].error | Should -Match 'not-approved'
            $result.Summary.skipped | Should -Be 1
            $result.Summary.applied | Should -Be 0
        }
    }

    Context 'gated execution' {
        It 'applies an approved action through the injected executor with before/after' {
            $actions = @(
                [PSCustomObject]@{ id = 'a1'; checkId = 'SPO-SHARING-001.1'; command = 'Set-SPOTenant' }
            )
            $eligibility = {
                param($CheckId)
                [PSCustomObject]@{ CheckId = $CheckId; Eligible = $true; SpecStatus = 'approved' }
            }
            $executor = {
                param($action)
                [PSCustomObject]@{
                    State = 'applied'; Before = 'ExternalUserSharingOnly'
                    After = 'ExistingExternalUserSharingOnly'; Reason = $null
                }
            }
            $result = Invoke-M365Remediation -Apply -Actions $actions -TenantId 'tenant-a' `
                -Actor 'tester' -Confirm:$false -TestEligibility $eligibility -ExecuteAction $executor

            $result.Results.Count | Should -Be 1
            $result.Results[0].state | Should -Be 'applied'
            $result.Results[0].before | Should -Be 'ExternalUserSharingOnly'
            $result.Results[0].after | Should -Be 'ExistingExternalUserSharingOnly'
            $result.Results[0].actor | Should -Be 'tester'
            $result.Results[0].appliedAt | Should -Not -BeNullOrEmpty
            $result.Summary.applied | Should -Be 1
            $result.StoppedOnFailure | Should -BeFalse
        }

        It 'stops the batch on first failure by default' {
            $actions = @(
                [PSCustomObject]@{ id = 'a1'; checkId = 'SPO-SHARING-001.1'; command = 'Set-SPOTenant' }
                [PSCustomObject]@{ id = 'a2'; checkId = 'SPO-SHARING-004.1'; command = 'Set-SPOTenant' }
            )
            $eligibility = {
                param($CheckId)
                [PSCustomObject]@{ CheckId = $CheckId; Eligible = $true; SpecStatus = 'approved' }
            }
            $executor = {
                param($action)
                if ($action.id -eq 'a1') {
                    [PSCustomObject]@{ State = 'failed'; Before = $null; After = $null; Reason = 'boom' }
                }
                else {
                    [PSCustomObject]@{ State = 'applied'; Before = 'x'; After = 'y'; Reason = $null }
                }
            }
            $result = Invoke-M365Remediation -Apply -Actions $actions -TenantId 'tenant-a' `
                -Confirm:$false -TestEligibility $eligibility -ExecuteAction $executor

            $result.Results[0].state | Should -Be 'failed'
            $result.Results[0].error | Should -Be 'boom'
            $result.Results[1].state | Should -Be 'skipped'
            $result.Results[1].error | Should -Be 'batch-stopped'
            $result.Summary.failed | Should -Be 1
            $result.Summary.skipped | Should -Be 1
            $result.StoppedOnFailure | Should -BeTrue
        }

        It 'continues past a failure when -ContinueOnFailure is set' {
            $actions = @(
                [PSCustomObject]@{ id = 'a1'; checkId = 'SPO-SHARING-001.1'; command = 'Set-SPOTenant' }
                [PSCustomObject]@{ id = 'a2'; checkId = 'SPO-SHARING-004.1'; command = 'Set-SPOTenant' }
            )
            $eligibility = {
                param($CheckId)
                [PSCustomObject]@{ CheckId = $CheckId; Eligible = $true; SpecStatus = 'approved' }
            }
            $executor = {
                param($action)
                if ($action.id -eq 'a1') {
                    [PSCustomObject]@{ State = 'failed'; Before = $null; After = $null; Reason = 'boom' }
                }
                else {
                    [PSCustomObject]@{ State = 'applied'; Before = 'x'; After = 'y'; Reason = $null }
                }
            }
            $result = Invoke-M365Remediation -Apply -Actions $actions -TenantId 'tenant-a' `
                -ContinueOnFailure -Confirm:$false -TestEligibility $eligibility -ExecuteAction $executor

            $result.Results[0].state | Should -Be 'failed'
            $result.Results[1].state | Should -Be 'applied'
            $result.Summary.applied | Should -Be 1
            $result.Summary.failed | Should -Be 1
            $result.StoppedOnFailure | Should -BeFalse
        }

        It 'records a gate-skipped action without executing it' {
            $store = @{ SharingCapability = 'ExternalUserSharingOnly'; Applied = $false }
            $getState = { $store.SharingCapability }.GetNewClosure()
            $applyChange = {
                $store.Applied = $true
                $store.SharingCapability = 'ExistingExternalUserSharingOnly'
                $store.SharingCapability
            }.GetNewClosure()
            $actions = @(
                [PSCustomObject]@{ id = 'a1'; checkId = 'SPO-SHARING-001.1'; command = 'Set-SPOTenant' }
            )
            $eligibility = {
                param($CheckId)
                [PSCustomObject]@{ CheckId = $CheckId; Eligible = $true; SpecStatus = 'approved' }
            }
            $testCaller = New-TestCaller
            $realExecutor = {
                param($action)
                Invoke-RemediationAction -CheckId $action.checkId -TenantId 'tenant-a' `
                    -CallerContext $testCaller -AllowlistCheckIds @() `
                    -GetState $getState -ApplyChange $applyChange -Confirm:$false
            }.GetNewClosure()
            $result = Invoke-M365Remediation -Apply -Actions $actions -TenantId 'tenant-a' `
                -Confirm:$false -TestEligibility $eligibility -ExecuteAction $realExecutor

            $result.Results[0].state | Should -Be 'skipped'
            $result.Results[0].error | Should -Be 'not-allowlisted'
            $store.Applied | Should -BeFalse
            $store.SharingCapability | Should -Be 'ExternalUserSharingOnly'
        }
    }

    Context 'confirmation and dry run' {
        It 'returns early under -WhatIf without executing' {
            $actions = @(
                [PSCustomObject]@{ id = 'a1'; checkId = 'SPO-SHARING-001.1'; command = 'Set-SPOTenant' }
            )
            $executor = {
                param($action)
                [PSCustomObject]@{ State = 'applied'; Before = 'x'; After = 'y'; Reason = $null }
            }
            $result = Invoke-M365Remediation -Apply -Actions $actions -TenantId 'tenant-a' `
                -WhatIf -TestEligibility { param($c) [PSCustomObject]@{ Eligible = $true; SpecStatus = 'approved' } } `
                -ExecuteAction $executor

            $result | Should -BeNullOrEmpty
        }

        It 'integrates with the real typed executor via the injected seam without a tenant' {
            $store = @{ SharingCapability = 'ExternalUserSharingOnly' }
            $getState = { $store.SharingCapability }.GetNewClosure()
            $applyChange = {
                $store.SharingCapability = 'ExistingExternalUserSharingOnly'
                $store.SharingCapability
            }.GetNewClosure()
            $actions = @(
                [PSCustomObject]@{ id = 'a1'; checkId = 'SPO-SHARING-001.1'; command = 'Set-SPOTenant' }
            )
            $eligibility = {
                param($CheckId)
                [PSCustomObject]@{ CheckId = $CheckId; Eligible = $true; SpecStatus = 'approved' }
            }
            $testCaller = New-TestCaller
            $realExecutor = {
                param($action)
                Invoke-RemediationAction -CheckId $action.checkId -TenantId 'tenant-a' `
                    -CallerContext $testCaller -AllowlistCheckIds @('SPO-SHARING-001') `
                    -GetState $getState -ApplyChange $applyChange -Confirm:$false
            }.GetNewClosure()
            $result = Invoke-M365Remediation -Apply -Actions $actions -TenantId 'tenant-a' `
                -Confirm:$false -TestEligibility $eligibility -ExecuteAction $realExecutor

            $result.Results[0].state | Should -Be 'applied'
            $result.Results[0].before | Should -Be 'ExternalUserSharingOnly'
            $result.Results[0].after | Should -Be 'ExistingExternalUserSharingOnly'
            $result.Results[0].command | Should -Be 'Set-SPOTenant'
            $store.SharingCapability | Should -Be 'ExistingExternalUserSharingOnly'
        }
    }
}
