BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-LicenseReport.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-license-report.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    function global:Invoke-WebRequest {
        param($Uri, $UseBasicParsing, $TimeoutSec)
        throw "No network in tests"
    }

    function global:Test-Path {
        param($Path, $LiteralPath, [switch]$PathType)
        $target = if ($LiteralPath) { $LiteralPath } else { $Path }
        if ($target -like '*sku-friendly-names.csv') { return $false }
        if ($PathType) {
            return Microsoft.PowerShell.Management\Test-Path -LiteralPath $target -PathType
        }
        return Microsoft.PowerShell.Management\Test-Path -LiteralPath $target
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')
}

Describe 'Get-LicenseReport worker (T-0642)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-LicenseReport -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-LicenseReportJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest @graphParams'
            $source | Should -Match "Method\s*=\s*'GET'"
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
        }
    }

    Context 'Get-LicenseReport live mapping and projection' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{
                    value = @(
                        @{
                            skuId = '06ebc4ee-1bb5-47dd-8120-11324bc54e06'
                            skuPartNumber = 'SPE_E5'
                            prepaidUnits = @{
                                enabled  = 25
                                suspended = 0
                                warning  = 0
                            }
                            consumedUnits = 18
                        }
                        @{
                            skuId = 'c5928f49-12ba-48f7-ada3-0d743a3601d5'
                            skuPartNumber = 'VISIOCLIENT'
                            prepaidUnits = @{
                                enabled  = 5
                                suspended = 0
                                warning  = 2
                            }
                            consumedUnits = 3
                        }
                        @{
                            skuId = '00000000-0000-0000-0000-000000000000'
                            skuPartNumber = 'UNKNOWN_SKU'
                            prepaidUnits = @{
                                enabled  = 10
                                suspended = 1
                                warning  = 0
                            }
                            consumedUnits = 10
                        }
                    )
                }
            }
        }

        It 'projects enabled, assigned, available, utilizationPct, suspended, warning' {
            $res = Get-LicenseReport -TenantId 'tenant-test'
            $res.tenantId | Should -Be 'tenant-test'
            $res.items.Count | Should -Be 3

            $e5 = $res.items | Where-Object { $_.skuPartNumber -eq 'SPE_E5' }
            $e5.enabled | Should -Be 25
            $e5.assigned | Should -Be 18
            $e5.available | Should -Be 7
            $e5.utilizationPct | Should -Be 72.0
            $e5.suspended | Should -Be 0
            $e5.warning | Should -Be 0

            $visio = $res.items | Where-Object { $_.skuPartNumber -eq 'VISIOCLIENT' }
            $visio.enabled | Should -Be 5
            $visio.assigned | Should -Be 3
            $visio.available | Should -Be 2
            $visio.utilizationPct | Should -Be 60.0
            $visio.warning | Should -Be 2

            $unknown = $res.items | Where-Object { $_.skuPartNumber -eq 'UNKNOWN_SKU' }
            $unknown.enabled | Should -Be 10
            $unknown.assigned | Should -Be 10
            $unknown.available | Should -Be 0
            $unknown.utilizationPct | Should -Be 100.0
            $unknown.suspended | Should -Be 1
        }

        It 'sorts items by license name' {
            $res = Get-LicenseReport -TenantId 'tenant-test'
            $names = $res.items | ForEach-Object { $_.license }
            $names | Should -Be ($names | Sort-Object)
        }

        It 'handles zero enabled (no division by zero)' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{
                    value = @(
                        @{
                            skuId = 'zero-enabled'
                            skuPartNumber = 'ZERO_SKU'
                            prepaidUnits = @{
                                enabled  = 0
                                suspended = 0
                                warning  = 0
                            }
                            consumedUnits = 0
                        }
                    )
                }
            }

            $res = Get-LicenseReport -TenantId 'tenant-test'
            $res.items.Count | Should -Be 1
            $res.items[0].utilizationPct | Should -Be 0
        }
    }

    Context 'pricing join' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{
                    value = @(
                        @{
                            skuId = '06ebc4ee-1bb5-47dd-8120-11324bc54e06'
                            skuPartNumber = 'SPE_E5'
                            prepaidUnits = @{
                                enabled  = 25
                                suspended = 0
                                warning  = 0
                            }
                            consumedUnits = 18
                        },
                        @{
                            skuId = 'c5928f49-12ba-48f7-ada3-0d743a3601d5'
                            skuPartNumber = 'VISIOCLIENT'
                            prepaidUnits = @{
                                enabled  = 5
                                suspended = 0
                                warning  = 0
                            }
                            consumedUnits = 3
                        }
                    )
                }
            }
        }

        It 'computes monthlyCost from unitPrice x assigned and reports currency when priced' {
            $pricing = @(
                [pscustomobject]@{
                    skuId     = '06ebc4ee-1bb5-47dd-8120-11324bc54e06'
                    unitPrice = 57.0
                    currency  = 'USD'
                }
            )

            $res = Get-LicenseReport -TenantId 'tenant-test' -Pricing $pricing
            $e5 = $res.items | Where-Object { $_.skuPartNumber -eq 'SPE_E5' }
            $e5.monthlyCost | Should -Be 1026.0
            $e5.currency | Should -Be 'USD'
        }

        It 'reports "no pricing" for an unpriced SKU, never a fabricated zero' {
            $pricing = @(
                [pscustomobject]@{
                    skuId     = '06ebc4ee-1bb5-47dd-8120-11324bc54e06'
                    unitPrice = 57.0
                    currency  = 'USD'
                }
            )

            $res = Get-LicenseReport -TenantId 'tenant-test' -Pricing $pricing
            $visio = $res.items | Where-Object { $_.skuPartNumber -eq 'VISIOCLIENT' }
            $visio.monthlyCost | Should -Be 'no pricing'
            $visio.currency | Should -Be ''
        }

        It 'treats a pricing row without a unit price as unpriced' {
            $pricing = @(
                [pscustomobject]@{
                    skuId    = '06ebc4ee-1bb5-47dd-8120-11324bc54e06'
                    currency = 'USD'
                }
            )

            $res = Get-LicenseReport -TenantId 'tenant-test' -Pricing $pricing
            $e5 = $res.items | Where-Object { $_.skuPartNumber -eq 'SPE_E5' }
            $e5.monthlyCost | Should -Be 'no pricing'
        }

        It 'reports "no pricing" for every SKU when no pricing is supplied' {
            $res = Get-LicenseReport -TenantId 'tenant-test'
            $res.items.Count | Should -Be 2
            $res.items[0].monthlyCost | Should -Be 'no pricing'
            $res.items[1].monthlyCost | Should -Be 'no pricing'
        }
    }

    Context 'Read-LicenseReportJob' {
        It 'parses tenantId from a job envelope' {
            $jobPath = Join-Path $TestDrive 'license-report-job.json'
            @{ tenantId = 'tenant-test' } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            $job = Read-LicenseReportJob -Path $jobPath
            $job['TenantId'] | Should -Be 'tenant-test'
        }

        It 'parses pricing rows from a job envelope' {
            $jobPath = Join-Path $TestDrive 'license-report-job-pricing.json'
            @{
                tenantId = 'tenant-test'
                pricing  = @(@{ skuId = 'sku-1'; unitPrice = 10.0; currency = 'USD' })
            } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            $job = Read-LicenseReportJob -Path $jobPath
            $job['Pricing'].Count | Should -Be 1
            $job['Pricing'][0].skuId | Should -Be 'sku-1'
        }

        It 'returns empty pricing when the envelope carries none' {
            $jobPath = Join-Path $TestDrive 'license-report-job-nopricing.json'
            @{ tenantId = 'tenant-test' } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            $job = Read-LicenseReportJob -Path $jobPath
            $job['Pricing'].Count | Should -Be 0
        }

        It 'throws when tenantId is missing' {
            $jobPath = Join-Path $TestDrive 'license-report-job-bad.json'
            @{ } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            { Read-LicenseReportJob -Path $jobPath } | Should -Throw
        }

        It 'throws when job file does not exist' {
            { Read-LicenseReportJob -Path 'C:\nonexistent\job.json' } | Should -Throw
        }
    }

    Context 'entrypoint job envelope' {
        It 'executes through the get-license-report.ps1 entrypoint' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            Mock Invoke-MgGraphRequest {
                return @{
                    value = @(
                        @{
                            skuId = 'test-sku'
                            skuPartNumber = 'TEST_SKU'
                            prepaidUnits = @{ enabled = 10; suspended = 0; warning = 0 }
                            consumedUnits = 5
                        }
                    )
                }
            }

            $tempFile = [System.IO.Path]::GetTempFileName()
            try {
                @{ tenantId = 'tenant-xyz' } | ConvertTo-Json | Set-Content -LiteralPath $tempFile

                $jsonOutput = & $script:entrypoint -JobFile $tempFile
                $parsed = $jsonOutput | ConvertFrom-Json
                $parsed.tenantId | Should -Be 'tenant-xyz'
                $parsed.items.Count | Should -Be 1
                $parsed.items[0].skuPartNumber | Should -Be 'TEST_SKU'
                $parsed.items[0].enabled | Should -Be 10
                $parsed.items[0].assigned | Should -Be 5
                $parsed.items[0].available | Should -Be 5
                $parsed.items[0].utilizationPct | Should -Be 50.0
            }
            finally {
                Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
            }
        }

        It 'passes pricing from the job envelope through to the report' {
            Mock Connect-WorkerTenant { $null }
            Mock Disconnect-WorkerTenant { }
            Mock Invoke-MgGraphRequest {
                return @{
                    value = @(
                        @{
                            skuId = 'test-sku'
                            skuPartNumber = 'TEST_SKU'
                            prepaidUnits = @{ enabled = 10; suspended = 0; warning = 0 }
                            consumedUnits = 5
                        }
                    )
                }
            }

            $tempFile = [System.IO.Path]::GetTempFileName()
            try {
                @{
                    tenantId = 'tenant-xyz'
                    pricing  = @(@{ skuId = 'test-sku'; unitPrice = 42.0; currency = 'EUR' })
                } | ConvertTo-Json | Set-Content -LiteralPath $tempFile

                $jsonOutput = & $script:entrypoint -JobFile $tempFile
                $parsed = $jsonOutput | ConvertFrom-Json
                $parsed.items[0].monthlyCost | Should -Be 210.0
                $parsed.items[0].currency | Should -Be 'EUR'
            }
            finally {
                Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'SkuFriendlyNames loading' {
        It 'falls back to bundled CSV when download fails' {
            Mock Invoke-WebRequest { throw 'Network error' }
            Mock Test-Path {
                param($Path)
                return $false
            }

            $names = Get-SkuFriendlyNames
            $names.Count | Should -Be 0
        }
    }
}