BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-SharePointSiteAction.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-sharepoint-site-action.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker

    function script:New-ActionMock {
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body)
            $key = "$Method $Uri"
            if ($key -like 'GET /v1.0/groups/site-live*') {
                return @{
                    id          = 'site-live'
                    displayName = 'Project Alpha'
                    mail        = 'project-alpha.example.invalid'
                    visibility  = 'Public'
                }
            }
            if ($key -like 'GET /v1.0/directory/deletedItems/site-deleted') {
                return @{
                    id              = 'site-deleted'
                    displayName     = 'Retired Site'
                    mail            = 'retired.example.invalid'
                    deletedDateTime = ((Get-Date).ToUniversalTime().AddDays(-10))
                }
            }
            if ($key -like 'GET /v1.0/directory/deletedItems/microsoft.graph.group') {
                return @(
                    @{
                        id              = 'recycled-1'
                        displayName     = 'Recycled One'
                        mail            = 'one.example.invalid'
                        deletedDateTime = ((Get-Date).ToUniversalTime().AddDays(-5))
                    }
                    @{
                        id              = 'recycled-2'
                        displayName     = 'Recycled Two'
                        deletedDateTime = ((Get-Date).ToUniversalTime().AddDays(-3))
                    }
                )
            }
            return $null
        }
    }
}

