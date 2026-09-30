# Invoke-VersionCleanup.Tests.ps1
# Pester tests for T-0487 — version cleanup with age threshold and manual override.
# Asserts: plan preview selects exactly the right versions (age threshold +
# include/exclude override), nothing is deleted on preview, the current version
# is always protected, apply requires a confirmation naming the count, and
# apply goes through the EPIC-006 gated executor (Invoke-RemediationApply).

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-VersionCleanup.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-version-cleanup.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Invoke-VersionCleanup worker (T-0487)' {

    Context 'the worker files' {
        It 'ships the worker function and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-VersionCleanup -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'entrypoint delegates to the worker and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Invoke-VersionCleanup\.ps1'
            $entrySource | Should -Match 'Invoke-VersionCleanup @params'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'plan preview' {
        BeforeEach {
            $script:RemoveCalls = [System.Collections.Generic.List[object]]::new()
            $script:AuditEvents = [System.Collections.Generic.List[object]]::new()
        }

        It 'selects versions older than the age threshold and performs no writes' {
            $versions = @(
                [pscustomobject]@{ versionId = 'v1'; itemId = 'item-1'; siteId = 'site-1'; size = 1024; lastModified = '2020-01-01T00:00:00Z'; isCurrent = $false }
                [pscustomobject]@{ versionId = 'v2'; itemId = 'item-1'; siteId = 'site-1'; size = 2048; lastModified = '2026-09-01T00:00:00Z'; isCurrent = $true }
            )
            $plan = Invoke-VersionCleanup -TenantId 'tenant-a' -SiteId 'site-1' -AgeThresholdDays 90 -Mode Plan `
                -ListVersions { param($SiteId) return $versions } `
                -RemoveVersion { param($v) $script:RemoveCalls.Add($v); return @{ before = $v; after = $null } } `
                -WriteAudit { param($e) $script:AuditEvents.Add($e) }

            $plan.mode | Should -Be 'plan'
            $plan.state | Should -Be 'planned'
            $plan.writes | Should -BeFalse
            $plan.selectedCount | Should -Be 1
            ($plan.versions | Where-Object { $_.selected }).versionId | Should -Be 'v1'
            ($plan.versions | Where-Object { -not $_.selected }).versionId | Should -Be 'v2'
            $script:RemoveCalls.Count | Should -Be 0
            $script:AuditEvents.Count | Should -Be 0
        }

        It 'honors the manual include override for newer versions' {
            $versions = @(
                [pscustomobject]@{ versionId = 'v1'; itemId = 'item-1'; siteId = 'site-1'; size = 1024; lastModified = '2026-09-01T00:00:00Z'; isCurrent = $false }
                [pscustomobject]@{ versionId = 'v2'; itemId = 'item-1'; siteId = 'site-1'; size = 2048; lastModified = '2026-09-01T00:00:00Z'; isCurrent = $false }
            )
            $plan = Invoke-VersionCleanup -TenantId 'tenant-a' -SiteId 'site-1' -AgeThresholdDays 90 -Mode Plan `
                -IncludeVersions @('v1') `
                -ListVersions { param($SiteId) return $versions } `
                -RemoveVersion { param($v) $script:RemoveCalls.Add($v); return @{ before = $v; after = $null } } `
                -WriteAudit { param($e) $script:AuditEvents.Add($e) }

            $plan.selectedCount | Should -Be 1
            ($plan.versions | Where-Object { $_.selected }).versionId | Should -Be 'v1'
            $script:RemoveCalls.Count | Should -Be 0
        }

        It 'honors the manual exclude override for older versions' {
            $versions = @(
                [pscustomobject]@{ versionId = 'v1'; itemId = 'item-1'; siteId = 'site-1'; size = 1024; lastModified = '2020-01-01T00:00:00Z'; isCurrent = $false }
                [pscustomobject]@{ versionId = 'v2'; itemId = 'item-1'; siteId = 'site-1'; size = 2048; lastModified = '2020-01-01T00:00:00Z'; isCurrent = $false }
            )
            $plan = Invoke-VersionCleanup -TenantId 'tenant-a' -SiteId 'site-1' -AgeThresholdDays 90 -Mode Plan `
                -ExcludeVersions @('v1') `
                -ListVersions { param($SiteId) return $versions } `
                -RemoveVersion { param($v) $script:RemoveCalls.Add($v); return @{ before = $v; after = $null } } `
                -WriteAudit { param($e) $script:AuditEvents.Add($e) }

            $plan.selectedCount | Should -Be 1
            ($plan.versions | Where-Object { $_.selected }).versionId | Should -Be 'v2'
            ($plan.versions | Where-Object { $_.versionId -eq 'v1' }).reason | Should -Be 'excluded-by-operator'
            $script:RemoveCalls.Count | Should -Be 0
        }

        It 'never selects the current version even when included' {
            $versions = @(
                [pscustomobject]@{ versionId = 'v1'; itemId = 'item-1'; siteId = 'site-1'; size = 1024; lastModified = '2026-09-01T00:00:00Z'; isCurrent = $true }
            )
            $plan = Invoke-VersionCleanup -TenantId 'tenant-a' -SiteId 'site-1' -AgeThresholdDays 90 -Mode Plan `
                -IncludeVersions @('v1') `
                -ListVersions { param($SiteId) return $versions } `
                -RemoveVersion { param($v) $script:RemoveCalls.Add($v); return @{ before = $v; after = $null } } `
                -WriteAudit { param($e) $script:AuditEvents.Add($e) }

            $plan.selectedCount | Should -Be 0
            ($plan.versions[0]).reason | Should -Be 'current-version-protected'
            $script:RemoveCalls.Count | Should -Be 0
        }
    }

    Context 'confirmation gate' {
        It 'refuses to apply without a confirmation naming the count' {
            $versions = @(
                [pscustomobject]@{ versionId = 'v1'; itemId = 'item-1'; siteId = 'site-1'; size = 1024; lastModified = '2020-01-01T00:00:00Z'; isCurrent = $false }
                [pscustomobject]@{ versionId = 'v2'; itemId = 'item-1'; siteId = 'site-1'; size = 2048; lastModified = '2020-01-01T00:00:00Z'; isCurrent = $false }
            )
            { Invoke-VersionCleanup -TenantId 'tenant-a' -SiteId 'site-1' -Mode Apply -ConfirmCount 1 `
                -ListVersions { param($SiteId) return $versions } } | Should -Throw '*confirm*'
            { Invoke-VersionCleanup -TenantId 'tenant-a' -SiteId 'site-1' -Mode Apply `
                -ListVersions { param($SiteId) return $versions } } | Should -Throw '*confirm*'
        }
    }

    Context 'apply through the gated executor' {
        BeforeEach {
            $script:RemoveCalls = [System.Collections.Generic.List[object]]::new()
            $script:AuditEvents = [System.Collections.Generic.List[object]]::new()
            $script:ExecutorCalls = [System.Collections.Generic.List[object]]::new()
        }

        It 'applies through Invoke-RemediationApply with one action per version' {
            $versions = @(
                [pscustomobject]@{ versionId = 'v1'; itemId = 'item-1'; siteId = 'site-1'; size = 1024; lastModified = '2020-01-01T00:00:00Z'; isCurrent = $false }
                [pscustomobject]@{ versionId = 'v2'; itemId = 'item-1'; siteId = 'site-1'; size = 2048; lastModified = '2020-01-01T00:00:00Z'; isCurrent = $false }
            )

            Mock Invoke-RemediationApply {
                param($Actions, $PlanId, $TenantId, $DryRun, $Actor, $CorrelationId, $TestEligibility, $ExecuteAction, $UpdateAction, $WriteAudit)
                $script:ExecutorCalls.Add(@{ Actions = $Actions; PlanId = $PlanId; TenantId = $TenantId })
                $results = New-Object System.Collections.Generic.List[object]
                foreach ($action in $Actions) {
                    $execResult = & $ExecuteAction $action
                    $results.Add([pscustomobject]@{
                        actionId = [string]$action.id
                        checkId  = [string]$action.checkId
                        state    = [string]$execResult.State
                        before   = $execResult.Before
                        after    = $execResult.After
                        appliedAt = $execResult.AppliedAt
                        actor    = $Actor
                        error    = $null
                        dryRun   = $false
                    }) | Out-Null
                    & $WriteAudit ([pscustomobject]@{
                        action = 'remediation.apply'; result = 'success'; tenantId = $TenantId
                        resourceId = [string]$action.id; actorUserId = $Actor
                    })
                }
                return [pscustomobject]@{
                    PlanId = $PlanId
                    TenantId = $TenantId
                    Results = $results.ToArray()
                    Summary = [pscustomobject]@{ total = $Actions.Count; applied = $Actions.Count; failed = 0; skipped = 0 }
                }
            }

            $applied = Invoke-VersionCleanup -TenantId 'tenant-a' -SiteId 'site-1' -Mode Apply -ConfirmCount 2 `
                -Actor 'operator-1' -JobId 'job-1' `
                -ListVersions { param($SiteId) return $versions } `
                -RemoveVersion { param($v) $script:RemoveCalls.Add($v); return @{ before = $v; after = $null } } `
                -WriteAudit { param($e) $script:AuditEvents.Add($e) }

            $applied.mode | Should -Be 'apply'
            $applied.state | Should -Be 'completed'
            $applied.summary.total | Should -Be 2
            $applied.summary.removed | Should -Be 2
            $script:ExecutorCalls.Count | Should -Be 1
            $script:ExecutorCalls[0].TenantId | Should -Be 'tenant-a'
            @($script:ExecutorCalls[0].Actions | ForEach-Object { $_.id }) | Should -Be @('v1', 'v2')
            $script:RemoveCalls.Count | Should -Be 2
            @($applied.auditEvents).Count | Should -Be 2
            $applied.job.id | Should -Be 'job-1'
            $applied.job.state | Should -Be 'completed'
            @($applied.job.versionIds) | Should -Be @('v1', 'v2')
        }

        It 'records a per-version failure without silencing it' {
            $versions = @(
                [pscustomobject]@{ versionId = 'v1'; itemId = 'item-1'; siteId = 'site-1'; size = 1024; lastModified = '2020-01-01T00:00:00Z'; isCurrent = $false }
                [pscustomobject]@{ versionId = 'v2'; itemId = 'item-1'; siteId = 'site-1'; size = 2048; lastModified = '2020-01-01T00:00:00Z'; isCurrent = $false }
            )

            Mock Invoke-RemediationApply {
                param($Actions, $PlanId, $TenantId, $DryRun, $Actor, $CorrelationId, $TestEligibility, $ExecuteAction, $UpdateAction, $WriteAudit)
                $results = New-Object System.Collections.Generic.List[object]
                foreach ($action in $Actions) {
                    if ([string]$action.id -eq 'v2') {
                        $results.Add([pscustomobject]@{
                            actionId = [string]$action.id; checkId = [string]$action.checkId
                            state = 'failed'; before = $null; after = $null
                            appliedAt = [DateTime]::UtcNow.ToString('o'); actor = $Actor
                            error = 'graph refused the delete'; dryRun = $false
                        }) | Out-Null
                        & $WriteAudit ([pscustomobject]@{
                            action = 'remediation.apply'; result = 'failure'; tenantId = $TenantId
                            resourceId = [string]$action.id; error = 'graph refused the delete'; actorUserId = $Actor
                        })
                    } else {
                        $execResult = & $ExecuteAction $action
                        $results.Add([pscustomobject]@{
                            actionId = [string]$action.id; checkId = [string]$action.checkId
                            state = [string]$execResult.State; before = $execResult.Before; after = $execResult.After
                            appliedAt = $execResult.AppliedAt; actor = $Actor; error = $null; dryRun = $false
                        }) | Out-Null
                        & $WriteAudit ([pscustomobject]@{
                            action = 'remediation.apply'; result = 'success'; tenantId = $TenantId
                            resourceId = [string]$action.id; actorUserId = $Actor
                        })
                    }
                }
                return [pscustomobject]@{
                    PlanId = $PlanId
                    TenantId = $TenantId
                    Results = $results.ToArray()
                    Summary = [pscustomobject]@{ total = $Actions.Count; applied = 1; failed = 1; skipped = 0 }
                }
            }

            $applied = Invoke-VersionCleanup -TenantId 'tenant-a' -SiteId 'site-1' -Mode Apply -ConfirmCount 2 `
                -ListVersions { param($SiteId) return $versions } `
                -RemoveVersion { param($v) $script:RemoveCalls.Add($v); return @{ before = $v; after = $null } } `
                -WriteAudit { param($e) $script:AuditEvents.Add($e) }

            $applied.state | Should -Be 'failed'
            $applied.summary.removed | Should -Be 1
            $applied.summary.failed | Should -Be 1
            ($applied.results | Where-Object { $_.versionId -eq 'v1' }).state | Should -Be 'applied'
            ($applied.results | Where-Object { $_.versionId -eq 'v2' }).state | Should -Be 'failed'
            ($applied.results | Where-Object { $_.versionId -eq 'v2' }).error | Should -Match 'graph refused'
            $script:RemoveCalls.Count | Should -Be 1
        }
    }

    Context 'the entrypoint in direct mode' {
        It 'runs the handler and emits the plan as JSON' {
            $versions = @(
                [pscustomobject]@{ versionId = 'v1'; itemId = 'item-1'; siteId = 'site-1'; size = 1024; lastModified = '2020-01-01T00:00:00Z'; isCurrent = $false }
            )

            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Uri -like '/v1.0/sites/*/drive/items/*/versions*') {
                    return @{
                        value = @(
                            @{ id = 'v1'; size = 2048; lastModifiedDateTime = '2026-09-01T00:00:00Z' }
                            @{ id = 'v2'; size = 1024; lastModifiedDateTime = '2020-01-01T00:00:00Z' }
                        )
                    }
                }
                if ($Uri -like '/v1.0/sites/*/drive/items*') {
                    return @{ value = @(@{ id = 'item-1' }) }
                }
                return @{ value = @() }
            }

            $output = & $script:entrypoint -TenantId 'tenant-a' -SiteId 'site-1' -Mode Plan
            $plan = $output | ConvertFrom-Json
            $plan.mode | Should -Be 'plan'
            $plan.selectedCount | Should -Be 1
            ($plan.versions | Where-Object { $_.selected }).versionId | Should -Be 'v2'
        }
    }
}
