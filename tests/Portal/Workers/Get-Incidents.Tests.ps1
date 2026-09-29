BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-Incidents.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-incidents.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Get-Incidents worker (T-0543)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-Incidents -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-IncidentsJob -CommandType Function) | Should -Not -BeNullOrEmpty
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

    Context 'Get-Incidents live mapping and §3.1 normalization' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{
                    value = @(
                        @{
                            id = 'inc-high'
                            displayName = 'Suspicious sign-in burst'
                            severity = 'high'
                            status = 'active'
                            classification = 'truePositive'
                            assignedTo = 'analyst-a'
                            lastUpdateDateTime = '2026-09-20T12:00:00Z'
                            alerts = @(@{ id = 'a1' }, @{ id = 'a2' })
                        }
                        @{
                            id = 'inc-med'
                            displayName = 'Malware contained'
                            severity = 'medium'
                            status = 'resolved'
                            classification = 'truePositive'
                            assignedTo = $null
                            lastUpdateDateTime = '2026-09-18T08:30:00Z'
                            alerts = @(@{ id = 'a3' })
                        }
                        @{
                            id = 'inc-unmapped'
                            displayName = 'Odd telemetry'
                            severity = 'cosmic'
                            status = 'weird'
                            classification = 'maybe'
                            assignedTo = ''
                            lastUpdateDateTime = '2026-09-19T09:00:00Z'
                            alerts = @()
                        }
                    )
                }
            }
        }

        It 'returns the §3.1 columns with tenant stamped on every row' {
            $result = Get-Incidents -TenantId 'tenant-test'
            $result.tenantId | Should -Be 'tenant-test'
            $result.totalCount | Should -Be 3
            $result.items.Count | Should -Be 3

            $high = $result.items | Where-Object { $_.id -eq 'inc-high' }
            $high.title | Should -Be 'Suspicious sign-in burst'
            $high.severity | Should -Be 'high'
            $high.status | Should -Be 'active'
            $high.classification | Should -Be 'truePositive'
            $high.assignedTo | Should -Be 'analyst-a'
            $high.alertCount | Should -Be 2
            $high.lastUpdated | Should -Be '2026-09-20T12:00:00Z'
            $high.tenantId | Should -Be 'tenant-test'
        }

        It 'falls back to unknown instead of silently coercing unmappable values' {
            $result = Get-Incidents -TenantId 'tenant-test'
            $odd = $result.items | Where-Object { $_.id -eq 'inc-unmapped' }
            $odd.severity | Should -Be 'unknown'
            $odd.status | Should -Be 'unknown'
            $odd.classification | Should -Be 'unknown'
        }

        It 'filters by severity' {
            $result = Get-Incidents -TenantId 'tenant-test' -Severity 'high'
            $result.totalCount | Should -Be 1
            $result.items[0].id | Should -Be 'inc-high'
        }

        It 'filters by status' {
            $result = Get-Incidents -TenantId 'tenant-test' -Status 'resolved'
            $result.totalCount | Should -Be 1
            $result.items[0].id | Should -Be 'inc-med'
        }

        It 'filters by classification' {
            $result = Get-Incidents -TenantId 'tenant-test' -Classification 'truePositive'
            $result.totalCount | Should -Be 2
        }

        It 'filters by assigned analyst' {
            $result = Get-Incidents -TenantId 'tenant-test' -Assigned 'analyst-a'
            $result.totalCount | Should -Be 1
            $result.items[0].id | Should -Be 'inc-high'
        }

        It 'filters by date range on last updated' {
            $result = Get-Incidents -TenantId 'tenant-test' -From '2026-09-19T00:00:00Z' -To '2026-09-20T23:59:59Z'
            $result.totalCount | Should -Be 2
            $result.items.id | Should -Not -Contain 'inc-med'
        }

        It 'paginates with a cursor' {
            $first = Get-Incidents -TenantId 'tenant-test' -Top 2
            $first.items.Count | Should -Be 2
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-Incidents -TenantId 'tenant-test' -Top 2 -Cursor $first.nextCursor
            $second.items.Count | Should -Be 1
            $second.nextCursor | Should -BeNullOrEmpty
        }
    }
}
