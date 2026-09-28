BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-DeviceAction.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-device-action.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body, $ContentType)
    }

    . $script:worker
}

Describe 'Invoke-DeviceAction worker (T-0344)' {

    Context 'the worker files' {
        It 'ships the worker function and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-DeviceAction -CommandType Function) | Should -Not -BeNullOrEmpty
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
            $entrySource | Should -Match 'Invoke-DeviceAction.ps1'
            $entrySource | Should -Match 'Invoke-DeviceAction -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'device action application' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body, $ContentType)
                return @{ success = $true }
            }
        }

        It 'applies a sync action without a reason' {
            $result = Invoke-DeviceAction -TenantId 'tenant-a' -DeviceId 'device-1' -Action 'sync'

            $result.tenantId | Should -Be 'tenant-a'
            $result.deviceId | Should -Be 'device-1'
            $result.action | Should -Be 'sync'
            $result.reason | Should -BeNullOrEmpty
            $result.result | Should -Be 'success'
            $result.appliedAt | Should -Not -BeNullOrEmpty
        }

        It 'applies a retire action with a reason' {
            $result = Invoke-DeviceAction -TenantId 'tenant-a' -DeviceId 'device-1' -Action 'retire' -Reason 'Device lost'

            $result.action | Should -Be 'retire'
            $result.reason | Should -Be 'Device lost'
            $result.result | Should -Be 'success'
        }

        It 'issues a POST request to the correct Graph endpoint' {
            $null = Invoke-DeviceAction -TenantId 'tenant-a' -DeviceId 'device-1' -Action 'sync'

            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Uri -like '*syncDevice*' }
        }

        it 'issues a POST request to the retire endpoint for retire' {
            $null = Invoke-DeviceAction -TenantId 'tenant-a' -DeviceId 'device-1' -Action 'retire' -Reason 'Device lost'

            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Uri -like '*retire*' }
        }

        It 'requires the tenant, device, and action' {
            { Invoke-DeviceAction -TenantId '' -DeviceId 'device-1' -Action 'sync' } | Should -Throw
            { Invoke-DeviceAction -TenantId 'tenant-a' -DeviceId '' -Action 'sync' } | Should -Throw
            { Invoke-DeviceAction -TenantId 'tenant-a' -DeviceId 'device-1' -Action 'invalid' } | Should -Throw
        }
    }
}
