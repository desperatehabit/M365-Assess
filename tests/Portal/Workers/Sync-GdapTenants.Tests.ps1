BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Sync-GdapTenants.ps1'

    . $script:worker
}

Describe 'Sync-GdapTenants worker (T-0029)' {

    Context 'the worker script' {
        It 'ships the worker script and function' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            (Get-Command -Name 'Sync-GdapTenants' -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'does not modify direct tenants or perform tenant configuration writes' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'source\s*=\s*[\x27"]direct[\x27"]'
            $source | Should -Not -Match 'Set-Mg'
            $source | Should -Not -Match 'New-Mg'
        }
    }

    Context 'relationship discovery and mapping' {
        It 'upserts active relationships with source gdap' {
            $mockResponse = @{
                value = @(
                    @{
                        id = 'rel-1'
                        status = 'active'
                        endDateTime = '2027-01-01T00:00:00Z'
                        cpvConsentState = 'consented'
                        customer = @{
                            tenantId = '11111111-1111-1111-1111-111111111111'
                            displayName = 'Partner Customer 1'
                        }
                    }
                )
            }

            $handler = {
                param($Uri, $Method)
                return $mockResponse
            }

            $result = Sync-GdapTenants -GraphRequestHandler $handler

            $result.totalDiscovered | Should -Be 1
            $t = $result.tenants[0]
            $t.id | Should -Be '11111111-1111-1111-1111-111111111111'
            $t.displayName | Should -Be 'Partner Customer 1'
            $t.source | Should -Be 'gdap'
            $t.status | Should -Be 'active'
            $t.excluded | Should -BeFalse
            $t.excludeReason | Should -BeNullOrEmpty

            $rel = $result.relationships[0]
            $rel.tenantId | Should -Be '11111111-1111-1111-1111-111111111111'
            $rel.relationshipEnd | Should -Be '2027-01-01T00:00:00Z'
            $rel.delegatedPrivilegeStatus | Should -Be 'active'
            $rel.cpvConsentState | Should -Be 'consented'
        }

        It 'marks inactive/terminated relationships as excluded and does not drop them' {
            $mockResponse = @{
                value = @(
                    @{
                        id = 'rel-2'
                        status = 'terminated'
                        endDateTime = '2025-12-01T00:00:00Z'
                        cpvConsentState = 'pending'
                        customer = @{
                            tenantId = '22222222-2222-2222-2222-222222222222'
                            displayName = 'Terminated Partner Customer'
                        }
                    }
                )
            }

            $handler = {
                param($Uri, $Method)
                return $mockResponse
            }

            $result = Sync-GdapTenants -GraphRequestHandler $handler

            $result.totalDiscovered | Should -Be 1
            $t = $result.tenants[0]
            $t.id | Should -Be '22222222-2222-2222-2222-222222222222'
            $t.source | Should -Be 'gdap'
            $t.status | Should -Be 'excluded'
            $t.excluded | Should -BeTrue
            $t.excludeReason | Should -Match 'terminated'

            $rel = $result.relationships[0]
            $rel.cpvConsentState | Should -Be 'pending'
            $rel.delegatedPrivilegeStatus | Should -Be 'terminated'
        }
    }
}
