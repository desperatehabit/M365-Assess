BeforeAll {
    $script:moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../src/M365-Assess')).Path
    $script:allowlistScript = Join-Path $script:moduleRoot 'Remediate/Get-RemediationAllowlist.ps1'
    $script:gateScript = Join-Path $script:moduleRoot 'Remediate/Test-RemediationGate.ps1'
    $script:psm1 = Join-Path $script:moduleRoot 'M365-Assess.psm1'

    . $script:allowlistScript
    . $script:gateScript

    function New-TestCaller {
        param(
            [string[]]$Permissions = @('remediation.apply'),
            [string[]]$TenantIds = @('tenant-a'),
            [switch]$AllTenants
        )
        @{
            Permissions = $Permissions
            TenantScope = @{
                All       = [bool]$AllTenants
                TenantIds = $TenantIds
            }
        }
    }

    $script:fixtureAllowlist = Join-Path $TestDrive 'remediation-allowlist.json'
    @{ checkIds = @('FIXTURE-ALLOW-001') } | ConvertTo-Json -Depth 5 | Set-Content -Path $script:fixtureAllowlist -Encoding UTF8
}

Describe 'Test-RemediationGate (T-0104)' {

    Context 'happy path' {
        It 'plans when every gate passes' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E3' `
                -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $result.Decision | Should -Be 'planned'
            $result.Reason | Should -BeNullOrEmpty
            $result.StatusCode | Should -Be 200
            $result.RegistryKey | Should -Be 'FIXTURE-ALLOW-001'
        }
    }

    Context 'license gate' {
        It 'skips with license-missing when the overlay plan is absent' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E5' `
                -RequiredServicePlans @('AAD_PREMIUM_P2') -TenantServicePlans @() `
                -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $result.Decision | Should -Be 'skipped'
            $result.Reason | Should -Be 'license-missing'
        }

        It 'skips with license-missing for E5 minimum without tenant coverage' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E5' `
                -TenantServicePlans @('E3') -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $result.Decision | Should -Be 'skipped'
            $result.Reason | Should -Be 'license-missing'
        }

        It 'plans when the overlay plan is present' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E5' `
                -RequiredServicePlans @('AAD_PREMIUM_P2') -TenantServicePlans @('AAD_PREMIUM_P2') `
                -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $result.Decision | Should -Be 'planned'
        }
    }

    Context 'service gate' {
        It 'skips with service-unavailable when the backing service is down' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E3' `
                -ServiceAvailable $false -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $result.Decision | Should -Be 'skipped'
            $result.Reason | Should -Be 'service-unavailable'
        }
    }

    Context 'RBAC gate' {
        It 'rejects with 403 when the caller lacks the permission' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller -Permissions @('remediation.read')) `
                -LicenseMinimum 'E3' -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $result.Decision | Should -Be 'rejected'
            $result.StatusCode | Should -Be 403
            $result.Decision | Should -Not -Be 'skipped'
        }

        It 'rejects when no caller context is supplied' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.1' -TenantId 'tenant-a' `
                -LicenseMinimum 'E3' -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $result.Decision | Should -Be 'rejected'
            $result.StatusCode | Should -Be 403
        }
    }

    Context 'tenant scope gate' {
        It 'rejects with 403 when the tenant is outside caller scope' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.1' -TenantId 'tenant-other' `
                -CallerContext (New-TestCaller -TenantIds @('tenant-a')) `
                -LicenseMinimum 'E3' -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $result.Decision | Should -Be 'rejected'
            $result.Reason | Should -Be 'tenant-out-of-scope'
            $result.StatusCode | Should -Be 403
            $result.Decision | Should -Not -Be 'skipped'
        }

        It 'plans for an all-tenants scope' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.1' -TenantId 'tenant-other' `
                -CallerContext (New-TestCaller -AllTenants) `
                -LicenseMinimum 'E3' -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $result.Decision | Should -Be 'planned'
        }
    }

    Context 'read-only gate' {
        It 'skips with tenant-readonly when the flag is set' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E3' `
                -TenantReadOnly $true -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $result.Decision | Should -Be 'skipped'
            $result.Reason | Should -Be 'tenant-readonly'
        }
    }

    Context 'allowlist gate' {
        It 'skips with not-allowlisted for a check off the list' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-DENIED-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E3' `
                -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $result.Decision | Should -Be 'skipped'
            $result.Reason | Should -Be 'not-allowlisted'
        }

        It 'strips the sub-number before testing membership' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.7' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E3' `
                -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $result.RegistryKey | Should -Be 'FIXTURE-ALLOW-001'
            $result.Decision | Should -Be 'planned'
        }

        It 'gives license-missing and not-allowlisted distinct reasons' {
            $license = Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E5' `
                -RequiredServicePlans @('AAD_PREMIUM_P2') -TenantServicePlans @() `
                -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $denied = Test-RemediationGate -CheckId 'FIXTURE-DENIED-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E3' `
                -AllowlistCheckIds @('FIXTURE-ALLOW-001')
            $license.Decision | Should -Be 'skipped'
            $denied.Decision | Should -Be 'skipped'
            $license.Reason | Should -Not -Be $denied.Reason
        }
    }

    Context 'audit record' {
        It 'records every decision including the allowlist result' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-DENIED-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E3' `
                -AllowlistCheckIds @('FIXTURE-ALLOW-001') -Actor 'tester'
            $result.AuditRecord.Decision | Should -Be $result.Decision
            $result.AuditRecord.Reason | Should -Be $result.Reason
            $result.AuditRecord.Allowlisted | Should -BeFalse
            $result.AuditRecord.EvaluatedAt | Should -Not -BeNullOrEmpty
        }
    }

    Context 'allowlist loader' {
        It 'loads membership from the admin-managed file with an audit record' {
            $hit = Get-RemediationAllowlist -CheckId 'FIXTURE-ALLOW-001.1' -AllowlistPath $script:fixtureAllowlist
            $hit.IsAllowlisted | Should -BeTrue
            $hit.AuditRecord.AllowlistHit | Should -BeTrue
            $miss = Get-RemediationAllowlist -CheckId 'FIXTURE-DENIED-001.9' -AllowlistPath $script:fixtureAllowlist
            $miss.IsAllowlisted | Should -BeFalse
            $miss.AuditRecord.AllowlistHit | Should -BeFalse
        }

        It 'is load-only: evaluating never modifies the file' {
            $before = Get-Content -Path $script:fixtureAllowlist -Raw
            Get-RemediationAllowlist -CheckId 'FIXTURE-ALLOW-001' -AllowlistPath $script:fixtureAllowlist | Out-Null
            Test-RemediationGate -CheckId 'FIXTURE-ALLOW-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E3' `
                -AllowlistPath $script:fixtureAllowlist | Out-Null
            $after = Get-Content -Path $script:fixtureAllowlist -Raw
            $after | Should -Be $before
        }

        It 'treats a missing file as an empty allowlist instead of throwing' {
            $missing = Join-Path $TestDrive 'missing/allowlist.json'
            { Get-RemediationAllowlist -CheckId 'FIXTURE-ALLOW-001' -AllowlistPath $missing } | Should -Not -Throw
            (Get-RemediationAllowlist -CheckId 'FIXTURE-ALLOW-001' -AllowlistPath $missing).IsAllowlisted | Should -BeFalse
        }

        It 'gates from the file path when no explicit list is supplied' {
            $result = Test-RemediationGate -CheckId 'FIXTURE-DENIED-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -LicenseMinimum 'E3' `
                -AllowlistPath $script:fixtureAllowlist
            $result.Decision | Should -Be 'skipped'
            $result.Reason | Should -Be 'not-allowlisted'
        }
    }

    Context 'module placement' {
        It 'dot-sources both files from the module loader' {
            $psm1Body = Get-Content -Path $script:psm1 -Raw
            $psm1Body | Should -Match 'Remediate[\\/]Get-RemediationAllowlist\.ps1'
            $psm1Body | Should -Match 'Remediate[\\/]Test-RemediationGate\.ps1'
        }

        It 'exports both functions when the module loads' {
            Import-Module $script:psm1 -Force -ErrorAction Stop
            try {
                $module = Get-Module -Name M365-Assess -ErrorAction Stop
                $module.ExportedFunctions.Keys | Should -Contain 'Get-RemediationAllowlist'
                $module.ExportedFunctions.Keys | Should -Contain 'Test-RemediationGate'
            }
            finally {
                Remove-Module -Name M365-Assess -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
