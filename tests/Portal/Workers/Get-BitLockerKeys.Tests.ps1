BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-BitLockerKeys.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-bitlocker-keys.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri)
    }

    . $script:worker
}

Describe 'Get-BitLockerKeys worker (T-0346)' {

    Context 'the worker files' {
        It 'ships the worker function and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-BitLockerKeys -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads keys with GET requests only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match '-Method DELETE'
        }

        It 'never persists key material to disk, logs, or artifacts' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Export-Clixml'
            $source | Should -Not -Match 'Add-Content'
            $source | Should -Not -Match 'Set-Content'
            $source | Should -Not -Match 'Start-Transcript'
            $source | Should -Not -Match 'Tee-Object'
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Not -Match 'Out-File'
            $entrySource | Should -Not -Match 'Start-Transcript'
        }

        It 'entrypoint delegates to the worker and emits the response as JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-BitLockerKeys.ps1'
            $entrySource | Should -Match 'Get-BitLockerKeys -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'key retrieval' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                if ($Uri -like '*$select=key*') {
                    $id = ($Uri -split '/')[-1] -split '\?' | Select-Object -First 1
                    return @{ key = "recovery-key-for-$id"; createdDateTime = '2026-01-01T00:00:00Z' }
                }
                return @{ value = @(@{ id = 'key-1' }, @{ id = 'key-2' }) }
            }
        }

        It 'returns the device keys with metadata in the response object' {
            $result = Get-BitLockerKeys -TenantId 'tenant-a' -DeviceId 'device-1'

            $result.tenantId | Should -Be 'tenant-a'
            $result.deviceId | Should -Be 'device-1'
            $result.keys | Should -HaveCount 2
            $result.keys[0].keyId | Should -Be 'key-1'
            $result.keys[0].key | Should -Be 'recovery-key-for-key-1'
            $result.keys[0].keyType | Should -Be 'bitlocker'
            $result.retrievedAt | Should -Not -BeNullOrEmpty
        }

        It 'issues only GET requests against the BitLocker endpoints' {
            $null = Get-BitLockerKeys -TenantId 'tenant-a' -DeviceId 'device-1'

            Should -Invoke Invoke-MgGraphRequest -Times 3 -Exactly -ParameterFilter { $Method -eq 'GET' }
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -ne 'GET' }
            Should -Invoke Invoke-MgGraphRequest -ParameterFilter { $Uri -like '*informationProtection/bitlocker/recoveryKeys*' }
        }

        It 'returns an empty key list when the device has no recovery keys' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                return @{ value = @() }
            }

            $result = Get-BitLockerKeys -TenantId 'tenant-a' -DeviceId 'device-9'

            $result.keys | Should -HaveCount 0
            $result.deviceId | Should -Be 'device-9'
        }

        It 'requires the tenant and device identifiers' {
            { Get-BitLockerKeys -TenantId '' -DeviceId 'device-1' } | Should -Throw
            { Get-BitLockerKeys -TenantId 'tenant-a' -DeviceId '' } | Should -Throw
        }
    }
}
