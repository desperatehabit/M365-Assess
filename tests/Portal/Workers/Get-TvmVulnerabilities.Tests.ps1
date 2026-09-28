BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-TvmVulnerabilities.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-tvm-vulnerabilities.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Get-TvmVulnerabilities worker (T-0366)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-TvmVulnerabilities -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-TvmVulnerabilityDevices -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-TvmVulnerabilitiesJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Not -Match '-Method POST'
            $entrySource | Should -Not -Match '-Method DELETE'
            $entrySource | Should -Not -Match '-Method PATCH'
        }

        It 'reads the Graph security API for vulnerabilities and drill-through devices' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'security/vulnerabilities'
            $source | Should -Match 'vulnerableDevices'
        }
    }

    Context 'Get-TvmVulnerabilities live mapping and filtering' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{
                    value = @(
                        @{
                            cveId = 'CVE-2026-12345'
                            severity = 'high'
                            cvssScore = 8.1
                            exposedDeviceCount = 2
                            affectedSoftware = @('Contoso VPN 4.2', 'Contoso Agent 4.2')
                            remediation = 'Update Contoso VPN to 4.3 or later.'
                            vulnerableDevices = @(
                                @{ id = 'device-1'; deviceName = 'WS-1001' }
                                @{ id = 'device-2'; deviceName = 'WS-1002' }
                            )
                        }
                        @{
                            cveId = 'CVE-2026-99999'
                            severity = 'medium'
                            cvssScore = 5.4
                            affectedSoftware = @('Fabrikam Browser 120.0')
                            remediation = 'Update Fabrikam Browser to 121.0 or later.'
                            vulnerableDevices = @(
                                @{ id = 'device-3'; deviceName = 'WS-1003' }
                            )
                        }
                        @{
                            cveId = 'CVE-2025-00001'
                            severity = 'critical'
                            cvssScore = 9.8
                            exposedDeviceCount = 1
                            affectedSoftware = @('Contoso VPN 3.9')
                            remediation = 'Update Contoso VPN to 4.3 or later.'
                            vulnerableDevices = @(
                                @{ id = 'device-9'; deviceName = 'WS-1009' }
                            )
                        }
                    )
                }
            }
        }

        It 'returns CVEs with the section 3.3 columns and drill-through device ids' {
            $result = Get-TvmVulnerabilities -TenantId 'tenant-test'
            $result.tenantId | Should -Be 'tenant-test'
            $result.totalCount | Should -Be 3
            $result.items.Count | Should -Be 3

            $high = $result.items | Where-Object { $_.cve -eq 'CVE-2026-12345' }
            $high.severity | Should -Be 'high'
            $high.cvss | Should -Be 8.1
            $high.exposedDeviceCount | Should -Be 2
            $high.affectedSoftware | Should -Contain 'Contoso VPN 4.2'
            $high.recommendation | Should -Be 'Update Contoso VPN to 4.3 or later.'
            $high.affectedDeviceIds | Should -Contain 'device-1'
            $high.affectedDeviceIds | Should -Contain 'device-2'
        }

        It 'derives the exposed device count from the device list when Graph omits it' {
            $result = Get-TvmVulnerabilities -TenantId 'tenant-test' -Search '99999'
            $result.totalCount | Should -Be 1
            $result.items[0].exposedDeviceCount | Should -Be 1
            $result.items[0].affectedDeviceIds | Should -Contain 'device-3'
        }

        It 'filters by severity' {
            $result = Get-TvmVulnerabilities -TenantId 'tenant-test' -Severity 'critical'
            $result.totalCount | Should -Be 1
            $result.items[0].cve | Should -Be 'CVE-2025-00001'
        }

        It 'sends the severity filter server-side via $filter' {
            $script:capturedUri = @()
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                $script:capturedUri += $Uri
                return @{ value = @() }
            }

            Get-TvmVulnerabilities -TenantId 'tenant-test' -Severity 'high' | Out-Null
            $script:capturedUri.Count | Should -BeGreaterThan 0
            $script:capturedUri[0] | Should -Match '\$filter=severity eq'
        }

        It 'filters by software' {
            $result = Get-TvmVulnerabilities -TenantId 'tenant-test' -Software 'browser'
            $result.totalCount | Should -Be 1
            $result.items[0].cve | Should -Be 'CVE-2026-99999'
        }

        It 'filters by device' {
            $result = Get-TvmVulnerabilities -TenantId 'tenant-test' -Device 'device-9'
            $result.totalCount | Should -Be 1
            $result.items[0].cve | Should -Be 'CVE-2025-00001'
        }

        It 'filters by CVE search term' {
            $result = Get-TvmVulnerabilities -TenantId 'tenant-test' -Search '2026-12345'
            $result.totalCount | Should -Be 1
            $result.items[0].cve | Should -Be 'CVE-2026-12345'
        }

        It 'paginates with an opaque cursor' {
            $first = Get-TvmVulnerabilities -TenantId 'tenant-test' -Top 2
            $first.items.Count | Should -Be 2
            $first.totalCount | Should -Be 3
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-TvmVulnerabilities -TenantId 'tenant-test' -Top 2 -Cursor $first.nextCursor
            $second.items.Count | Should -Be 1
            $second.nextCursor | Should -BeNullOrEmpty
        }
    }

    Context 'Get-TvmVulnerabilityDevices drill-through' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Uri -match 'vulnerableDevices') {
                    return @{
                        value = @(
                            @{ id = 'device-1'; deviceName = 'WS-1001' }
                            @{ id = 'device-2'; deviceName = 'WS-1002' }
                        )
                    }
                }
                return @{ value = @() }
            }
        }

        It 'lists affected devices for a CVE' {
            $result = Get-TvmVulnerabilityDevices -TenantId 'tenant-test' -CveId 'CVE-2026-12345'
            $result.tenantId | Should -Be 'tenant-test'
            $result.cve | Should -Be 'CVE-2026-12345'
            $result.totalCount | Should -Be 2
            $result.items[0].id | Should -Be 'device-1'
            $result.items[0].deviceName | Should -Be 'WS-1001'
        }

        It 'paginates the device list' {
            $first = Get-TvmVulnerabilityDevices -TenantId 'tenant-test' -CveId 'CVE-2026-12345' -Top 1
            $first.items.Count | Should -Be 1
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-TvmVulnerabilityDevices -TenantId 'tenant-test' -CveId 'CVE-2026-12345' -Top 1 -Cursor $first.nextCursor
            $second.items.Count | Should -Be 1
            $second.items[0].id | Should -Be 'device-2'
        }
    }
}
