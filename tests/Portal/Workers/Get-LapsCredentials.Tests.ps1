BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-LapsCredentials.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-laps-credentials.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri)
    }

    . $script:worker
}

Describe 'Get-LapsCredentials worker (T-0347)' {

    Context 'the worker files' {
        It 'ships the worker function and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-LapsCredentials -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads credentials with GET requests only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match '-Method DELETE'
        }

        It 'never persists credential material to disk, logs, or artifacts' {
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
            $entrySource | Should -Match 'Get-LapsCredentials.ps1'
            $entrySource | Should -Match 'Get-LapsCredentials -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'credential retrieval' {
        It 'returns the Windows LAPS credential without probing legacy' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                return @{
                    credentials = @(@{
                        accountName    = 'Administrator'
                        passwordBase64 = 'windows-secret'
                        backupDateTime = '2026-01-01T00:00:00Z'
                    })
                }
            }

            $result = Get-LapsCredentials -TenantId 'tenant-a' -DeviceId 'device-1'

            $result.tenantId | Should -Be 'tenant-a'
            $result.deviceId | Should -Be 'device-1'
            $result.backend | Should -Be 'windowsLaps'
            $result.accountName | Should -Be 'Administrator'
            $result.password | Should -Be 'windows-secret'
            $result.retrievedAt | Should -Not -BeNullOrEmpty
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter {
                $Method -eq 'GET' -and $Uri -like '*deviceLocalCredentials*'
            }
        }

        It 'falls back to legacy LAPS when Windows holds no credential' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                if ($Uri -like '*deviceLocalCredentials*') {
                    return @{ credentials = @() }
                }
                return @{
                    accountName = 'Admin'
                    password    = 'legacy-secret'
                    backupDateTime = '2026-02-01T00:00:00Z'
                }
            }

            $result = Get-LapsCredentials -TenantId 'tenant-a' -DeviceId 'device-2'

            $result.backend | Should -Be 'legacyLaps'
            $result.password | Should -Be 'legacy-secret'
            Should -Invoke Invoke-MgGraphRequest -Times 2 -Exactly -ParameterFilter { $Method -eq 'GET' }
        }

        It 'throws a structured not-found error when neither backend holds a credential' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                if ($Uri -like '*deviceLocalCredentials*') {
                    return @{ credentials = @() }
                }
                return @{}
            }

            { Get-LapsCredentials -TenantId 'tenant-a' -DeviceId 'device-9' } | Should -Throw '*laps.not_found*'
        }

        It 'issues only GET requests against the LAPS endpoints' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                if ($Uri -like '*deviceLocalCredentials*') {
                    return @{ credentials = @() }
                }
                return @{ accountName = 'Admin'; password = 'legacy-secret' }
            }

            $null = Get-LapsCredentials -TenantId 'tenant-a' -DeviceId 'device-2'

            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -ne 'GET' }
        }

        It 'requires the tenant and device identifiers' {
            { Get-LapsCredentials -TenantId '' -DeviceId 'device-1' } | Should -Throw
            { Get-LapsCredentials -TenantId 'tenant-a' -DeviceId '' } | Should -Throw
        }
    }
}
