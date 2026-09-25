BeforeAll {
    $script:moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../src/M365-Assess')).Path
    $script:remediateDir = Join-Path $script:moduleRoot 'Remediate'
    $script:psm1 = Join-Path $script:moduleRoot 'M365-Assess.psm1'
    $script:registry = Join-Path $script:moduleRoot 'controls/registry.json'

    . (Join-Path $script:remediateDir 'Resolve-Remediation.ps1')
    . (Join-Path $script:remediateDir 'Get-RemediationAllowlist.ps1')
    . (Join-Path $script:remediateDir 'Test-RemediationGate.ps1')
    . (Join-Path $script:remediateDir 'Get-RemediationCommand.ps1')
    . (Join-Path $script:remediateDir 'Invoke-RemediationAction.ps1')
    . (Join-Path $script:remediateDir 'Test-RemediationCommand.ps1')

    function New-TestCaller {
        param(
            [string[]]$Permissions = @('remediation.apply'),
            [string[]]$TenantIds = @('tenant-a')
        )
        @{
            Permissions = $Permissions
            TenantScope = @{
                All       = $false
                TenantIds = $TenantIds
            }
        }
    }

    $script:fixtureRegistry = Join-Path $TestDrive 'registry.json'
    @{
        schemaVersion = '3.4.0'
        dataVersion   = '2026-01-01'
        checks        = @(
            @{
                checkId     = 'FIXTURE-AUTO-001'
                name        = 'Fixture auto one'
                category    = 'AUTO'
                collector   = 'Test'
                licensing   = @{ minimum = 'E3' }
                remediation = @{ powershell = @{ command = 'Set-Foo -Bar $true' } }
            }
            @{
                checkId     = 'FIXTURE-AUTO-002'
                name        = 'Fixture auto two'
                category    = 'AUTO'
                collector   = 'Test'
                licensing   = @{ minimum = 'E5' }
                remediation = @{ powershell = @{ command = 'Set-Foo -Bar $false' } }
            }
            @{
                checkId     = 'FIXTURE-MAN-001'
                name        = 'Fixture manual'
                category    = 'MAN'
                collector   = 'Test'
                licensing   = @{ minimum = 'E3' }
                remediation = @{ portal = @{ path = 'Portal > Beta'; steps = @('Portal', 'Beta') } }
            }
        )
    } | ConvertTo-Json -Depth 10 | Set-Content -Path $script:fixtureRegistry -Encoding UTF8

    $script:fixtureMatrix = Join-Path $TestDrive 'remediation-matrix.csv'
    @(
        [PSCustomObject]@{ checkId = 'FIXTURE-APPROVED-001'; name = 'Approved'; remediationMode = 'auto-candidate'; specStatus = 'approved'; ticket = '' }
        [PSCustomObject]@{ checkId = 'FIXTURE-DRAFTED-001'; name = 'Drafted'; remediationMode = 'auto-candidate'; specStatus = 'drafted'; ticket = '' }
        [PSCustomObject]@{ checkId = 'FIXTURE-FRESH-001'; name = 'Fresh'; remediationMode = 'auto-candidate'; specStatus = 'not-started'; ticket = '' }
    ) | Export-Csv -Path $script:fixtureMatrix -NoTypeInformation -Encoding UTF8

    $script:fixtureAutoDir = Join-Path $TestDrive 'auto'
}

Describe 'Get-RemediationAutoCandidates (T-0110)' {

    Context 'registry enumeration' {
        It 'returns the 62 auto-candidates from the module registry' {
            $candidates = Get-RemediationAutoCandidates -RegistryPath $script:registry
            $candidates.Count | Should -Be 62
        }

        It 'includes command checks and excludes manual checks' {
            $candidates = Get-RemediationAutoCandidates -RegistryPath $script:registry
            $candidates | Should -Contain 'COMPLIANCE-AUDIT-001'
            $candidates | Should -Not -Contain 'CA-REPORTONLY-001'
        }

        It 'filters a fixture registry to checks with a powershell command' {
            $candidates = Get-RemediationAutoCandidates -RegistryPath $script:fixtureRegistry
            $candidates | Should -Be @('FIXTURE-AUTO-001', 'FIXTURE-AUTO-002')
        }

        It 'returns empty when the registry file is absent' {
            $missing = Join-Path $TestDrive 'missing/registry.json'
            @(Get-RemediationAutoCandidates -RegistryPath $missing).Count | Should -Be 0
        }
    }
}

