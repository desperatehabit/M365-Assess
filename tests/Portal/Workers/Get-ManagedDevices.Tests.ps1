BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-ManagedDevices.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-managed-devices.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Get-ManagedDevices worker (T-0341)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-ManagedDevices -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-ManagedDevicesJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
        }
    }

    Context 'Get-ManagedDevices live mapping and filtering' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{
                    value = @(
                        @{
                            id = 'dev-win'
                            deviceName = 'WS-1001'
                            userPrincipalName = 'alice@contoso.com'
                            operatingSystem = 'Windows'
                            osVersion = '10.0.22631'
                            complianceState = 'compliant'
                            managedDeviceOwnerType = 'company'
                            lastSyncDateTime = (Get-Date).ToUniversalTime().AddDays(-1).ToString('o')
                            enrolledDateTime = '2026-01-10T00:00:00Z'
                            serialNumber = 'SN1001'
                            isEncrypted = $true
                        }
                        @{
                            id = 'dev-ios'
                            deviceName = 'iPhone-7'
                            userPrincipalName = 'bob@contoso.com'
                            operatingSystem = 'iOS'
                            osVersion = '18.1'
                            complianceState = 'noncompliant'
                            managedDeviceOwnerType = 'personal'
                            lastSyncDateTime = (Get-Date).ToUniversalTime().AddDays(-60).ToString('o')
                            enrolledDateTime = '2025-11-02T00:00:00Z'
                            serialNumber = 'SN2002'
                            isEncrypted = $false
                        }
                        @{
                            id = 'dev-android'
                            deviceName = 'Pixel-9'
                            userPrincipalName = 'cara@contoso.com'
                            operatingSystem = 'Android'
                            osVersion = '15'
                            complianceState = 'unknown'
                            managedDeviceOwnerType = 'personal'
                            lastSyncDateTime = (Get-Date).ToUniversalTime().AddDays(-100).ToString('o')
                            enrolledDateTime = '2025-08-14T00:00:00Z'
                            serialNumber = 'SN3003'
                            isEncrypted = $false
                        }
                        @{
                            id = 'dev-mac'
                            deviceName = 'MBP-204'
                            userPrincipalName = 'dana@contoso.com'
                            operatingSystem = 'macOS'
                            osVersion = '15.2'
                            complianceState = 'compliant'
                            managedDeviceOwnerType = 'company'
                            lastSyncDateTime = (Get-Date).ToUniversalTime().AddDays(-40).ToString('o')
                            enrolledDateTime = '2025-12-01T00:00:00Z'
                            serialNumber = 'SN4004'
                            isEncrypted = $true
                        }
                    )
                }
            }
        }

        It 'returns all devices with the section 3.1 columns' {
            $result = Get-ManagedDevices -TenantId 'tenant-test'
            $result.tenantId | Should -Be 'tenant-test'
            $result.totalCount | Should -Be 4
            $result.items.Count | Should -Be 4

            $win = $result.items | Where-Object { $_.id -eq 'dev-win' }
            $win.deviceName | Should -Be 'WS-1001'
            $win.ownerUpn | Should -Be 'alice@contoso.com'
            $win.platform | Should -Be 'Windows'
            $win.compliance | Should -Be 'compliant'
            $win.ownership | Should -Be 'company'
            $win.serial | Should -Be 'SN1001'
            $win.encrypted | Should -BeTrue
            $win.lastCheckIn | Should -Not -BeNullOrEmpty
            $win.enrolled | Should -Be '2026-01-10T00:00:00Z'
        }

        It 'filters by platform' {
            $result = Get-ManagedDevices -TenantId 'tenant-test' -Platform 'iOS'
            $result.totalCount | Should -Be 1
            $result.items[0].id | Should -Be 'dev-ios'
        }

        It 'filters by compliance' {
            $result = Get-ManagedDevices -TenantId 'tenant-test' -Compliance 'compliant'
            $result.totalCount | Should -Be 2
        }

        It 'filters by ownership' {
            $result = Get-ManagedDevices -TenantId 'tenant-test' -Ownership 'personal'
            $result.totalCount | Should -Be 2
        }

        It 'filters by encrypted' {
            $result = Get-ManagedDevices -TenantId 'tenant-test' -Encrypted 'true'
            $result.totalCount | Should -Be 2

            $plain = Get-ManagedDevices -TenantId 'tenant-test' -Encrypted 'false'
            $plain.totalCount | Should -Be 2
        }

        It 'filters by last check-in age' {
            $stale = Get-ManagedDevices -TenantId 'tenant-test' -LastCheckIn '30d'
            $stale.totalCount | Should -Be 3
            $stale.items.id | Should -Not -Contain 'dev-win'
        }

        It 'filters by search term across name, owner, and serial' {
            $byName = Get-ManagedDevices -TenantId 'tenant-test' -Search 'pixel'
            $byName.totalCount | Should -Be 1
            $byName.items[0].id | Should -Be 'dev-android'

            $byOwner = Get-ManagedDevices -TenantId 'tenant-test' -Search 'bob@'
            $byOwner.totalCount | Should -Be 1
            $byOwner.items[0].id | Should -Be 'dev-ios'

            $bySerial = Get-ManagedDevices -TenantId 'tenant-test' -Search 'sn4004'
            $bySerial.totalCount | Should -Be 1
            $bySerial.items[0].id | Should -Be 'dev-mac'
        }
    }
}
