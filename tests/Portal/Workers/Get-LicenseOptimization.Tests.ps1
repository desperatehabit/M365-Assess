BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-LicenseOptimization.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body, $OutputType, $OutputFilePath)
    }

    . $script:worker
}

Describe 'Get-LicenseOptimization worker (T-0643)' {

    Context 'the worker file' {
        It 'ships the worker functions' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            (Get-Command Get-LicenseOptimization -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-LicenseOptimizationJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH/PUT' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match "Method GET"
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
        }
    }

    Context 'Read-LicenseOptimizationJob' {
        It 'parses tenantId and defaults the window to 30 days' {
            $jobPath = Join-Path $TestDrive 'license-optimization-job.json'
            @{ tenantId = 'tenant-test' } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            $job = Read-LicenseOptimizationJob -Path $jobPath
            $job['TenantId'] | Should -Be 'tenant-test'
            $job['InactivityDays'] | Should -Be 30
        }

        It 'parses a custom inactivity window' {
            $jobPath = Join-Path $TestDrive 'license-optimization-job-window.json'
            @{ tenantId = 'tenant-test'; inactivityDays = 7 } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            $job = Read-LicenseOptimizationJob -Path $jobPath
            $job['InactivityDays'] | Should -Be 7
        }

        It 'throws when tenantId is missing' {
            $jobPath = Join-Path $TestDrive 'license-optimization-job-bad.json'
            @{ } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            { Read-LicenseOptimizationJob -Path $jobPath } | Should -Throw
        }

        It 'throws when the job file does not exist' {
            { Read-LicenseOptimizationJob -Path 'C:\nonexistent\job.json' } | Should -Throw
        }
    }

    Context 'report period selection' {
        It 'picks the smallest Graph period that covers the window' {
            Get-LicenseOptimizationReportPeriod -InactivityDays 7 | Should -Be 'D7'
            Get-LicenseOptimizationReportPeriod -InactivityDays 30 | Should -Be 'D30'
            Get-LicenseOptimizationReportPeriod -InactivityDays 45 | Should -Be 'D90'
            Get-LicenseOptimizationReportPeriod -InactivityDays 365 | Should -Be 'D180'
        }
    }

    Context 'Get-LicenseOptimization gathering' {
        BeforeEach {
            $script:referenceDate = [datetime]'2026-01-31T00:00:00Z'

            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body, $OutputType, $OutputFilePath)
                if ($Uri -like '*subscribedSkus*') {
                    return @{
                        value = @(
                            @{
                                skuId = 'sku-e5'
                                skuPartNumber = 'SPE_E5'
                                capabilityStatus = 'Enabled'
                                prepaidUnits = @{ enabled = 25; suspended = 0; warning = 0 }
                                consumedUnits = 20
                                expirationDateTime = '2026-06-01T00:00:00Z'
                            }
                            @{
                                skuId = 'sku-visio'
                                skuPartNumber = 'VISIOCLIENT'
                                capabilityStatus = 'Enabled'
                                prepaidUnits = @{ enabled = 3; suspended = 0; warning = 0 }
                                consumedUnits = 5
                            }
                            @{
                                skuId = 'sku-suspended'
                                skuPartNumber = 'SUSPENDED_SKU'
                                capabilityStatus = 'Suspended'
                                prepaidUnits = @{ enabled = 10; suspended = 0; warning = 0 }
                                consumedUnits = 1
                            }
                        )
                    }
                }
                return @{
                    value = @(
                        @{ id = 'user-1'; displayName = 'User One'; userPrincipalName = 'a@example.invalid'; assignedLicenses = @(@{ skuId = 'sku-e5' }) }
                        @{ id = 'user-2'; displayName = 'User Two'; userPrincipalName = 'b@example.invalid'; assignedLicenses = @(@{ skuId = 'sku-visio' }) }
                        @{ id = 'user-3'; displayName = 'User Three'; userPrincipalName = 'c@example.invalid'; assignedLicenses = @(@{ skuId = 'sku-suspended' }) }
                        @{ id = 'user-4'; displayName = 'User Four'; userPrincipalName = 'd@example.invalid'; assignedLicenses = @(@{ skuId = 'sku-orphan' }) }
                    )
                }
            }
        }

        It 'joins per-user last activity from the usage report, case-insensitively' {
            $import = {
                param($Uri)
                @(
                    @{ 'User Principal Name' = 'A@EXAMPLE.INVALID'; 'Last Activity Date' = '2026-01-25' }
                    @{ 'User Principal Name' = 'b@example.invalid'; 'Last Activity Date' = '2025-12-01' }
                )
            }

            $res = Get-LicenseOptimization -TenantId 'tenant-test' -ReferenceDate $script:referenceDate -Import $import
            $res.tenantId | Should -Be 'tenant-test'
            $res.inactivityDays | Should -Be 30
            $res.assignments.Count | Should -Be 4

            $user1 = $res.assignments | Where-Object { $_.userId -eq 'user-1' }
            $user1.lastActivityDate | Should -Be '2026-01-25'
            $user1.skuPartNumber | Should -Be 'SPE_E5'

            $user4 = $res.assignments | Where-Object { $_.userId -eq 'user-4' }
            $user4.lastActivityDate | Should -BeNullOrEmpty
        }

        It 'reports assignment errors for over-allocated, suspended, and unsubscribed licences' {
            $res = Get-LicenseOptimization -TenantId 'tenant-test' -ReferenceDate $script:referenceDate -Import { @() }
            $res.assignmentErrors.Count | Should -Be 3

            $visio = $res.assignmentErrors | Where-Object { $_.userId -eq 'user-2' }
            $visio.error | Should -Match 'over-allocated'

            $suspended = $res.assignmentErrors | Where-Object { $_.userId -eq 'user-3' }
            $suspended.error | Should -Match 'Suspended'

            $orphan = $res.assignmentErrors | Where-Object { $_.userId -eq 'user-4' }
            $orphan.error | Should -Match 'not subscribed'
        }

        It 'surfaces upcoming SKU expiry and excludes past expiry' {
            $res = Get-LicenseOptimization -TenantId 'tenant-test' -ReferenceDate $script:referenceDate -Import { @() }
            $res.expirations.Count | Should -Be 1
            $res.expirations[0].skuPartNumber | Should -Be 'SPE_E5'

            $past = Get-LicenseOptimization -TenantId 'tenant-test' -ReferenceDate ([datetime]'2026-12-31T00:00:00Z') -Import { @() }
            $past.expirations.Count | Should -Be 0
        }

        It 'requests the usage report period covering the window' {
            $captured = [System.Collections.Generic.List[string]]::new()
            $import = {
                param($Uri)
                $captured.Add($Uri)
                @()
            }

            Get-LicenseOptimization -TenantId 'tenant-test' -InactivityDays 90 -ReferenceDate $script:referenceDate -Import $import | Out-Null
            $captured.Count | Should -Be 1
            $captured[0] | Should -Match "period='D90'"
        }
    }
}
