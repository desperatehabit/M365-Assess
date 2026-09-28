BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-DeviceWipe.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-device-wipe.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body, $ContentType)
    }

    . $script:worker
}

Describe 'Invoke-DeviceWipe worker (T-0345)' {

    Context 'the worker files' {
        It 'ships the worker function and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-DeviceWipe -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'applies actions with POST requests only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match "Method\s*=\s*'POST'"
            $source | Should -Not -Match "Method\s*=\s*'GET'"
            $source | Should -Not -Match "Method\s*=\s*'PATCH'"
            $source | Should -Not -Match "Method\s*=\s*'PUT'"
            $source | Should -Not -Match "Method\s*=\s*'DELETE'"
        }

        It 'entrypoint delegates to the worker and emits the response as JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Invoke-DeviceWipe.ps1'
            $entrySource | Should -Match 'Invoke-DeviceWipe -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'device wipe application' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body, $ContentType)
                return @{ success = $true }
            }
        }

        It 'applies a wipe action with a reason' {
            $result = Invoke-DeviceWipe -TenantId 'tenant-a' -DeviceId 'device-1' -Action 'wipe' -Reason 'Device lost'

            $result.tenantId | Should -Be 'tenant-a'
            $result.deviceId | Should -Be 'device-1'
            $result.action | Should -Be 'wipe'
            $result.reason | Should -Be 'Device lost'
            $result.result | Should -Be 'success'
            $result.appliedAt | Should -Not -BeNullOrEmpty
        }

        It 'applies a fresh-start action' {
            $result = Invoke-DeviceWipe -TenantId 'tenant-a' -DeviceId 'device-1' -Action 'fresh-start' -Reason 'Device refresh'

            $result.action | Should -Be 'fresh-start'
            $result.reason | Should -Be 'Device refresh'
            $result.result | Should -Be 'success'
        }

        It 'issues a POST request to the correct Graph endpoint' {
            $null = Invoke-DeviceWipe -TenantId 'tenant-a' -DeviceId 'device-1' -Action 'wipe' -Reason 'Device lost'

            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Uri -like '*wipe*' }
        }

        It 'issues a POST request to the fresh-start endpoint for fresh-start' {
            $null = Invoke-DeviceWipe -TenantId 'tenant-a' -DeviceId 'device-1' -Action 'fresh-start' -Reason 'Device refresh'

            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Uri -like '*freshStart*' }
        }

        It 'requires the tenant, device, and action' {
            { Invoke-DeviceWipe -TenantId '' -DeviceId 'device-1' -Action 'wipe' } | Should -Throw
            { Invoke-DeviceWipe -TenantId 'tenant-a' -DeviceId '' -Action 'wipe' } | Should -Throw
            { Invoke-DeviceWipe -TenantId 'tenant-a' -DeviceId 'device-1' -Action 'invalid' } | Should -Throw
        }
    }
}
