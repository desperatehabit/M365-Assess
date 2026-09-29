BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Remove-SharingLinks.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/remove-sharing-links.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body, $ContentType)
    }

    . $script:worker
}

Describe 'Remove-SharingLinks worker (T-0527)' {

    Context 'the worker files' {
        It 'ships the worker function and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Remove-SharingLinks -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'entrypoint delegates to the worker and emits the response as JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Remove-SharingLinks\.ps1'
            $entrySource | Should -Match 'Remove-SharingLinks @params'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'plan preview' {
        It 'returns the exact link set and performs no writes' {
            $links = @(
                [pscustomobject]@{ linkId = 'perm-1'; itemId = 'item-1'; driveId = 'drive-1'; linkType = 'anonymous' }
                [pscustomobject]@{ linkId = 'perm-2'; itemId = 'item-2'; driveId = 'drive-1'; linkType = 'organization' }
            )
            $removeCalls = [System.Collections.Generic.List[object]]::new()
            $plan = Remove-SharingLinks -TenantId 'tenant-a' -Links $links -Mode Plan `
                -RemoveLink { param($link) $removeCalls.Add($link); return @{ before = $link; after = $null } }

            $plan.mode | Should -Be 'plan'
            $plan.total | Should -Be 2
            $plan.writes | Should -BeFalse
            @($plan.links | ForEach-Object { $_.linkId }) | Should -Be @('perm-1', 'perm-2')
            $removeCalls.Count | Should -Be 0
        }

        It 'flags deferred direct permissions as skipped in the plan' {
            $links = @(
                [pscustomobject]@{ linkId = 'perm-9'; itemId = 'item-9'; driveId = 'drive-1'; linkType = 'direct' }
            )
            $plan = Remove-SharingLinks -TenantId 'tenant-a' -Links $links -Mode Plan

            $plan.links[0].eligible | Should -BeFalse
            $plan.links[0].skipReason | Should -Match 'deferred'
        }
    }

    Context 'confirmation gate' {
        It 'refuses to apply without a confirmation naming the count' {
            $links = @(
                [pscustomobject]@{ linkId = 'perm-1'; itemId = 'item-1'; driveId = 'drive-1'; linkType = 'anonymous' }
                [pscustomobject]@{ linkId = 'perm-2'; itemId = 'item-2'; driveId = 'drive-1'; linkType = 'anonymous' }
            )
            { Remove-SharingLinks -TenantId 'tenant-a' -Links $links -Mode Apply -ConfirmCount 1 } | Should -Throw '*confirm*'
            { Remove-SharingLinks -TenantId 'tenant-a' -Links $links -Mode Apply } | Should -Throw '*confirm*'
        }
    }

    Context 'apply with per-link results' {
        It 'removes every link, audits each one, and records the job' {
            $links = @(
                [pscustomobject]@{ linkId = 'perm-1'; itemId = 'item-1'; driveId = 'drive-1'; linkType = 'anonymous' }
                [pscustomobject]@{ linkId = 'perm-2'; itemId = 'item-2'; driveId = 'drive-1'; linkType = 'organization' }
            )
            $auditEvents = [System.Collections.Generic.List[object]]::new()
            $applied = Remove-SharingLinks -TenantId 'tenant-a' -Links $links -Mode Apply -ConfirmCount 2 `
                -Actor 'operator-1' -JobId 'job-1' `
                -RemoveLink { param($link) return @{ before = $link; after = $null } } `
                -WriteAudit { param($auditEvent) $auditEvents.Add($auditEvent) }

            $applied.state | Should -Be 'completed'
            $applied.summary.total | Should -Be 2
            $applied.summary.removed | Should -Be 2
            $applied.summary.failed | Should -Be 0
            @($applied.results | ForEach-Object { $_.state }) | Should -Be @('removed', 'removed')
            $auditEvents.Count | Should -Be 2
            @($auditEvents | ForEach-Object { $_.resourceId }) | Should -Be @('perm-1', 'perm-2')
            $applied.job.id | Should -Be 'job-1'
            $applied.job.tenantId | Should -Be 'tenant-a'
            $applied.job.state | Should -Be 'completed'
            @($applied.job.linkIds) | Should -Be @('perm-1', 'perm-2')
            @($applied.job.results).Count | Should -Be 2
        }

        It 'records a per-link failure without silencing it' {
            $links = @(
                [pscustomobject]@{ linkId = 'perm-1'; itemId = 'item-1'; driveId = 'drive-1'; linkType = 'anonymous' }
                [pscustomobject]@{ linkId = 'perm-2'; itemId = 'item-2'; driveId = 'drive-1'; linkType = 'anonymous' }
            )
            $applied = Remove-SharingLinks -TenantId 'tenant-a' -Links $links -Mode Apply -ConfirmCount 2 `
                -RemoveLink {
                    param($link)
                    if ([string]$link.linkId -eq 'perm-2') { throw 'graph refused the delete' }
                    return @{ before = $link; after = $null }
                }

            $applied.state | Should -Be 'failed'
            $applied.summary.removed | Should -Be 1
            $applied.summary.failed | Should -Be 1
            ($applied.results | Where-Object { $_.linkId -eq 'perm-1' }).state | Should -Be 'removed'
            ($applied.results | Where-Object { $_.linkId -eq 'perm-2' }).state | Should -Be 'failed'
            ($applied.results | Where-Object { $_.linkId -eq 'perm-2' }).error | Should -Match 'graph refused'
            $applied.job.state | Should -Be 'failed'
            @($applied.auditEvents).Count | Should -Be 2
        }

        It 'issues a DELETE per eligible link against the driveItem permission endpoint' {
            $links = @(
                [pscustomobject]@{ linkId = 'perm-1'; itemId = 'item-1'; driveId = 'drive-1'; linkType = 'anonymous' }
            )
            Mock Invoke-MgGraphRequest { return $null }
            $applied = Remove-SharingLinks -TenantId 'tenant-a' -Links $links -Mode Apply -ConfirmCount 1

            $applied.summary.removed | Should -Be 1
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter {
                $Method -eq 'DELETE' -and $Uri -eq '/v1.0/drives/drive-1/items/item-1/permissions/perm-1'
            }
        }
    }
}
