BeforeAll {
    $script:moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../src/M365-Assess')).Path
    $script:resolver   = Join-Path $script:moduleRoot 'Remediate/Resolve-Remediation.ps1'
    $script:psm1       = Join-Path $script:moduleRoot 'M365-Assess.psm1'
    $script:registry   = Join-Path $script:moduleRoot 'controls/registry.json'

    . $script:resolver

    $script:fixtureDir = Join-Path $TestDrive 'controls'
    New-Item -ItemType Directory -Path $script:fixtureDir -Force | Out-Null
    $script:fixtureRegistry = Join-Path $script:fixtureDir 'registry.json'

    @{
        schemaVersion = '2.0.0'
        dataVersion   = '2026-01-01'
        checks        = @(
            @{
                checkId     = 'TEST-AUTO-001'
                name        = 'Automated fixture check'
                category    = 'AUTO'
                collector   = 'Test'
                licensing   = @{ minimum = 'E5' }
                remediation = @{
                    powershell = @{ command = 'Set-Foo -Bar $true' }
                    portal     = @{ path = 'Portal > Alpha'; steps = @('Portal', 'Alpha') }
                    notes      = 'auto note'
                }
            }
            @{
                checkId     = 'TEST-MAN-001'
                name        = 'Manual fixture check'
                category    = 'MAN'
                collector   = 'Test'
                licensing   = @{ minimum = 'E3' }
                remediation = @{
                    portal = @{ path = 'Portal > Beta'; steps = @('Portal', 'Beta') }
                }
            }
            @{
                checkId     = 'TEST-UND-001'
                name        = 'Undetermined fixture check'
                category    = 'UND'
                collector   = 'Test'
                licensing   = @{ minimum = 'E3' }
                remediation = @{ notes = 'triage me' }
            }
        )
    } | ConvertTo-Json -Depth 10 | Set-Content -Path $script:fixtureRegistry -Encoding UTF8
}

