BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-Alerts.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-alerts.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Get-Alerts worker (T-0548)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-Alerts -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-AlertsJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH/PUT' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
        }

        It 'entrypoint delegates to the worker and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-Alerts.ps1'
            $entrySource | Should -Match 'Get-Alerts @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'T-0542 normalization' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{
                    value = @(
                        @{
                            id              = 'def-1'
                            title           = 'Suspicious process executed'
                            severity        = 'high'
                            status          = 'inProgress'
                            createdDateTime = '2026-01-01T00:00:00.000Z'
                            incidentId      = 'inc-1'
                            serviceSource   = 'microsoftDefenderForEndpoint'
                            detectionSource = 'EDR'
                            evidence        = @(
                                @{
                                    '@odata.type' = '#microsoft.graph.security.deviceEvidence'
                                    deviceDnsName = 'workstation-001'
                                    mdeDeviceId   = 'device-1'
                                }
                            )
                        }
                        @{
                            id              = 'mdo-1'
                            title           = 'Phishing email delivered'
                            severity        = 'medium'
                            status          = 'new'
                            createdDateTime = '2026-01-02T00:00:00.000Z'
                            serviceSource   = 'microsoftDefenderForOffice365'
                            evidence        = @(
                                @{
                                    '@odata.type' = '#microsoft.graph.security.mailboxEvidence'
                                    primaryAddress = 'mailbox-1'
                                }
                            )
                        }
                        @{
                            id              = 'graph-1'
                            title           = 'Risky sign-in'
                            severity        = 'low'
                            status          = 'resolved'
                            createdDateTime = '2026-01-03T00:00:00.000Z'
                            serviceSource   = 'azureAdIdentityProtection'
                            evidence        = @(
                                @{
                                    '@odata.type' = '#microsoft.graph.security.userEvidence'
                                    userAccount   = @{ accountName = 'user-1'; displayName = 'user-1' }
                                }
                            )
                        }
                        @{
                            id              = 'odd-1'
                            title           = 'Odd telemetry'
                            severity        = 'cosmic'
                            status          = 'weird'
                            createdDateTime = '2026-01-04T00:00:00.000Z'
                            serviceSource   = 'somethingElse'
                        }
                    )
                }
            }
        }

        It 'returns the §3.3 columns and the T-0542 shape' {
            $result = Get-Alerts -TenantId 'tenant-test'
            $result.tenantId | Should -Be 'tenant-test'
            $result.totalCount | Should -Be 4

            $def = $result.items | Where-Object { $_.id -eq 'def-1' }
            $def.schemaVersion | Should -Be 'v1'
            $def.source | Should -Be 'defender'
            $def.title | Should -Be 'Suspicious process executed'
            $def.severity | Should -Be 'high'
            $def.status | Should -Be 'inProgress'
            $def.created | Should -Be '2026-01-01T00:00:00.000Z'
            $def.incidentId | Should -Be 'inc-1'
            $def.entity.kind | Should -Be 'device'
            $def.entity.id | Should -Be 'device-1'
            $def.entity.displayName | Should -Be 'workstation-001'
            $def.passthrough['detectionSource'] | Should -Be 'EDR'
            $def.passthrough.ContainsKey('id') | Should -BeFalse
        }

        It 'maps MDO and Graph sources' {
            $result = Get-Alerts -TenantId 'tenant-test'
            ($result.items | Where-Object { $_.id -eq 'mdo-1' }).source | Should -Be 'mdo'
            ($result.items | Where-Object { $_.id -eq 'graph-1' }).source | Should -Be 'graph'
        }

        It 'falls back to unknown instead of silently coercing unmappable values' {
            $result = Get-Alerts -TenantId 'tenant-test'
            $odd = $result.items | Where-Object { $_.id -eq 'odd-1' }
            $odd.severity | Should -Be 'unknown'
            $odd.status | Should -Be 'unknown'
            $odd.source | Should -Be 'graph'
        }

        It 'filters by source, severity, and status' {
            (Get-Alerts -TenantId 'tenant-test' -Source 'mdo').items.id | Should -Be @('mdo-1')
            (Get-Alerts -TenantId 'tenant-test' -Severity 'high').items.id | Should -Be @('def-1')
            (Get-Alerts -TenantId 'tenant-test' -Status 'resolved').items.id | Should -Be @('graph-1')
        }

        It 'paginates with a cursor' {
            $first = Get-Alerts -TenantId 'tenant-test' -Top 3
            $first.items.Count | Should -Be 3
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-Alerts -TenantId 'tenant-test' -Top 3 -Cursor $first.nextCursor
            $second.items.Count | Should -Be 1
            $second.nextCursor | Should -BeNullOrEmpty
        }
    }
}