Describe 'Test-RemediationCommand (T-0110)' {

    Context 'validated run' {
        It 'runs the typed executor twice and reports run/idempotent/before-after/gates' {
            $store = @{ SharingCapability = 'ExternalUserSharingOnly' }
            $get = { $store.SharingCapability }.GetNewClosure()
            $apply = { $store.SharingCapability = 'ExistingExternalUserSharingOnly'; $store.SharingCapability }.GetNewClosure()
            $result = Test-RemediationCommand -CheckId 'SPO-SHARING-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('SPO-SHARING-001') `
                -GetState $get -ApplyChange $apply
            $result.RegistryKey | Should -Be 'SPO-SHARING-001'
            $result.CommandName | Should -Be 'Set-SpoSharingCapability'
            $result.CommandRuns | Should -BeTrue
            $result.IsIdempotent | Should -BeTrue
            $result.BeforeAfterCaptured | Should -BeTrue
            $result.GatesExpressible | Should -BeTrue
            $result.Validated | Should -BeTrue
            $result.SpecStatus | Should -Be 'approved'
            $result.Reason | Should -BeNullOrEmpty
            $result.FirstRun.Before | Should -Be 'ExternalUserSharingOnly'
            $result.FirstRun.After | Should -Be 'ExistingExternalUserSharingOnly'
            $result.SecondRun.Before | Should -Be $result.FirstRun.After
            $result.SecondRun.After | Should -Be $result.FirstRun.After
            $result.ValidatedAt | Should -Not -BeNullOrEmpty
        }
    }

    Context 'non-idempotent apply' {
        It 'fails validation with not-idempotent and drafted status' {
            $counter = @{ Value = 0 }
            $get = { "after-$($counter.Value)" }.GetNewClosure()
            $apply = { $counter.Value++; "after-$($counter.Value)" }.GetNewClosure()
            $result = Test-RemediationCommand -CheckId 'SPO-SHARING-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('SPO-SHARING-001') `
                -GetState $get -ApplyChange $apply
            $result.CommandRuns | Should -BeTrue
            $result.IsIdempotent | Should -BeFalse
            $result.Validated | Should -BeFalse
            $result.SpecStatus | Should -Be 'drafted'
            $result.Reason | Should -Be 'not-idempotent'
        }
    }

    Context 'unvalidated commands' {
        It 'refuses an automated check with no typed binding without executing anything' {
            $invoked = @{ Value = $false }
            $get = { 'current' }.GetNewClosure()
            $apply = { $invoked.Value = $true; 'mutated' }.GetNewClosure()
            $result = Test-RemediationCommand -CheckId 'COMPLIANCE-AUDIT-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('COMPLIANCE-AUDIT-001') `
                -GetState $get -ApplyChange $apply
            $result.CommandRuns | Should -BeFalse
            $result.Validated | Should -BeFalse
            $result.SpecStatus | Should -Be 'not-started'
            $result.Reason | Should -Be 'not-implemented'
            $invoked.Value | Should -BeFalse
        }

        It 'reports not-automated for a manual check without executing anything' {
            $invoked = @{ Value = $false }
            $get = { 'current' }.GetNewClosure()
            $apply = { $invoked.Value = $true; 'mutated' }.GetNewClosure()
            $result = Test-RemediationCommand -CheckId 'CA-REPORTONLY-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('CA-REPORTONLY-001') `
                -GetState $get -ApplyChange $apply
            $result.Validated | Should -BeFalse
            $result.SpecStatus | Should -Be 'not-started'
            $result.Reason | Should -Be 'not-automated'
            $invoked.Value | Should -BeFalse
        }
    }

    Context 'blocked gates' {
        It 'records the gate reason when gates stop the runs' {
            $store = @{ SharingCapability = 'ExternalUserSharingOnly' }
            $get = { $store.SharingCapability }.GetNewClosure()
            $apply = { $store.SharingCapability = 'ExistingExternalUserSharingOnly'; $store.SharingCapability }.GetNewClosure()
            $result = Test-RemediationCommand -CheckId 'SPO-SHARING-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller -Permissions @('remediation.read')) `
                -AllowlistCheckIds @('SPO-SHARING-001') -GetState $get -ApplyChange $apply
            $result.CommandRuns | Should -BeFalse
            $result.Validated | Should -BeFalse
            $result.SpecStatus | Should -Be 'not-started'
            $result.Reason | Should -Be 'rbac-denied'
            $result.GatesExpressible | Should -BeTrue
            $store.SharingCapability | Should -Be 'ExternalUserSharingOnly'
        }
    }
}

