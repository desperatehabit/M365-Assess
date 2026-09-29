BeforeAll {
    $script:repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '../../../')
    $script:worker     = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-IntuneApps.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-intune-apps.ps1'

    # Stub Invoke-MgGraphRequest before dot-sourcing the worker.
    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    function script:New-Assignment { @{ id = [guid]::NewGuid().ToString(); intent = 'required' } }

    $script:catalog = @(
        @{ '@odata.type' = '#microsoft.graph.win32LobApp'; id = 'a1'; displayName = '7-Zip'; publisher = 'Igor Pavlov'; publishingState = 'published'; lastModifiedDateTime = '2026-09-20T10:00:00Z'; assignments = @((New-Assignment), (New-Assignment)) }
        @{ '@odata.type' = '#microsoft.graph.winGetApp'; id = 'a2'; displayName = 'Company Portal'; publisher = 'Microsoft'; publishingState = 'published'; lastModifiedDateTime = '2026-09-21T10:00:00Z'; assignments = @() }
        @{ '@odata.type' = '#microsoft.graph.microsoftStoreForBusinessApp'; id = 'a3'; displayName = 'Legacy Store Zip'; assignments = @((New-Assignment)) }
        @{ '@odata.type' = '#microsoft.graph.officeSuiteApp'; id = 'a4'; displayName = 'Microsoft 365 Apps'; assignments = @() }
        @{ '@odata.type' = '#microsoft.graph.officeSuiteApp'; id = 'a5'; displayName = 'Office (Visio)'; assignments = @() }
        @{ '@odata.type' = '#microsoft.graph.iosStoreApp'; id = 'a6'; displayName = 'Outlook iOS'; assignments = @() }
    )
}

