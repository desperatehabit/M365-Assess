BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-MdeOnboarding.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-mde-onboarding.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Get-MdeOnboarding worker (T-0370)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-MdeOnboarding -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-MdeOnboardingJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-MdePlatform -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH/PUT' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Not -Match '-Method POST'
            $entrySource | Should -Not -Match '-Method DELETE'
            $entrySource | Should -Not -Match '-Method PATCH'
            $entrySource | Should -Not -Match '-Method PUT'
        }

        It 'performs no tenant writes and no dynamic invocation' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Invoke-Expression'
            $source | Should -Not -Match 'Set-IntunePolicy'
            $source | Should -Not -Match 'New-IntunePolicy'
            $source | Should -Not -Match 'Remove-ManagedDevice'
        }

        It 'reads device records plus the Defender onboarding state' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'deviceManagement/managedDevices'
            $source | Should -Match 'security/mdeOnboardingState'
        }
    }

    Context 'ConvertTo-MdePlatform' {
        It 'normalizes operatingSystem values to coverage platforms' {
            ConvertTo-MdePlatform -OperatingSystem 'Windows' | Should -Be 'windows'
            ConvertTo-MdePlatform -OperatingSystem 'Windows 11 Enterprise' | Should -Be 'windows'
            ConvertTo-MdePlatform -OperatingSystem 'macOS' | Should -Be 'macos'
            ConvertTo-MdePlatform -OperatingSystem 'iOS' | Should -Be 'ios'
            ConvertTo-MdePlatform -OperatingSystem 'Android Enterprise' | Should -Be 'android'
            ConvertTo-MdePlatform -OperatingSystem 'Ubuntu Linux' | Should -Be 'linux'
        }

        It 'maps empty and unknown values to other' {
            ConvertTo-MdePlatform -OperatingSystem '' | Should -Be 'other'
            ConvertTo-MdePlatform -OperatingSystem 'ChromeOS' | Should -Be 'other'
        }
    }

    Context 'Get-MdeOnboarding coverage' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Uri -like '*mdeOnboardingState*') {
                    return @{
                        value = @(
                            @{ deviceId = 'device-1'; deviceName = 'WS-1001'; onboardingStatus = 'Onboarded' }
                            @{ deviceId = 'device-3'; deviceName = 'MAC-2001'; onboarded = $true }
                            @{ deviceId = 'device-9'; deviceName = 'RET-9001'; onboardingStatus = 'CanBeOnboarded' }
                        )
                    }
                }
                return @{
                    value = @(
                        @{ id = 'device-1'; deviceName = 'WS-1001'; operatingSystem = 'Windows' }
                        @{ id = 'device-2'; deviceName = 'WS-1002'; operatingSystem = 'Windows' }
                        @{ id = 'device-3'; deviceName = 'MAC-2001'; operatingSystem = 'macOS' }
                        @{ id = 'device-4'; deviceName = 'IP-3001'; operatingSystem = 'iOS' }
                    )
                }
            }
        }

        It 'returns onboarded vs total by platform with gap lists' {
            $result = Get-MdeOnboarding -TenantId 'tenant-test'
            $result.tenantId | Should -Be 'tenant-test'

            $windows = @($result.platforms | Where-Object { $_.platform -eq 'windows' })[0]
            $windows | Should -Not -BeNullOrEmpty
            $windows.total | Should -Be 2
            $windows.onboarded | Should -Be 1
            $windows.notOnboarded | Should -Be 1
            $windows.gaps.Count | Should -Be 1
            $windows.gaps[0].id | Should -Be 'device-2'
            $windows.gaps[0].deviceName | Should -Be 'WS-1002'

            $macos = @($result.platforms | Where-Object { $_.platform -eq 'macos' })[0]
            $macos.total | Should -Be 1
            $macos.onboarded | Should -Be 1
            $macos.gaps.Count | Should -Be 0

            $ios = @($result.platforms | Where-Object { $_.platform -eq 'ios' })[0]
            $ios.total | Should -Be 1
            $ios.onboarded | Should -Be 0
            $ios.gaps.Count | Should -Be 1

            $result.totals.total | Should -Be 4
            $result.totals.onboarded | Should -Be 2
            $result.totals.notOnboarded | Should -Be 2
        }

        It 'links each gap to the onboarding deployment policy' {
            $result = Get-MdeOnboarding -TenantId 'tenant-test'
            $result.deploymentPolicyUrl | Should -Be '/v1/tenants/tenant-test/defender/deploy'
            foreach ($platform in $result.platforms) {
                foreach ($gap in $platform.gaps) {
                    $gap.policyUrl | Should -Be $result.deploymentPolicyUrl
                }
            }
        }

        It 'does not count non-onboarded Defender states as onboarded' {
            $result = Get-MdeOnboarding -TenantId 'tenant-test'
            $result.totals.onboarded | Should -Be 2
        }

        It 'narrows to a single platform with -Platform' {
            $result = Get-MdeOnboarding -TenantId 'tenant-test' -Platform 'windows'
            $result.platforms.Count | Should -Be 1
            $result.platforms[0].platform | Should -Be 'windows'
            $result.totals.total | Should -Be 2
        }
    }

    Context 'Read-MdeOnboardingJob' {
        It 'parses tenantId and optional platform from a job envelope' {
            $jobPath = Join-Path $TestDrive 'mde-onboarding-job.json'
            @{ tenantId = 'tenant-test'; platform = 'windows' } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            $job = Read-MdeOnboardingJob -Path $jobPath
            $job['TenantId'] | Should -Be 'tenant-test'
            $job['Platform'] | Should -Be 'windows'
        }

        It 'defaults platform to empty when the envelope omits it' {
            $jobPath = Join-Path $TestDrive 'mde-onboarding-job-no-platform.json'
            @{ tenantId = 'tenant-test' } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            $job = Read-MdeOnboardingJob -Path $jobPath
            $job['TenantId'] | Should -Be 'tenant-test'
            $job['Platform'] | Should -Be ''
        }

        It 'throws when tenantId is missing' {
            $jobPath = Join-Path $TestDrive 'mde-onboarding-job-bad.json'
            @{ platform = 'windows' } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            { Read-MdeOnboardingJob -Path $jobPath } | Should -Throw
        }
    }
}
