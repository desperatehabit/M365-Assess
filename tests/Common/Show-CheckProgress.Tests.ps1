BeforeDiscovery {
    # Nothing needed at discovery time
}

Describe 'Initialize-CheckProgress' {
    BeforeAll {
        . "$PSScriptRoot/../../src/M365-Assess/Common/Show-CheckProgress.ps1"
        Mock Write-Host { }
        Mock Write-Progress { }
    }

    Context 'when active sections have automated checks' {
        BeforeAll {
            $registry = @{
                'ENTRA-ADMIN-001' = @{ checkId = 'ENTRA-ADMIN-001'; hasAutomatedCheck = $true; collector = 'Entra' }
                'ENTRA-ADMIN-002' = @{ checkId = 'ENTRA-ADMIN-002'; hasAutomatedCheck = $true; collector = 'Entra' }
                'DNS-SPF-001'     = @{ checkId = 'DNS-SPF-001'; hasAutomatedCheck = $true; collector = 'DNS' }
                'MANUAL-001'      = @{ checkId = 'MANUAL-001'; hasAutomatedCheck = $false; collector = '' }
            }
            Initialize-CheckProgress -ControlRegistry $registry -ActiveSections @('Identity', 'Email')
        }

        It 'should set up global state' {
            $global:CheckProgressState | Should -Not -BeNullOrEmpty
        }

        It 'should count only automated checks in active sections' {
            $global:CheckProgressState.Total | Should -Be 3
        }

        It 'should start with zero completed' {
            $global:CheckProgressState.Completed | Should -Be 0
        }

        It 'should track collector counts' {
            $global:CheckProgressState.CollectorCounts['Entra'] | Should -Be 2
            $global:CheckProgressState.CollectorCounts['DNS'] | Should -Be 1
        }
    }

    Context 'when no sections match any checks' {
        BeforeAll {
            $registry = @{
                'ENTRA-ADMIN-001' = @{ checkId = 'ENTRA-ADMIN-001'; hasAutomatedCheck = $true; collector = 'Entra' }
            }
            Initialize-CheckProgress -ControlRegistry $registry -ActiveSections @('PowerBI')
        }

        It 'should set total to 0' {
            $global:CheckProgressState.Total | Should -Be 0
        }
    }
}

Describe 'Update-CheckProgress' {
    BeforeAll {
        . "$PSScriptRoot/../../src/M365-Assess/Common/Show-CheckProgress.ps1"
        Mock Write-Host { }
        Mock Write-Progress { }

        $registry = @{
            'ENTRA-ADMIN-001' = @{ checkId = 'ENTRA-ADMIN-001'; hasAutomatedCheck = $true; collector = 'Entra' }
            'ENTRA-ADMIN-002' = @{ checkId = 'ENTRA-ADMIN-002'; hasAutomatedCheck = $true; collector = 'Entra' }
        }
        Initialize-CheckProgress -ControlRegistry $registry -ActiveSections @('Identity')
    }

    It 'should increment completed count' {
        Update-CheckProgress -CheckId 'ENTRA-ADMIN-001' -Setting 'Global Admin Count' -Status 'Pass'
        $global:CheckProgressState.Completed | Should -Be 1
    }

    It 'should not double-count the same check' {
        Update-CheckProgress -CheckId 'ENTRA-ADMIN-001' -Setting 'Global Admin Count' -Status 'Pass'
        $global:CheckProgressState.Completed | Should -Be 1
    }

    It 'should handle sub-numbered checks by base CheckId' {
        # ENTRA-ADMIN-002.1 shares the same base as ENTRA-ADMIN-002
        Update-CheckProgress -CheckId 'ENTRA-ADMIN-002.1' -Setting 'Sub check' -Status 'Fail'
        $global:CheckProgressState.Completed | Should -Be 2
        # Second sub-number shouldn't increment
        Update-CheckProgress -CheckId 'ENTRA-ADMIN-002.2' -Setting 'Sub check 2' -Status 'Pass'
        $global:CheckProgressState.Completed | Should -Be 2
    }

    It 'should ignore unknown check IDs' {
        $before = $global:CheckProgressState.Completed
        Update-CheckProgress -CheckId 'UNKNOWN-001' -Setting 'Unknown' -Status 'Pass'
        $global:CheckProgressState.Completed | Should -Be $before
    }
}