Describe 'Get-IntuneApps worker (T-0321)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker     | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            Get-Command Get-IntuneApps     -CommandType Function | Should -Not -BeNullOrEmpty
            Get-Command Read-IntuneAppsJob -CommandType Function | Should -Not -BeNullOrEmpty
        }

        It 'issues no write verbs to Graph' {
            $text = Get-Content -LiteralPath $script:worker -Raw
            $text | Should -Not -Match '-Method\s+(POST|PATCH|PUT|DELETE)'
        }
    }

    Context 'Job envelope reading' {
        It 'throws when the envelope does not exist' {
            { Read-IntuneAppsJob -Path '/path/does/not/exist.json' } | Should -Throw '*not found*'
        }

        It 'throws when tenantId is missing' {
            $path = Join-Path $TestDrive 'no-tenant.json'
            Set-Content -LiteralPath $path -Value '{"view":"catalog"}'
            { Read-IntuneAppsJob -Path $path } | Should -Throw "*missing mandatory 'tenantId'*"
        }

        It 'throws for an unknown view' {
            $path = Join-Path $TestDrive 'bad-view.json'
            Set-Content -LiteralPath $path -Value '{"tenantId":"t","view":"installed"}'
            { Read-IntuneAppsJob -Path $path } | Should -Throw '*unknown view*'
        }

        It 'defaults to the catalog view and reads every filter' {
            $path = Join-Path $TestDrive 'full.json'
            @{ tenantId = 't-1'; appType = 'win32'; assigned = $false; search = 'zip'; top = 25; cursor = '50' } |
                ConvertTo-Json | Set-Content -LiteralPath $path
            $job = Read-IntuneAppsJob -Path $path
            $job.View     | Should -Be 'catalog'
            $job.AppType  | Should -Be 'win32'
            $job.Assigned | Should -Be 'false'
            $job.Search   | Should -Be 'zip'
            $job.Top      | Should -Be 25
            $job.Cursor   | Should -Be '50'
        }
    }

    Context 'Catalog view' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                $Method | Should -Be 'GET'
                $Uri | Should -Be '/beta/deviceAppManagement/mobileApps?$expand=assignments'
                return @{ value = $script:catalog }
            }
        }

        It 'lists Win32 and Store apps with type, platform, assignment, and modification info' {
            $res = Get-IntuneApps -TenantId 't'
            $res.view | Should -Be 'catalog'
            $res.totalCount | Should -Be 3
            @($res.items.id) | Should -Be @('a1', 'a2', 'a3')
            $first = $res.items[0]
            $first.appType              | Should -Be 'win32'
            $first.platform             | Should -Be 'windows'
            $first.assignedCount        | Should -Be 2
            $first.publisher            | Should -Be 'Igor Pavlov'
            $first.publishingState      | Should -Be 'published'
            $first.lastModifiedDateTime | Should -Be '2026-09-20T10:00:00Z'
            $res.items[2].appType | Should -Be 'store'
            $res.items[2].lastModifiedDateTime | Should -BeNullOrEmpty
        }

        It 'counts apps of unsupported types instead of dropping them' {
            $res = Get-IntuneApps -TenantId 't'
            $res.unsupported.Count | Should -Be 2
            $res.unsupported[0].appType | Should -Be 'office'
            $res.unsupported[0].count   | Should -Be 2
            $res.unsupported[1].appType | Should -Be 'other'
            $res.unsupported[1].count   | Should -Be 1
        }

        It 'filters by app type, assignment, and search' {
            @((Get-IntuneApps -TenantId 't' -AppType 'store').items.id) | Should -Be @('a2', 'a3')
            @((Get-IntuneApps -TenantId 't' -Assigned 'true').items.id) | Should -Be @('a1', 'a3')
            (Get-IntuneApps -TenantId 't' -Assigned 'false').items.id | Should -Be 'a2'
            @((Get-IntuneApps -TenantId 't' -Search 'ZIP').items.id) | Should -Be @('a1', 'a3')
            (Get-IntuneApps -TenantId 't' -AppType 'store' -Search 'zip').items.id | Should -Be 'a3'
        }

        It 'returns a structured error for an unsupported app type without calling Graph' {
            $res = Get-IntuneApps -TenantId 't' -AppType 'office'
            $res.error      | Should -Be 'intune.app-type.unsupported'
            $res.statusCode | Should -Be 501
            Should -Invoke Invoke-MgGraphRequest -Times 0
        }

        It 'pages the filtered set with an offset cursor' {
            $first = Get-IntuneApps -TenantId 't' -Top 2
            @($first.items.id) | Should -Be @('a1', 'a2')
            $first.nextCursor | Should -Be '2'
            $last = Get-IntuneApps -TenantId 't' -Top 2 -Cursor '2'
            @($last.items.id) | Should -Be @('a3')
            $last.nextCursor | Should -BeNullOrEmpty
            { Get-IntuneApps -TenantId 't' -Cursor 'abc' } | Should -Throw '*cursor*'
        }
    }

    Context 'Graph paging' {
        It 'follows @odata.nextLink before filtering' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                if ($Uri -like '*skiptoken*') {
                    return [pscustomobject]@{ value = @([pscustomobject]@{ '@odata.type' = '#microsoft.graph.win32LobApp'; id = 'p2'; displayName = 'Two' }) }
                }
                return [pscustomobject]@{
                    value             = @([pscustomobject]@{ '@odata.type' = '#microsoft.graph.win32LobApp'; id = 'p1'; displayName = 'One' })
                    '@odata.nextLink' = 'https://graph.microsoft.com/v1.0/deviceAppManagement/mobileApps?$skiptoken=x'
                }
            }
            $res = Get-IntuneApps -TenantId 't'
            @($res.items.id) | Should -Be @('p1', 'p2')
            $res.items[0].assignedCount | Should -Be 0
            Should -Invoke Invoke-MgGraphRequest -Times 2
        }
    }

    Context 'Detected view' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                $Method | Should -Be 'GET'
                $Uri | Should -Be '/v1.0/deviceManagement/detectedApps'
                return @{ value = @(
                        @{ id = 'd1'; displayName = '7-Zip 23.01'; version = '23.01'; publisher = 'Igor Pavlov'; platform = 'windows'; deviceCount = 12; sizeInByte = 5000000 }
                        @{ id = 'd2'; displayName = 'Notepad++'; deviceCount = 3 }
                    ) }
            }
        }

        It 'reads Graph discovered apps into detected rows' {
            $res = Get-IntuneApps -TenantId 't' -View detected
            $res.view | Should -Be 'detected'
            $res.totalCount | Should -Be 2
            $res.items[0].deviceCount | Should -Be 12
            $res.items[0].sizeInByte  | Should -Be 5000000
            $res.items[1].version     | Should -BeNullOrEmpty
            $res.ContainsKey('unsupported') | Should -BeFalse
        }

        It 'filters detected apps by search' {
            (Get-IntuneApps -TenantId 't' -View detected -Search 'notepad').items.id | Should -Be 'd2'
        }
    }

    Context 'Entrypoint' {
        It 'reads the envelope, signs in, and emits the page as JSON' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            # The entrypoint runs in its own script scope, so the mock must close over the fixture.
            $fixture = $script:catalog
            Mock Invoke-MgGraphRequest { @{ value = $fixture } }.GetNewClosure()
            $path = Join-Path $TestDrive 'job.json'
            @{ tenantId = 't'; view = 'catalog'; appType = 'win32'; assigned = $true } |
                ConvertTo-Json | Set-Content -LiteralPath $path
            $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json
            @($out.items.id) | Should -Be @('a1')
            @($out.unsupported.appType) | Should -Be @('office', 'other')
            Should -Invoke Connect-WorkerTenant -Times 1
            Should -Invoke Disconnect-WorkerTenant -Times 1
        }
    }
}