Describe 'Resolve-Remediation (T-0102)' {

    Context 'sub-number stripping' {
        It 'strips the sub-number suffix to key the registry' {
            $result = Resolve-Remediation -CheckId 'CA-REPORTONLY-001.1'
            $result.RegistryKey | Should -Be 'CA-REPORTONLY-001'
            $result.CheckId     | Should -Be 'CA-REPORTONLY-001.1'
        }

        It 'resolves a sub-numbered id the same as its base id' {
            $sub  = Resolve-Remediation -CheckId 'CA-REPORTONLY-001.1'
            $base = Resolve-Remediation -CheckId 'CA-REPORTONLY-001'
            $sub.RegistryKey | Should -Be $base.RegistryKey
            $sub.Mode        | Should -Be $base.Mode
        }

        It 'fails without the strip - the registry has no sub-numbered key' {
            $raw = Get-Content -Path $script:registry -Raw | ConvertFrom-Json
            $raw.checks.checkId | Should -Not -Contain 'CA-REPORTONLY-001.1'
        }

        It 'strips multi-digit sub-numbers' {
            $result = Resolve-Remediation -CheckId 'CA-REPORTONLY-001.10' -RegistryPath $script:fixtureRegistry
            $result.RegistryKey | Should -Be 'CA-REPORTONLY-001'
        }
    }

    Context 'classification per SPEC 4.1 step 4' {
        It 'classifies a powershell command as automated' {
            $result = Resolve-Remediation -CheckId 'ENTRA-SECDEFAULT-001.1'
            $result.Mode    | Should -Be 'automated'
            $result.Command | Should -Not -BeNullOrEmpty
        }

        It 'classifies a portal-only check as manual' {
            $result = Resolve-Remediation -CheckId 'CA-REPORTONLY-001.1'
            $result.Mode        | Should -Be 'manual'
            $result.PortalPath  | Should -Not -BeNullOrEmpty
            $result.PortalSteps | Should -Not -BeNullOrEmpty
        }

        It 'classifies a check with neither signal as undetermined' {
            $result = Resolve-Remediation -CheckId 'DEFENDER-SECUREMON-001.1'
            $result.Mode       | Should -Be 'undetermined'
            $result.Command    | Should -BeNullOrEmpty
            $result.PortalPath | Should -BeNullOrEmpty
            $result.PortalSteps.Count | Should -Be 0
        }

        It 'returns automated/manual/undetermined from a fixture registry' {
            (Resolve-Remediation -CheckId 'TEST-AUTO-001.2' -RegistryPath $script:fixtureRegistry).Mode | Should -Be 'automated'
            (Resolve-Remediation -CheckId 'TEST-MAN-001.2'  -RegistryPath $script:fixtureRegistry).Mode | Should -Be 'manual'
            (Resolve-Remediation -CheckId 'TEST-UND-001.2'  -RegistryPath $script:fixtureRegistry).Mode | Should -Be 'undetermined'
        }
    }

    Context 'returned fields for plan generation and gating' {
        It 'returns the command, portal path/steps, notes, and licensing minimum' {
            $auto = Resolve-Remediation -CheckId 'TEST-AUTO-001.2' -RegistryPath $script:fixtureRegistry
            $auto.Command        | Should -Be 'Set-Foo -Bar $true'
            $auto.PortalPath     | Should -Be 'Portal > Alpha'
            $auto.PortalSteps    | Should -Be @('Portal', 'Alpha')
            $auto.Notes          | Should -Be 'auto note'
            $auto.LicenseMinimum | Should -Be 'E5'
        }

        It 'returns portal steps as an array for a manual check' {
            $manual = Resolve-Remediation -CheckId 'TEST-MAN-001.2' -RegistryPath $script:fixtureRegistry
            $manual.Command        | Should -BeNullOrEmpty
            $manual.PortalPath     | Should -Be 'Portal > Beta'
            @($manual.PortalSteps).Count | Should -Be 2
            $manual.LicenseMinimum | Should -Be 'E3'
        }

        It 'returns notes even when the mode is undetermined' {
            $und = Resolve-Remediation -CheckId 'TEST-UND-001.2' -RegistryPath $script:fixtureRegistry
            $und.Notes          | Should -Be 'triage me'
            $und.LicenseMinimum | Should -Be 'E3'
        }
    }

    Context 'unknown or unmatched ids' {
        It 'resolves an unknown id to undetermined instead of throwing' {
            $result = Resolve-Remediation -CheckId 'DOES-NOT-EXIST-999.1'
            $result.Mode        | Should -Be 'undetermined'
            $result.RegistryKey | Should -Be 'DOES-NOT-EXIST-999'
        }

        It 'resolves an unknown id against a fixture registry to undetermined' {
            { Resolve-Remediation -CheckId 'NOPE-999.1' -RegistryPath $script:fixtureRegistry } | Should -Not -Throw
            (Resolve-Remediation -CheckId 'NOPE-999.1' -RegistryPath $script:fixtureRegistry).Mode | Should -Be 'undetermined'
        }

        It 'resolves to undetermined when the registry file is absent' {
            $missing = Join-Path $TestDrive 'missing/registry.json'
            (Resolve-Remediation -CheckId 'CA-REPORTONLY-001.1' -RegistryPath $missing).Mode | Should -Be 'undetermined'
        }
    }

    Context 'module placement' {
        It 'is dot-sourced by the module loader' {
            $psm1Body = Get-Content -Path $script:psm1 -Raw
            $psm1Body | Should -Match 'Remediate[\\/]Resolve-Remediation\.ps1'
        }

        It 'is exported when the module loads' {
            Import-Module $script:psm1 -Force -ErrorAction Stop
            try {
                $module = Get-Module -Name M365-Assess -ErrorAction Stop
                $module.ExportedFunctions.Keys | Should -Contain 'Resolve-Remediation'
            }
            finally {
                Remove-Module -Name M365-Assess -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