Describe 'Complete-CheckProgress' {
    BeforeAll {
        . "$PSScriptRoot/../../src/M365-Assess/Common/Show-CheckProgress.ps1"
        Mock Write-Host { }
        Mock Write-Progress { }

        $registry = @{
            'ENTRA-ADMIN-001' = @{ checkId = 'ENTRA-ADMIN-001'; hasAutomatedCheck = $true; collector = 'Entra' }
        }
        Initialize-CheckProgress -ControlRegistry $registry -ActiveSections @('Identity')
    }

    It 'should clean up global state' {
        Complete-CheckProgress
        $global:CheckProgressState | Should -BeNullOrEmpty
    }
}

Describe 'Critical-exposure collector transition (#968)' {
    # The collector maps accept both the legacy (StrykerReadiness) and renamed
    # (CriticalExposure) ids so a registry sync flips cleanly with no flag-day.
    BeforeAll {
        . "$PSScriptRoot/../../src/M365-Assess/Common/Show-CheckProgress.ps1"
        Mock Write-Host { }
        Mock Write-Progress { }
    }

    It 'should track the legacy StrykerReadiness collector under the Security section' {
        $registry = @{
            'ENTRA-BREAKGLASS-001' = @{ checkId = 'ENTRA-BREAKGLASS-001'; hasAutomatedCheck = $true; collector = 'StrykerReadiness' }
        }
        Initialize-CheckProgress -ControlRegistry $registry -ActiveSections @('Security')
        $global:CheckProgressState.CollectorCounts['StrykerReadiness'] | Should -Be 1
    }

    It 'should track the renamed CriticalExposure collector under the Security section' {
        $registry = @{
            'ENTRA-BREAKGLASS-001' = @{ checkId = 'ENTRA-BREAKGLASS-001'; hasAutomatedCheck = $true; collector = 'CriticalExposure' }
        }
        Initialize-CheckProgress -ControlRegistry $registry -ActiveSections @('Security')
        $global:CheckProgressState.CollectorCounts['CriticalExposure'] | Should -Be 1
    }
}