Describe 'Test-RemediationApplyEligibility (T-0110)' {

    Context 'apply hard gate' {
        It 'treats an approved check as eligible' {
            $result = Test-RemediationApplyEligibility -CheckId 'FIXTURE-APPROVED-001' -MatrixPath $script:fixtureMatrix
            $result.RegistryKey | Should -Be 'FIXTURE-APPROVED-001'
            $result.SpecStatus | Should -Be 'approved'
            $result.Eligible | Should -BeTrue
            $result.Reason | Should -Be 'approved'
        }

        It 'treats an unvalidated check as ineligible so it is never applied' {
            $result = Test-RemediationApplyEligibility -CheckId 'FIXTURE-FRESH-001.2' -MatrixPath $script:fixtureMatrix
            $result.RegistryKey | Should -Be 'FIXTURE-FRESH-001'
            $result.SpecStatus | Should -Be 'not-started'
            $result.Eligible | Should -BeFalse
            $result.Reason | Should -Be 'not-validated'
        }

        It 'treats a drafted check as ineligible' {
            $result = Test-RemediationApplyEligibility -CheckId 'FIXTURE-DRAFTED-001' -MatrixPath $script:fixtureMatrix
            $result.Eligible | Should -BeFalse
            $result.Reason | Should -Be 'not-validated'
        }

        It 'treats a check absent from the matrix as ineligible' {
            $result = Test-RemediationApplyEligibility -CheckId 'NOPE-UNKNOWN-999.1' -MatrixPath $script:fixtureMatrix
            $result.SpecStatus | Should -Be 'not-started'
            $result.Eligible | Should -BeFalse
            $result.Reason | Should -Be 'not-validated'
        }
    }
}

Describe 'Set-RemediationValidationStatus (T-0110)' {

    Context 'merge-preserving matrix edits' {
        It 'updates specStatus for the matched check only' {
            $matrix = Join-Path $TestDrive 'status-matrix.csv'
            Copy-Item -Path $script:fixtureMatrix -Destination $matrix -Force
            $updated = Set-RemediationValidationStatus -CheckId 'FIXTURE-FRESH-001.4' -SpecStatus 'drafted' -MatrixPath $matrix
            $updated.specStatus | Should -Be 'drafted'
            $rows = Import-Csv -Path $matrix
            $rows.Count | Should -Be 3
            ($rows | Where-Object { $_.checkId -eq 'FIXTURE-APPROVED-001' }).specStatus | Should -Be 'approved'
            ($rows | Where-Object { $_.checkId -eq 'FIXTURE-DRAFTED-001' }).specStatus | Should -Be 'drafted'
            ($rows | Where-Object { $_.checkId -eq 'FIXTURE-FRESH-001' }).name | Should -Be 'Fresh'
        }

        It 'records the ticket when supplied' {
            $matrix = Join-Path $TestDrive 'ticket-matrix.csv'
            Copy-Item -Path $script:fixtureMatrix -Destination $matrix -Force
            $updated = Set-RemediationValidationStatus -CheckId 'FIXTURE-FRESH-001' -SpecStatus 'approved' -Ticket 'T-0110' -MatrixPath $matrix
            $updated.ticket | Should -Be 'T-0110'
        }

        It 'throws for a checkId absent from the matrix' {
            { Set-RemediationValidationStatus -CheckId 'NOPE-UNKNOWN-999' -SpecStatus 'approved' -MatrixPath $script:fixtureMatrix } | Should -Throw
        }

        It 'promotes a check to eligible in the apply gate' {
            $matrix = Join-Path $TestDrive 'promote-matrix.csv'
            Copy-Item -Path $script:fixtureMatrix -Destination $matrix -Force
            Set-RemediationValidationStatus -CheckId 'FIXTURE-FRESH-001' -SpecStatus 'approved' -MatrixPath $matrix | Out-Null
            $eligibility = Test-RemediationApplyEligibility -CheckId 'FIXTURE-FRESH-001.1' -MatrixPath $matrix
            $eligibility.Eligible | Should -BeTrue
            $eligibility.Reason | Should -Be 'approved'
        }
    }
}

