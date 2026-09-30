BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-LicenseGates.ps1'
    $script:overlayPath = Join-Path $script:repoRoot 'src/M365-Assess/controls/licensing-overlay.json'

    function Get-MgSubscribedSku {
        return @()
    }

    . $script:worker
}

Describe 'Get-LicenseGates worker (T-0646)' {

    Context 'the worker files' {
        It 'ships the worker functions' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            (Get-Command Get-LicenseGates -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-LicenseGatesJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }
    }

    Context 'Job envelope reading' {
        It 'throws when envelope does not exist' {
            { Read-LicenseGatesJob -Path '/path/does/not/exist.json' } | Should -Throw "*not found*"
        }

        It 'throws when tenantId is missing' {
            $tmp = New-TemporaryFile
            Set-Content -LiteralPath $tmp.FullName -Value '{"category":"licensing"}'
            try {
                { Read-LicenseGatesJob -Path $tmp.FullName } | Should -Throw "*missing mandatory 'tenantId'*"
            }
            finally {
                Remove-Item -LiteralPath $tmp.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'overlay resolution against subscribed SKUs' {
        It 'reads the overlay from the module path and resolves held plans as available' {
            Mock Get-MgSubscribedSku {
                return @(
                    [PSCustomObject]@{
                        SkuPartNumber = 'SPE_E5'
                        ServicePlans  = @(
                            [PSCustomObject]@{ ServicePlanName = 'AAD_PREMIUM_P2'; ProvisioningStatus = 'Success' },
                            [PSCustomObject]@{ ServicePlanName = 'ATP_ENTERPRISE'; ProvisioningStatus = 'Success' }
                        )
                    }
                )
            }

            $res = Get-LicenseGates -TenantId 'tenant-test'

            $res.tenantId | Should -Be 'tenant-test'
            $res.gates['CA-SIGNINRISK-001'].status | Should -Be 'available'
            $res.gates['CA-SIGNINRISK-001'].requiredPlans | Should -Be @('AAD_PREMIUM_P2')
            $res.gates['CA-SIGNINRISK-001'].missingPlans | Should -Be @()
            $res.gates['DEFENDER-ANTIPHISH-001'].status | Should -Be 'available'
            $res.gates['ENTRA-PIM-001'].status | Should -Be 'available'
        }

        It 'reports gated, not an error, when the required plan is absent' {
            Mock Get-MgSubscribedSku {
                return @(
                    [PSCustomObject]@{
                        SkuPartNumber = 'SPE_E3'
                        ServicePlans  = @(
                            [PSCustomObject]@{ ServicePlanName = 'EXCHANGE_S_ENTERPRISE'; ProvisioningStatus = 'Success' }
                        )
                    }
                )
            }

            $res = Get-LicenseGates -TenantId 'tenant-test'
            $res | Should -Not -BeNullOrEmpty

            $res.gates['CA-SIGNINRISK-001'].status | Should -Be 'gated'
            $res.gates['CA-SIGNINRISK-001'].requiredPlans | Should -Be @('AAD_PREMIUM_P2')
            $res.gates['CA-SIGNINRISK-001'].missingPlans | Should -Be @('AAD_PREMIUM_P2')
        }

        It 'gates a multi-plan feature when any required plan is missing' {
            Mock Get-MgSubscribedSku {
                return @(
                    [PSCustomObject]@{
                        SkuPartNumber = 'SPE_E5'
                        ServicePlans  = @(
                            [PSCustomObject]@{ ServicePlanName = 'INFORMATION_PROTECTION_COMPLIANCE'; ProvisioningStatus = 'Success' }
                        )
                    }
                )
            }

            $res = Get-LicenseGates -TenantId 'tenant-test'

            $res.gates['COMPLIANCE-DLP-002'].status | Should -Be 'gated'
            $res.gates['COMPLIANCE-DLP-002'].requiredPlans | Should -Be @('INFORMATION_PROTECTION_COMPLIANCE', 'COMMUNICATIONS_DLP')
            $res.gates['COMPLIANCE-DLP-002'].missingPlans | Should -Be @('COMMUNICATIONS_DLP')
        }

        It 'gates every feature when license resolution yields no active plans' {
            Mock Get-MgSubscribedSku {
                return @()
            }

            $res = Get-LicenseGates -TenantId 'tenant-test'

            $res.gates['CA-SIGNINRISK-001'].status | Should -Be 'gated'
            $res.gates['ENTRA-PIM-005'].status | Should -Be 'gated'
        }

        It 'never mutates the overlay file on disk' {
            Mock Get-MgSubscribedSku {
                return @()
            }

            $before = (Get-FileHash -LiteralPath $script:overlayPath -Algorithm SHA256).Hash
            $null = Get-LicenseGates -TenantId 'tenant-test'
            $after = (Get-FileHash -LiteralPath $script:overlayPath -Algorithm SHA256).Hash

            $after | Should -Be $before
        }

        It 'serializes the gate map for the BFF JSON contract' {
            Mock Get-MgSubscribedSku {
                return @(
                    [PSCustomObject]@{
                        SkuPartNumber = 'SPE_E5'
                        ServicePlans  = @(
                            [PSCustomObject]@{ ServicePlanName = 'AAD_PREMIUM_P2'; ProvisioningStatus = 'Success' }
                        )
                    }
                )
            }

            $res = Get-LicenseGates -TenantId 'tenant-test'
            $parsed = $res | ConvertTo-Json -Depth 10 -Compress | ConvertFrom-Json

            $parsed.gates.'CA-SIGNINRISK-001'.status | Should -Be 'available'
            $parsed.gates.'ENTRA-PIM-001'.status | Should -Be 'available'
            $parsed.gates.'COMPLIANCE-LABELS-002'.status | Should -Be 'gated'
        }

        It 'throws when the overlay file is missing' {
            { Get-LicenseGates -TenantId 'tenant-test' -OverlayPath '/path/does/not/exist.json' } | Should -Throw "*licensing overlay not found*"
        }
    }

    Context 'overlay override' {
        It 'resolves an empty required-plan list as available' {
            $tmp = New-TemporaryFile
            Set-Content -LiteralPath $tmp.FullName -Value '{"checks":{"TEST-EMPTY-001":[]}}'
            try {
                Mock Get-MgSubscribedSku {
                    return @()
                }

                $res = Get-LicenseGates -TenantId 'tenant-test' -OverlayPath $tmp.FullName

                $res.gates['TEST-EMPTY-001'].status | Should -Be 'available'
                $res.gates['TEST-EMPTY-001'].requiredPlans | Should -Be @()
                $res.gates['TEST-EMPTY-001'].missingPlans | Should -Be @()
            }
            finally {
                Remove-Item -LiteralPath $tmp.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