Describe 'License gating reaches finding status (T-0935)' {
    BeforeAll {
        . "$PSScriptRoot/../../src/M365-Assess/Common/Show-CheckProgress.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Common/SecurityConfigHelper.ps1"

        $global:T0935HostLines = [System.Collections.Generic.List[string]]::new()
        Mock Write-Host {
            param($Object)
            $global:T0935HostLines.Add([string]$Object)
        }
        Mock Write-Progress { }

        $script:gatedRegistry = @{
            'CA-USERRISK-001'   = @{
                checkId           = 'CA-USERRISK-001'
                name              = 'Enable Identity Protection user risk policies'
                hasAutomatedCheck = $true
                collector         = 'CAEvaluator'
                licensing         = @{ requiredServicePlans = @('AAD_PREMIUM_P2') }
            }
            'CA-SIGNINRISK-001' = @{
                checkId           = 'CA-SIGNINRISK-001'
                name              = 'Enable Identity Protection sign-in risk policies'
                hasAutomatedCheck = $true
                collector         = 'CAEvaluator'
                licensing         = @{ requiredServicePlans = @('AAD_PREMIUM_P2') }
            }
            'ENTRA-PIM-001'     = @{
                checkId           = 'ENTRA-PIM-001'
                name              = 'PIM manages privileged roles'
                hasAutomatedCheck = $true
                collector         = 'Entra'
                licensing         = @{ requiredServicePlans = @('AAD_PREMIUM_P2') }
            }
            'CA-MFA-ALL-001'    = @{
                checkId           = 'CA-MFA-ALL-001'
                name              = 'MFA for all users'
                hasAutomatedCheck = $true
                collector         = 'CAEvaluator'
                licensing         = @{ requiredServicePlans = @() }
            }
        }

        $script:gatedCheckParams = @{
            Category         = 'Conditional Access'
            Setting          = 'User Risk Policy Configured'
            CurrentValue     = 'No matching CA policy found'
            RecommendedValue = 'At least 1 policy'
            Status           = 'Fail'
            CheckId          = 'CA-USERRISK-001'
        }
    }

    AfterAll {
        Remove-Variable -Name CheckProgressState -Scope Global -ErrorAction SilentlyContinue
        Remove-Variable -Name T0935HostLines -Scope Global -ErrorAction SilentlyContinue
    }

    Context 'when the tenant lacks AAD_PREMIUM_P2' {
        BeforeAll {
            $plans = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            [void]$plans.Add('AAD_PREMIUM')
            [void]$plans.Add('EXCHANGE_S_STANDARD')
            $initParams = @{
                ControlRegistry = $script:gatedRegistry
                ActiveSections  = @('Identity')
                TenantLicenses  = @{ ActiveServicePlans = $plans }
            }
            Initialize-CheckProgress @initParams
        }

        It 'records every check whose required service plans are unmet as license-skipped' {
            $skipped = $global:CheckProgressState.LicenseSkipped
            $skipped.Keys | Should -Contain 'CA-USERRISK-001'
            $skipped.Keys | Should -Contain 'CA-SIGNINRISK-001'
            $skipped.Keys | Should -Contain 'ENTRA-PIM-001'
            $skipped['ENTRA-PIM-001'].RequiredPlans | Should -Contain 'AAD_PREMIUM_P2'
        }

        It 'excludes not-licensed checks from the progress total' {
            $state = $global:CheckProgressState
            $state.Total | Should -Be 1
            $state.CheckIds.ContainsKey('CA-MFA-ALL-001') | Should -BeTrue
            $state.CheckIds.ContainsKey('CA-USERRISK-001') | Should -BeFalse
        }

        It 'reports the not-licensed count separately from the pass rate' {
            $text = $global:T0935HostLines -join "`n"
            $text | Should -Match '3 checks not licensed'
            $text | Should -Match 'excluded from the pass rate'
        }

        It 'does not count a not-licensed check as completed when a collector emits it' {
            $before = $global:CheckProgressState.Completed
            Update-CheckProgress -CheckId 'CA-USERRISK-001' -Setting 'User Risk Policy Configured' -Status 'NotLicensed'
            $global:CheckProgressState.Completed | Should -Be $before
        }

        It 'records the finding as NotLicensed with a reason naming the missing plan' {
            $ctx = Initialize-SecurityConfig
            $params = $script:gatedCheckParams
            Add-Setting @params
            $finding = $ctx.Settings[0]
            $finding.Status | Should -Be 'NotLicensed'
            $finding.CurrentValue | Should -Match 'Requires AAD_PREMIUM_P2, not licensed'
            $finding.CurrentValue | Should -Match 'No matching CA policy found'
        }

        It 'reports the not-licensed count in the completion summary' {
            Complete-CheckProgress
            ($global:T0935HostLines -join "`n") | Should -Match '3 checks not licensed'
        }
    }

    Context 'when the tenant has the required service plans' {
        BeforeAll {
            $plans = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            [void]$plans.Add('AAD_PREMIUM')
            [void]$plans.Add('AAD_PREMIUM_P2')
            $initParams = @{
                ControlRegistry = $script:gatedRegistry
                ActiveSections  = @('Identity')
                TenantLicenses  = @{ ActiveServicePlans = $plans }
            }
            Initialize-CheckProgress @initParams
        }

        It 'does not record any license-skipped checks' {
            $global:CheckProgressState.LicenseSkipped.Count | Should -Be 0
        }

        It 'keeps every check in the progress total' {
            $global:CheckProgressState.Total | Should -Be 4
        }

        It 'leaves the finding status untouched' {
            $ctx = Initialize-SecurityConfig
            $params = $script:gatedCheckParams
            Add-Setting @params
            $finding = $ctx.Settings[0]
            $finding.Status | Should -Be 'Fail'
            $finding.CurrentValue | Should -Be 'No matching CA policy found'
        }
    }

    Context 'when license data is unavailable' {
        BeforeAll {
            Initialize-CheckProgress -ControlRegistry $script:gatedRegistry -ActiveSections @('Identity')
        }

        It 'disables license gating rather than guessing' {
            $global:CheckProgressState.LicenseSkipped.Count | Should -Be 0
            $global:CheckProgressState.Total | Should -Be 4
        }

        It 'leaves the finding status untouched' {
            $ctx = Initialize-SecurityConfig
            $params = $script:gatedCheckParams
            Add-Setting @params
            $ctx.Settings[0].Status | Should -Be 'Fail'
        }
    }
}
