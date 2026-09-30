BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-Teams.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-teams.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')
}

Describe 'Get-Teams worker (T-0502)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-Teams -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-TeamsJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH/PUT' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
        }
    }

    Context 'Get-Teams live mapping and §3.1 columns' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body, $Headers)
                if ($Uri.Contains('resourceProvisioningOptions')) {
                    return @{
                        value = @(
                            @{
                                id = 'team-1'
                                displayName = 'Engineering'
                                description = 'Engineering team'
                                visibility = 'private'
                                createdDateTime = '2026-01-15T10:00:00Z'
                                mail = 'engineering@example.com'
                            }
                            @{
                                id = 'team-2'
                                displayName = 'Company Wide'
                                description = 'All company team'
                                visibility = 'public'
                                createdDateTime = '2026-06-01T08:00:00Z'
                                mail = 'allcompany@example.com'
                            }
                            @{
                                id = 'team-3'
                                displayName = 'Old Project'
                                description = 'Archived project team'
                                visibility = 'private'
                                createdDateTime = '2024-03-10T14:30:00Z'
                                mail = $null
                            }
                        )
                    }
                }
                if ($Uri -match '^/v1.0/teams/') {
                    $teamId = ($Uri -split '/')[-1]
                    $archived = $teamId -eq 'team-3'
                    $label = if ($teamId -eq 'team-1') { 'Confidential' } else { '' }
                    return @{ isArchived = $archived; sensitivityLabel = $label }
                }
                if ($Uri -match '^/v1.0/groups/([^/]+)/owners') {
                    $teamId = $Matches[1]
                    $count = switch ($teamId) {
                        'team-1' { 3 }
                        'team-2' { 1 }
                        default { 0 }
                    }
                    $ownerList = @()
                    if ($count -gt 0) {
                        $ownerList = @(1..$count | ForEach-Object { @{ userPrincipalName = "owner$($_)@example.com" } })
                    }
                    return @{ value = $ownerList }
                }
                if ($Uri -match '^/v1.0/groups/([^/]+)/members') {
                    $teamId = $Matches[1]
                    $count = switch ($teamId) {
                        'team-1' { 42 }
                        'team-2' { 7 }
                        default { 0 }
                    }
                    return @{ '@odata.count' = $count; value = @(@{ id = 'member-1' }) }
                }
                return @{ value = @() }
            }
        }

        It 'returns the §3.1 columns for every team' {
            $result = Get-Teams -TenantId 'tenant-test'
            $result.tenantId | Should -Be 'tenant-test'
            $result.totalCount | Should -Be 3
            $result.items.Count | Should -Be 3

            $eng = $result.items | Where-Object { $_.id -eq 'team-1' }
            $eng.name | Should -Be 'Engineering'
            $eng.visibility | Should -Be 'private'
            $eng.isArchived | Should -BeFalse
            $eng.createdDateTime | Should -Be '2026-01-15T10:00:00Z'
            $eng.sensitivityLabel | Should -Be 'Confidential'
            $eng.ownerCount | Should -Be 3
            $eng.memberCount | Should -Be 42

            $all = $result.items | Where-Object { $_.id -eq 'team-2' }
            $all.visibility | Should -Be 'public'
            $all.ownerCount | Should -Be 1
            $all.memberCount | Should -Be 7

            $old = $result.items | Where-Object { $_.id -eq 'team-3' }
            $old.isArchived | Should -BeTrue
            $old.sensitivityLabel | Should -Be ''
            $old.ownerCount | Should -Be 0
            $old.memberCount | Should -Be 0
        }

        It 'filters by visibility' {
            $result = Get-Teams -TenantId 'tenant-test' -Visibility 'public'
            $result.totalCount | Should -Be 1
            $result.items[0].id | Should -Be 'team-2'
        }

        It 'filters by archived' {
            $archived = Get-Teams -TenantId 'tenant-test' -Archived 'true'
            $archived.totalCount | Should -Be 1
            $archived.items[0].id | Should -Be 'team-3'

            $active = Get-Teams -TenantId 'tenant-test' -Archived 'false'
            $active.totalCount | Should -Be 2
            $active.items.id | Should -Not -Contain 'team-3'
        }

        It 'filters by activity date window on created' {
            $result = Get-Teams -TenantId 'tenant-test' -From '2025-01-01T00:00:00Z'
            $result.totalCount | Should -Be 2
            $result.items.id | Should -Not -Contain 'team-3'

            $older = Get-Teams -TenantId 'tenant-test' -To '2025-01-01T00:00:00Z'
            $older.totalCount | Should -Be 1
            $older.items[0].id | Should -Be 'team-3'
        }

        It 'paginates with a cursor' {
            $first = Get-Teams -TenantId 'tenant-test' -Top 2
            $first.items.Count | Should -Be 2
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-Teams -TenantId 'tenant-test' -Top 2 -Cursor $first.nextCursor
            $second.items.Count | Should -Be 1
            $second.items[0].id | Should -Be 'team-3'
            $second.nextCursor | Should -BeNullOrEmpty
        }
    }

    Context 'Entrypoint' {
        It 'reads the job and prints the filtered page as JSON' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body, $Headers)
                if ($Uri.Contains('resourceProvisioningOptions')) {
                    return @{ value = @(@{ id = 'team-9'; displayName = 'Sales'; visibility = 'public'; createdDateTime = '2026-02-01T09:00:00Z' }) }
                }
                if ($Uri -match '^/v1.0/teams/') {
                    return @{ isArchived = $false; sensitivityLabel = '' }
                }
                if ($Uri -match '^/v1.0/groups/([^/]+)/owners') {
                    return @{ value = @(@{ userPrincipalName = 'owner1@example.com' }) }
                }
                if ($Uri -match '^/v1.0/groups/([^/]+)/members') {
                    return @{ '@odata.count' = 12; value = @(@{ id = 'member-1' }) }
                }
                return @{ value = @() }
            }
            $path = Join-Path $TestDrive 'job.json'
            @{ tenantId = 'tenant-test'; visibility = 'public'; top = 50 } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path
            $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json
            $out.tenantId | Should -Be 'tenant-test'
            $out.totalCount | Should -Be 1
            $out.items[0].id | Should -Be 'team-9'
            $out.items[0].name | Should -Be 'Sales'
            $out.items[0].memberCount | Should -Be 12
        }
    }
}