Describe 'New-RemediationValidationDoc (T-0110)' {

    Context 'auto doc authoring' {
        It 'authors a numbered auto doc recording the validation result' {
            $store = @{ SharingCapability = 'ExternalUserSharingOnly' }
            $get = { $store.SharingCapability }.GetNewClosure()
            $apply = { $store.SharingCapability = 'ExistingExternalUserSharingOnly'; $store.SharingCapability }.GetNewClosure()
            $record = Test-RemediationCommand -CheckId 'SPO-SHARING-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('SPO-SHARING-001') `
                -GetState $get -ApplyChange $apply
            $doc = New-RemediationValidationDoc -CheckId 'SPO-SHARING-001' -ValidationRecord $record `
                -AutoDir $script:fixtureAutoDir -RegistryPath $script:registry
            $doc.Created | Should -BeTrue
            $doc.Path | Should -Match '001-SPO-SHARING-001\.md$'
            $body = Get-Content -Path $doc.Path -Raw
            $body | Should -Match 'Set-SPOTenant -SharingCapability ExistingExternalUserSharingOnly'
            $body | Should -Match '## Validation result'
        }

        It 'reuses the existing number instead of clobbering human edits' {
            $first = New-RemediationValidationDoc -CheckId 'SPO-SHARING-001' -AutoDir $script:fixtureAutoDir -RegistryPath $script:registry
            $marker = '<!-- human edit -->'
            Add-Content -Path $first.Path -Value $marker -Encoding UTF8
            $second = New-RemediationValidationDoc -CheckId 'SPO-SHARING-001' -AutoDir $script:fixtureAutoDir -RegistryPath $script:registry
            $second.Created | Should -BeFalse
            $second.Path | Should -Be $first.Path
            Get-Content -Path $second.Path -Raw | Should -Match '<!-- human edit -->'
        }

        It 'throws for a checkId absent from the registry' {
            { New-RemediationValidationDoc -CheckId 'NOPE-UNKNOWN-999' -AutoDir $script:fixtureAutoDir -RegistryPath $script:registry } | Should -Throw
        }
    }
}

Describe 'Test-RemediationCommand module placement (T-0110)' {

    Context 'module placement' {
        It 'dot-sources the harness from the module loader' {
            $psm1Body = Get-Content -Path $script:psm1 -Raw
            $psm1Body | Should -Match 'Remediate[\\/]Test-RemediationCommand\.ps1'
        }

        It 'exports the harness functions when the module loads' {
            Import-Module $script:psm1 -Force -ErrorAction Stop
            try {
                $module = Get-Module -Name M365-Assess -ErrorAction Stop
                $module.ExportedFunctions.Keys | Should -Contain 'Test-RemediationCommand'
                $module.ExportedFunctions.Keys | Should -Contain 'Get-RemediationAutoCandidates'
                $module.ExportedFunctions.Keys | Should -Contain 'Test-RemediationApplyEligibility'
                $module.ExportedFunctions.Keys | Should -Contain 'Set-RemediationValidationStatus'
                $module.ExportedFunctions.Keys | Should -Contain 'New-RemediationValidationDoc'
            }
            finally {
                Remove-Module -Name M365-Assess -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
