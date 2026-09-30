BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-DomainInventory.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-domains.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')
}

Describe 'Get-DomainInventory worker (T-0662)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-DomainInventory -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-DomainInventoryJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest @graphParams'
            $source | Should -Match "Method\s*=\s*'GET'"
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
        }
    }

    Context 'Get-DomainInventory live mapping and projection' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{
                    value = @(
                        @{
                            id = 'domain-1'
                            name = 'contoso.com'
                            isInitial = $false
                            isVerified = $true
                            isManaged = $false
                            serviceConfigurationRecords = @(
                                @{
                                    recordType = 'MX'
                                    recordValue = 'contoso-com.mail.protection.outlook.com'
                                }
                            )
                        }
                        @{
                            id = 'domain-2'
                            name = 'contoso.onmicrosoft.com'
                            isInitial = $true
                            isVerified = $false
                            isManaged = $false
                            serviceConfigurationRecords = @()
                        }
                        @{
                            id = 'domain-3'
                            name = 'fabrikam.com'
                            isInitial = $false
                            isVerified = $true
                            isManaged = $true
                            serviceConfigurationRecords = @(
                                @{
                                    recordType = 'MX'
                                    recordValue = 'fabrikam-com.mail.protection.outlook.com'
                                }
                            )
                        }
                    )
                }
            }
        }

        It 'projects type, verification, MX target, and joins latest DNS health' {
            $latestChecks = @(
                [pscustomobject]@{
                    id = 'check-1'
                    tenantId = 'tenant-test'
                    domain = 'contoso.com'
                    at = '2026-09-20T12:00:00Z'
                    records = '{}'
                    health = '{"overall":"healthy"}'
                    recommendations = '[]'
                }
                [pscustomobject]@{
                    id = 'check-2'
                    tenantId = 'tenant-test'
                    domain = 'fabrikam.com'
                    at = '2026-09-19T08:30:00Z'
                    records = '{}'
                    health = '{"overall":"degraded"}'
                    recommendations = '[]'
                }
            )

            $res = Get-DomainInventory -TenantId 'tenant-test' -LatestChecks $latestChecks
            $res.totalCount | Should -Be 3
            $res.items.Count | Should -Be 3

            $contoso = $res.items | Where-Object { $_.domain -eq 'contoso.com' }
            $contoso.type | Should -Be 'verified'
            $contoso.verification | Should -Be 'verified'
            $contoso.services | Should -Be 'contoso-com.mail.protection.outlook.com'
            $contoso.dnsHealth | Should -Be 'healthy'
            $contoso.lastChecked | Should -Be '2026-09-20T12:00:00Z'

            $onmicrosoft = $res.items | Where-Object { $_.domain -eq 'contoso.onmicrosoft.com' }
            $onmicrosoft.type | Should -Be 'initial'
            $onmicrosoft.verification | Should -Be 'unverified'
            $onmicrosoft.dnsHealth | Should -BeNullOrEmpty
            $onmicrosoft.lastChecked | Should -BeNullOrEmpty

            $fabrikam = $res.items | Where-Object { $_.domain -eq 'fabrikam.com' }
            $fabrikam.type | Should -Be 'managed'
            $fabrikam.verification | Should -Be 'verified'
            $fabrikam.services | Should -Be 'fabrikam-com.mail.protection.outlook.com'
            $fabrikam.dnsHealth | Should -Be 'degraded'
            $fabrikam.lastChecked | Should -Be '2026-09-19T08:30:00Z'
        }

        It 'returns empty dnsHealth/lastChecked when domain has no stored check' {
            $res = Get-DomainInventory -TenantId 'tenant-test' -LatestChecks @()
            $res.totalCount | Should -Be 3

            foreach ($item in $res.items) {
                $item.dnsHealth | Should -BeNullOrEmpty
                $item.lastChecked | Should -BeNullOrEmpty
            }
        }

        It 'handles domain with no MX record gracefully' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{
                    value = @(
                        @{
                            id = 'domain-no-mx'
                            name = 'no-mx.example.com'
                            isInitial = $false
                            isVerified = $true
                            isManaged = $false
                            serviceConfigurationRecords = @(
                                @{
                                    recordType = 'TXT'
                                    recordValue = 'v=spf1 include:spf.protection.outlook.com -all'
                                }
                            )
                        }
                    )
                }
            }

            $res = Get-DomainInventory -TenantId 'tenant-test' -LatestChecks @()
            $res.totalCount | Should -Be 1
            $res.items[0].services | Should -BeNullOrEmpty
        }

        It 'supports cursor pagination' {
            $page1 = Get-DomainInventory -TenantId 'tenant-test' -Top 2
            $page1.items.Count | Should -Be 2
            $page1.nextCursor | Should -Not -BeNullOrEmpty

            $page2 = Get-DomainInventory -TenantId 'tenant-test' -Top 2 -Cursor $page1.nextCursor
            $page2.items.Count | Should -Be 1
            $page2.nextCursor | Should -BeNullOrEmpty
        }
    }

    Context 'entrypoint job envelope' {
        It 'executes through the get-domains.ps1 entrypoint' {
            # Tenant sign-in is Connect-WorkerTenant's concern (T-0826); stub it here.
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            Mock Invoke-MgGraphRequest {
                return @{
                    value = @(
                        @{
                            id = 'domain-test'
                            name = 'test.example.com'
                            isInitial = $false
                            isVerified = $true
                            isManaged = $false
                            serviceConfigurationRecords = @(
                                @{
                                    recordType = 'MX'
                                    recordValue = 'test-example-com.mail.protection.outlook.com'
                                }
                            )
                        }
                    )
                }
            }

            $tempFile = [System.IO.Path]::GetTempFileName()
            try {
                @{
                    tenantId = 'tenant-xyz'
                    top = 50
                    latestChecks = @()
                } | ConvertTo-Json | Set-Content -LiteralPath $tempFile

                $jsonOutput = & $script:entrypoint -JobFile $tempFile
                $parsed = $jsonOutput | ConvertFrom-Json
                $parsed.tenantId | Should -Be 'tenant-xyz'
                $parsed.totalCount | Should -Be 1
                $parsed.items[0].domain | Should -Be 'test.example.com'
                $parsed.items[0].services | Should -Be 'test-example-com.mail.protection.outlook.com'
            }
            finally {
                Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
            }
        }

        It 'joins latest DNS health from the job envelope latestChecks' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            Mock Invoke-MgGraphRequest {
                return @{
                    value = @(
                        @{
                            id = 'domain-test'
                            name = 'test.example.com'
                            isInitial = $false
                            isVerified = $true
                            isManaged = $false
                            serviceConfigurationRecords = @(
                                @{
                                    recordType = 'MX'
                                    recordValue = 'test-example-com.mail.protection.outlook.com'
                                }
                            )
                        }
                    )
                }
            }

            $tempFile = [System.IO.Path]::GetTempFileName()
            try {
                @{
                    tenantId = 'tenant-xyz'
                    top = 50
                    latestChecks = @(
                        @{
                            id = 'check-1'
                            tenantId = 'tenant-xyz'
                            domain = 'test.example.com'
                            at = '2026-09-20T12:00:00.123Z'
                            records = '{}'
                            health = '{"overall":"healthy"}'
                            recommendations = '[]'
                        }
                    )
                } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tempFile

                $jsonOutput = & $script:entrypoint -JobFile $tempFile
                $parsed = $jsonOutput | ConvertFrom-Json
                $parsed.items[0].dnsHealth | Should -Be 'healthy'
                # ConvertFrom-Json turns the ISO string into a [datetime]; assert the raw
                # payload so the UTC ISO 8601 format is what the API actually receives.
                $jsonOutput | Should -Match '"lastChecked":"2026-09-20T12:00:00\.123Z"'
            }
            finally {
                Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
            }
        }
    }
}