Describe 'Invoke-SharePointSiteAction worker (T-0485)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-SharePointSiteAction -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Invoke-SharePointSiteDelete -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Invoke-SharePointSiteRestore -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-SharePointRecycleBin -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Invoke-SharePointRecycleBinAction -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SharePointSiteActionJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'writes with GET/POST/DELETE only and never evaluates strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method POST'
            $source | Should -Match 'Invoke-MgGraphRequest -Method DELETE'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'entrypoint delegates to the dispatcher and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Invoke-SharePointSiteAction\.ps1'
            $entrySource | Should -Match 'Read-SharePointSiteActionJob -Path'
            $entrySource | Should -Match 'Invoke-SharePointSiteAction -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'site delete' {
        BeforeEach {
            New-ActionMock
        }

        It 'plans without writing on DryRun' {
            $plan = Invoke-SharePointSiteDelete -TenantId 'tenant-test' -SiteId 'site-live' -DryRun $true
            $plan.action | Should -Be 'delete'
            $plan.dryRun | Should -BeTrue
            $plan.before.state | Should -Be 'active'
            $plan.after.state | Should -Be 'softDeleted'
            $plan.requiresConfirmation | Should -BeTrue
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' }
        }

        It 'refuses an apply without confirmation and writes nothing' {
            {
                Invoke-SharePointSiteDelete -TenantId 'tenant-test' -SiteId 'site-live' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' }
        }

        It 'applies with confirmation and records before/after, an audit event, and a SiteOperation' {
            $events = [System.Collections.Generic.List[object]]::new()
            $result = Invoke-SharePointSiteDelete -TenantId 'tenant-test' -SiteId 'site-live' -Confirmed $true -Actor 'operator-1' -WriteAudit { param($e) $events.Add($e) }

            $result.success | Should -BeTrue
            $result.state | Should -Be 'succeeded'
            $result.operation | Should -Be 'delete'
            $result.plan.before.state | Should -Be 'active'
            $result.plan.after.state | Should -Be 'softDeleted'
            $result.auditEvent.action | Should -Be 'sharepoint.site.delete'
            $result.auditEvent.result | Should -Be 'success'
            $result.auditEvent.before.state | Should -Be 'active'
            $result.auditEvent.after.state | Should -Be 'softDeleted'
            $result.siteOperation.operation | Should -Be 'delete'
            $result.siteOperation.state | Should -Be 'succeeded'
            $result.siteOperation.result | Should -Be 'deleted'
            $events.Count | Should -Be 1
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'DELETE' -and $Uri -eq '/v1.0/groups/site-live' }
        }

        It 'refuses a site that is not live without writing' {
            {
                Invoke-SharePointSiteDelete -TenantId 'tenant-test' -SiteId 'site-missing' -Confirmed $true
            } | Should -Throw '*NotFound*live site*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' }
        }
    }

    Context 'site restore' {
        BeforeEach {
            New-ActionMock
        }

        It 'plans without writing on DryRun' {
            $plan = Invoke-SharePointSiteRestore -TenantId 'tenant-test' -SiteId 'site-deleted' -DryRun $true
            $plan.action | Should -Be 'restore'
            $plan.before.state | Should -Be 'softDeleted'
            $plan.after.state | Should -Be 'active'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
        }

        It 'restores a soft-deleted site without requiring confirmation and records the operation' {
            $events = [System.Collections.Generic.List[object]]::new()
            $result = Invoke-SharePointSiteRestore -TenantId 'tenant-test' -SiteId 'site-deleted' -WriteAudit { param($e) $events.Add($e) }

            $result.success | Should -BeTrue
            $result.operation | Should -Be 'restore'
            $result.result.state | Should -Be 'active'
            $result.auditEvent.action | Should -Be 'sharepoint.site.restore'
            $result.auditEvent.before.state | Should -Be 'softDeleted'
            $result.auditEvent.after.state | Should -Be 'active'
            $result.siteOperation.operation | Should -Be 'restore'
            $result.siteOperation.state | Should -Be 'succeeded'
            $events.Count | Should -Be 1
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Uri -eq '/v1.0/directory/deletedItems/site-deleted/restore' }
        }

        It 'refuses a site that is not soft-deleted without writing' {
            {
                Invoke-SharePointSiteRestore -TenantId 'tenant-test' -SiteId 'site-live'
            } | Should -Throw '*NotFound*soft-deleted*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
        }
    }

    Context 'recycle bin' {
        BeforeEach {
            New-ActionMock
        }

        It 'lists recycle-bin entries with deletion metadata' {
            $page = Get-SharePointRecycleBin -TenantId 'tenant-test'
            $page.tenantId | Should -Be 'tenant-test'
            $page.totalCount | Should -Be 2
            $page.items[0].id | Should -Be 'recycled-1'
            $page.items[0].displayName | Should -Be 'Recycled One'
            $page.items[0].daysUntilPurge | Should -Be 24
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' }
        }

        It 'filters and pages the recycle bin' {
            $filtered = Get-SharePointRecycleBin -TenantId 'tenant-test' -Search 'two'
            $filtered.totalCount | Should -Be 1
            $filtered.items[0].id | Should -Be 'recycled-2'

            $first = Get-SharePointRecycleBin -TenantId 'tenant-test' -Top 1
            $first.items.Count | Should -Be 1
            $first.nextCursor | Should -Not -BeNullOrEmpty
            $second = Get-SharePointRecycleBin -TenantId 'tenant-test' -Top 1 -Cursor $first.nextCursor
            $second.items[0].id | Should -Not -Be $first.items[0].id
        }

        It 'plans a recycle-bin restore without writing' {
            $plan = Invoke-SharePointRecycleBinAction -TenantId 'tenant-test' -Action 'restore' -RecycleBinIds @('recycled-1') -DryRun $true
            $plan.mode | Should -Be 'plan'
            $plan.results[0].status | Should -Be 'planned'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' -or $Method -eq 'DELETE' }
        }

        It 'restores recycle-bin entries and audits each' {
            $events = [System.Collections.Generic.List[object]]::new()
            $result = Invoke-SharePointRecycleBinAction -TenantId 'tenant-test' -Action 'restore' -RecycleBinIds @('recycled-1', 'recycled-2') -WriteAudit { param($e) $events.Add($e) }

            $result.mode | Should -Be 'apply'
            $result.summary.succeeded | Should -Be 2
            $result.results[0].status | Should -Be 'restored'
            $result.siteOperations.Count | Should -Be 2
            $result.siteOperations[0].operation | Should -Be 'recyclebin.restore'
            $result.siteOperations[0].state | Should -Be 'succeeded'
            $events.Count | Should -Be 2
            $events[0].action | Should -Be 'sharepoint.recyclebin.restore'
        }

        It 'refuses to empty without confirmation and writes nothing' {
            {
                Invoke-SharePointRecycleBinAction -TenantId 'tenant-test' -Action 'empty' -RecycleBinIds @('recycled-1')
            } | Should -Throw '*confirm_required*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' }
        }

        It 'empties recycle-bin entries with confirmation and audits each' {
            $events = [System.Collections.Generic.List[object]]::new()
            $result = Invoke-SharePointRecycleBinAction -TenantId 'tenant-test' -Action 'empty' -RecycleBinIds @('recycled-1') -Confirmed $true -WriteAudit { param($e) $events.Add($e) }

            $result.results[0].status | Should -Be 'emptied'
            $result.siteOperations[0].operation | Should -Be 'recyclebin.empty'
            $events[0].action | Should -Be 'sharepoint.recyclebin.empty'
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'DELETE' -and $Uri -eq '/v1.0/directory/deletedItems/recycled-1' }
        }
    }

    Context 'job envelope' {
        It 'reads tenant, action, target, and flags from the envelope' {
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('sharepoint-site-action-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-test'
                    action        = 'recyclebin-empty'
                    actor         = 'operator-1'
                    correlationId = 'corr-1'
                    payload       = @{
                        recycleBinIds = @('recycled-1', 'recycled-2')
                        confirm       = $true
                        dryRun        = $false
                    }
                } | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                $job = Read-SharePointSiteActionJob -Path $jobPath
                $job['TenantId'] | Should -Be 'tenant-test'
                $job['Action'] | Should -Be 'recyclebin-empty'
                $job['RecycleBinIds'] | Should -Contain 'recycled-1'
                $job['Confirmed'] | Should -BeTrue
                $job['Actor'] | Should -Be 'operator-1'
                $job['CorrelationId'] | Should -Be 'corr-1'
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }

        It 'throws for a missing envelope' {
            {
                Read-SharePointSiteActionJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'sharepoint-site-action-does-not-exist.json')
            } | Should -Throw '*job file not found*'
        }

        It 'rejects an unsupported action' {
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('sharepoint-site-action-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-test'
                    action        = 'explode'
                    payload       = @{}
                } | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                { Read-SharePointSiteActionJob -Path $jobPath } | Should -Throw '*unsupported action*'
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
