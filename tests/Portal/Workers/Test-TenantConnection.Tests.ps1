BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Test-TenantConnection.ps1'
    $script:resolver = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Resolve-TenantCredential.ps1'
    $script:stubTenantId = '00000000-0000-0000-0000-000000000001'
    $script:sentinelSecret = 'SENTINEL-SECRET-9f8b7a6c5d4e'
    $script:sentinelRef = 'ref://store/sentinel-credential'

    . (Join-Path -Path $script:repoRoot -ChildPath 'src/M365-Assess/Common/RunContext.ps1')
    . $script:resolver
    . $script:worker

    function script:New-StubThumbprintRecord {
        return @{
            tenantId    = $script:stubTenantId
            authMethod  = 'certificate-thumbprint'
            clientId    = '00000000-0000-0000-0000-000000000002'
            secretRef   = ''
            thumbprint  = 'AA11BB22CC33DD44EE55FF660011223344556677'
            environment = 'commercial'
        }
    }

    function script:New-StubSecretRecord {
        return @{
            tenantId    = $script:stubTenantId
            authMethod  = 'client-secret'
            clientId    = '00000000-0000-0000-0000-000000000002'
            secretRef   = $script:sentinelRef
            thumbprint  = $null
            environment = 'commercial'
        }
    }

    function script:New-StubSecretStore {
        $secret = $script:sentinelSecret
        return {
            param([string]$SecretRef)
            return $secret
        }.GetNewClosure()
    }
}

Describe 'Test-TenantConnection worker (T-0024)' {

    Context 'the worker script' {
        It 'ships the worker script' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            (Get-Command -Name 'Test-TenantConnection' -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'does not issue tenant configuration writes or write files' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Set-Mg'
            $source | Should -Not -Match 'New-Mg'
            $source | Should -Not -Match 'Remove-Mg'
            $source | Should -Not -Match 'Set-ExecutionPolicy'
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Export-Clixml'
        }
    }

    Context 'successful connection test' {
        It 'reports per-service pass and overall success with certificate auth' {
            $record = script:New-StubThumbprintRecord
            $handler = {
                param($Service, $Auth, $TenantId)
                return $true
            }

            $result = Test-TenantConnection -TenantId $script:stubTenantId `
                                            -CredentialRef "tenants/$script:stubTenantId/credential" `
                                            -CredentialRecord $record `
                                            -ConnectHandler $handler

            $result | Should -Not -BeNullOrEmpty
            $result.tenantId | Should -Be $script:stubTenantId
            $result.success | Should -BeTrue
            $result.testedAt | Should -Not -BeNullOrEmpty
            $result.services.Count | Should -Be 3

            $graph = $result.services | Where-Object { $_.service -eq 'Graph' }
            $graph.status | Should -Be 'pass'
            $graph.connected | Should -BeTrue
            $graph.error | Should -BeNullOrEmpty

            $exo = $result.services | Where-Object { $_.service -eq 'ExchangeOnline' }
            $exo.status | Should -Be 'pass'
            $exo.connected | Should -BeTrue
            $exo.error | Should -BeNullOrEmpty

            $purview = $result.services | Where-Object { $_.service -eq 'Purview' }
            $purview.status | Should -Be 'pass'
            $purview.connected | Should -BeTrue
            $purview.error | Should -BeNullOrEmpty
        }
    }

    Context 'partial failure in connection test' {
        It 'reports pass for working services and fail for broken service' {
            $record = script:New-StubThumbprintRecord
            $handler = {
                param($Service, $Auth, $TenantId)
                if ($Service -eq 'Purview') {
                    throw "Purview endpoint timed out."
                }
                return $true
            }

            $result = Test-TenantConnection -TenantId $script:stubTenantId `
                                            -CredentialRef "tenants/$script:stubTenantId/credential" `
                                            -CredentialRecord $record `
                                            -ConnectHandler $handler

            $result.success | Should -BeFalse
            $graph = $result.services | Where-Object { $_.service -eq 'Graph' }
            $graph.status | Should -Be 'pass'

            $purview = $result.services | Where-Object { $_.service -eq 'Purview' }
            $purview.status | Should -Be 'fail'
            $purview.connected | Should -BeFalse
            $purview.error | Should -Match 'Purview endpoint timed out'
        }
    }

    Context 'secret protection' {
        It 'never echoes secret material into error payloads or results' {
            $record = script:New-StubSecretRecord
            $store = script:New-StubSecretStore
            $handler = {
                param($Service, $Auth, $TenantId)
                # Simulate an error that inadvertently includes the raw secret in the exception message
                throw "Authentication failed with secret $script:sentinelSecret for service $Service"
            }

            $result = Test-TenantConnection -TenantId $script:stubTenantId `
                                            -CredentialRef "tenants/$script:stubTenantId/credential" `
                                            -CredentialRecord $record `
                                            -CredentialStore $store `
                                            -ConnectHandler $handler

            $result.success | Should -BeFalse
            $json = $result | ConvertTo-Json -Depth 5
            $json | Should -Not -Match $script:sentinelSecret
            $json | Should -Match '\[REDACTED\]'
        }
    }

    Context 'client-secret auth with Exchange and Purview' {
        It 'marks ExchangeOnline and Purview as fail due to unsupported auth without throwing' {
            $record = script:New-StubSecretRecord
            $store = script:New-StubSecretStore
            $handler = {
                param($Service, $Auth, $TenantId)
                return $true
            }

            $result = Test-TenantConnection -TenantId $script:stubTenantId `
                                            -CredentialRef "tenants/$script:stubTenantId/credential" `
                                            -CredentialRecord $record `
                                            -CredentialStore $store `
                                            -ConnectHandler $handler

            $result.success | Should -BeFalse
            $graph = $result.services | Where-Object { $_.service -eq 'Graph' }
            $graph.status | Should -Be 'pass'

            $exo = $result.services | Where-Object { $_.service -eq 'ExchangeOnline' }
            $exo.status | Should -Be 'fail'
            $exo.error | Should -Match 'client-secret'

            $purview = $result.services | Where-Object { $_.service -eq 'Purview' }
            $purview.status | Should -Be 'fail'
            $purview.error | Should -Match 'client-secret'
        }
    }
}
