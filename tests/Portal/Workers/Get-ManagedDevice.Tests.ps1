BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-ManagedDevice.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-managed-device.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri)
    }

    . $script:worker
}

Describe 'Get-ManagedDevice worker (T-0342)' {

    Context 'the worker files' {
        It 'ships the worker function and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-ManagedDevice -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads device detail with GET requests only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match '-Method DELETE'
        }

        It 'never persists device data to disk, logs, or artifacts' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Export-Clixml'
            $source | Should -Not -Match 'Add-Content'
            $source | Should -Not -Match 'Set-Content'
            $source | Should -Not -Match 'Start-Transcript'
            $source | Should -Not -Match 'Tee-Object'
        }

        It 'entrypoint delegates to the worker and emits the response as JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-ManagedDevice.ps1'
            $entrySource | Should -Match 'Get-ManagedDevice -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'device detail retrieval' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                if ($Uri -like '*detectedApps*') {
                    return @{ value = @(@{ id = 'app-1'; displayName = 'Microsoft Edge'; version = '120.0'; publisher = 'Microsoft' }) }
                }
                if ($Uri -like '*deviceCompliancePolicyStates*') {
                    return @{ value = @(@{ id = 'pol-1'; displayName = 'Compliance Policy 1'; state = 'compliant'; lastReportedDateTime = '2026-09-20T00:00:00Z' }) }
                }
                if ($Uri -like '*deviceConfigurationStates*') {
                    return @{ value = @() }
                }
                return @{
                    id = 'device-1'
                    deviceName = 'WS-1001'
                    userPrincipalName = 'alice@example.com'
                    operatingSystem = 'Windows'
                    osVersion = '10.0.22631'
                    complianceState = 'compliant'
                    managementState = 'managed'
                    deviceType = 'windows10'
                    managedDeviceOwnerType = 'company'
                    lastSyncDateTime = '2026-09-20T00:00:00Z'
                    enrolledDateTime = '2026-01-10T00:00:00Z'
                    serialNumber = 'SN1001'
                    isEncrypted = $true
                    model = 'Surface Pro 9'
                    manufacturer = 'Microsoft'
                    storageSpace = 256000000000
                    totalStorageSpace = 512000000000
                    phoneNumber = ''
                    imei = ''
                }
            }
        }

        It 'returns the device detail with all tab data' {
            $result = Get-ManagedDevice -TenantId 'tenant-a' -DeviceId 'device-1'

            $result.tenantId | Should -Be 'tenant-a'
            $result.deviceId | Should -Be 'device-1'
            $result.overview.deviceName | Should -Be 'WS-1001'
            $result.overview.ownerUpn | Should -Be 'alice@example.com'
            $result.overview.platform | Should -Be 'Windows'
            $result.overview.compliance | Should -Be 'compliant'
            $result.overview.serial | Should -Be 'SN1001'
            $result.overview.encrypted | Should -BeTrue
            $result.hardware.model | Should -Be 'Surface Pro 9'
            $result.hardware.manufacturer | Should -Be 'Microsoft'
            $result.software | Should -HaveCount 1
            $result.software[0].displayName | Should -Be 'Microsoft Edge'
            $result.policies | Should -HaveCount 1
            $result.policies[0].displayName | Should -Be 'Compliance Policy 1'
            $result.encryption.encrypted | Should -BeTrue
            $result.encryption.keyType | Should -Be 'bitlocker'
            $result.retrievedAt | Should -Not -BeNullOrEmpty
        }

        It 'issues only GET requests against the Graph endpoints' {
            $null = Get-ManagedDevice -TenantId 'tenant-a' -DeviceId 'device-1'

            Should -Invoke Invoke-MgGraphRequest -Times 4 -Exactly -ParameterFilter { $Method -eq 'GET' }
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -ne 'GET' }
        }

        It 'requires the tenant and device identifiers' {
            { Get-ManagedDevice -TenantId '' -DeviceId 'device-1' } | Should -Throw
            { Get-ManagedDevice -TenantId 'tenant-a' -DeviceId '' } | Should -Throw
        }
    }
}
