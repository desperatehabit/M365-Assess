BeforeAll {
    $script:repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '../../../')
    $script:worker     = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-IntuneAppStatus.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-intune-app-status.ps1'

    # Stub Invoke-MgGraphRequest before dot-sourcing the worker.
    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    function script:Invoke-FakeStatusGraph {
        param($Method, $Uri)
        $script:calls.Add("$Method $Uri")
        switch -Regex ($Uri) {
            'mobileApps\?\$select' {
                return @{ value = @(
                        @{ '@odata.type' = '#microsoft.graph.win32LobApp'; id = 'app-1'; displayName = '7-Zip' }
                        @{ '@odata.type' = '#microsoft.graph.officeSuiteApp'; id = 'app-o'; displayName = 'M365 Apps' }
                        @{ '@odata.type' = '#microsoft.graph.winGetApp'; id = 'app-2'; displayName = 'Company Portal' }
                    ) }
            }
            'mobileApps/app-1/deviceStatuses' {
                return @{ value = @(
                        @{ deviceId = 'd1'; deviceName = 'LAPTOP-01'; userPrincipalName = 'ann@contoso.com'; installState = 'installed'; errorCode = 0; lastSyncDateTime = '2026-09-27T10:00:00Z' }
                        @{ deviceId = 'd2'; deviceName = 'LAPTOP-02'; userPrincipalName = ''; installState = 'failed'; errorCode = -2016345060 }
                    ) }
            }
            'mobileApps/app-2/deviceStatuses' { return @{ value = @() } }
            'windowsAutopilotDeviceIdentities' { return @{ value = @(@{ id = 'ap-1'; serialNumber = 'SER-001'; displayName = 'LAPTOP-01'; enrollmentState = 'enrolled' }) } }
            'depOnboardingSettings$' { return @{ value = @(@{ id = 'dep-1' }) } }
            'depOnboardingSettings/dep-1/importedAppleDeviceIdentities' { return @{ value = @(@{ id = 'ade-1'; serialNumber = 'C02X1'; platform = 'iOS'; enrollmentState = 'notContacted' }) } }
            'managedDevices' {
                return @{ value = @(
                        @{ id = 'and-1'; deviceName = 'KIOSK-7'; serialNumber = 'R58N'; deviceEnrollmentType = 'androidEnterpriseDedicatedDevice'; managementState = 'managed' }
                        @{ id = 'and-2'; deviceName = 'BYOD'; serialNumber = 'X'; deviceEnrollmentType = 'userEnrollment'; managementState = 'managed' }
                    ) }
            }
            default { throw "unexpected $Uri" }
        }
    }
}

Describe 'Get-IntuneAppStatus worker (T-0844)' {
    BeforeEach {
        $script:calls = [System.Collections.Generic.List[string]]::new()
        Mock Invoke-MgGraphRequest { param($Method, $Uri) Invoke-FakeStatusGraph -Method $Method -Uri $Uri }
    }

    It 'issues only GET requests' {
        $null = Get-AppDeviceStatuses
        $null = Get-EnrollmentDeviceStatuses
        @($script:calls | Where-Object { $_ -notlike 'GET *' }).Count | Should -Be 0
        (Get-Content -LiteralPath $script:worker -Raw) | Should -Not -Match '-Method\s+(POST|PATCH|PUT|DELETE)'
    }

    It 'reads install status per device for Win32 and Store apps only' {
        $rows = Get-AppDeviceStatuses
        $rows.Count | Should -Be 2
        $script:calls | Should -Not -Contain 'GET /beta/deviceAppManagement/mobileApps/app-o/deviceStatuses'
        $rows[0].appName | Should -Be '7-Zip'
        $rows[0].installState | Should -Be 'installed'
        $rows[0].errorCode | Should -BeNullOrEmpty
        $rows[1].errorCode | Should -Be '0x87D1041C'
        $rows[1].userPrincipalName | Should -BeNullOrEmpty
    }

    It 'caps the apps it reads' {
        $null = Get-AppDeviceStatuses -MaxApps 1
        @($script:calls | Where-Object { $_ -like '*deviceStatuses' }).Count | Should -Be 1
    }

    It 'reads enrollment from Autopilot, Apple ADE, and Android Enterprise only' {
        $rows = Get-EnrollmentDeviceStatuses
        @($rows.source) | Should -Be @('autopilot', 'apple-ade', 'android-enterprise')
        $rows[1].platform | Should -Be 'ios'
        $rows[1].enrollmentState | Should -Be 'notContacted'
        $rows[2].enrollmentState | Should -Be 'enrolled'
        $rows[2].serialNumber | Should -Be 'R58N'
    }

    It 'prints the rows as a JSON array through the entrypoint, even for one row' {
        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            if ($Uri -like '*windowsAutopilotDeviceIdentities*') { return @{ value = @(@{ id = 'ap-1'; serialNumber = 'S'; enrollmentState = 'enrolled' }) } }
            return @{ value = @() }
        }
        $path = Join-Path $TestDrive 'job.json'
        @{ tenantId = 't'; action = 'enrollment' } | ConvertTo-Json | Set-Content -LiteralPath $path
        $out = & $script:entrypoint -JobFile $path | ConvertFrom-Json
        @($out.items).Count | Should -Be 1
        $out.items[0].serialNumber | Should -Be 'S'
    }

    It 'rejects an unknown action' {
        $path = Join-Path $TestDrive 'bad.json'
        @{ tenantId = 't'; action = 'devices' } | ConvertTo-Json | Set-Content -LiteralPath $path
        { Read-IntuneAppStatusJob -Path $path } | Should -Throw '*unknown action*'
    }
}
