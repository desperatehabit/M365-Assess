Describe 'Get-DefenderSecureMonConfig - Recent Score' {
    BeforeAll {
        function global:Update-CheckProgress { param($CheckId, $Setting, $Status) }

        Mock Invoke-MgGraphRequest {
            # Score updated today — within 7-day window
            return @{ value = @(
                @{
                    createdDateTime = (Get-Date).ToString('o')
                    currentScore    = 300
                    maxScore        = 500
                }
            ) }
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Security/Get-DefenderSecureMonConfig.ps1"
    }

    It 'Returns a non-empty settings list' {
        $settings.Count | Should -BeGreaterThan 0
    }

    It 'Status is Pass when Secure Score was updated within 7 days' {
        $check = $settings | Where-Object { $_.CheckId -like 'DEFENDER-SECUREMON-001*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Pass'
    }

    It 'CheckId follows naming convention' {
        $check = $settings | Where-Object { $_.CheckId -like 'DEFENDER-SECUREMON-001*' }
        $check.CheckId | Should -Match '^DEFENDER-SECUREMON-001\.\d+$'
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}

Describe 'Get-DefenderSecureMonConfig - Stale Score' {
    BeforeAll {
        function global:Update-CheckProgress { param($CheckId, $Setting, $Status) }

        Mock Invoke-MgGraphRequest {
            # Score last updated 30 days ago
            return @{ value = @(
                @{
                    createdDateTime = (Get-Date).AddDays(-30).ToString('o')
                    currentScore    = 200
                    maxScore        = 500
                }
            ) }
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Security/Get-DefenderSecureMonConfig.ps1"
    }

    It 'Status is Warning when Secure Score exists but was not updated recently' {
        $check = $settings | Where-Object { $_.CheckId -like 'DEFENDER-SECUREMON-001*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Warning'
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}

Describe 'Get-DefenderSecureMonConfig - No Score' {
    BeforeAll {
        function global:Update-CheckProgress { param($CheckId, $Setting, $Status) }

        Mock Invoke-MgGraphRequest {
            return @{ value = @() }
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Security/Get-DefenderSecureMonConfig.ps1"
    }

    It 'Status is Fail when no Secure Score data available' {
        $check = $settings | Where-Object { $_.CheckId -like 'DEFENDER-SECUREMON-001*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Fail'
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}

Describe 'Get-DefenderSecureMonConfig - Defender for Cloud Apps (CIS 2.4.3)' {
    BeforeAll {
        function global:Update-CheckProgress { param($CheckId, $Setting, $Status) }
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        $script:securemonPath = "$PSScriptRoot/../../src/M365-Assess/Security/Get-DefenderSecureMonConfig.ps1"
        function script:Get-CloudAppsRow {
            param([array]$ServicePlans)
            $script:cloudAppsPlans = $ServicePlans
            Mock Invoke-MgGraphRequest { @{ value = @() } }
            Mock Invoke-MgGraphRequest -ParameterFilter { $Uri -like '*subscribedSkus*' } {
                @{ value = @(@{ skuPartNumber = 'SPE_E5'; servicePlans = $script:cloudAppsPlans }) }
            }
            $result = & $script:securemonPath
            $result | Where-Object { $_.Setting -eq 'Microsoft Defender for Cloud Apps Enabled' }
        }
    }

    It 'is Review when Defender for Cloud Apps is licensed and enabled (connector not readable)' {
        $row = Get-CloudAppsRow -ServicePlans @(@{ servicePlanName = 'ADALLOM_S_STANDALONE'; provisioningStatus = 'Success'; appliesTo = 'User' })
        $row | Should -Not -BeNullOrEmpty
        $row.CheckId | Should -Match '^DEFENDER-CLOUDAPPS-001\.\d+$'
        $row.Status | Should -Be 'Review'
    }

    It 'is Warning when only Office 365 Cloud App Security is enabled' {
        $row = Get-CloudAppsRow -ServicePlans @(@{ servicePlanName = 'ADALLOM_S_O365'; provisioningStatus = 'Success'; appliesTo = 'User' })
        $row.Status | Should -Be 'Warning'
    }

    It 'is Fail when the plan is licensed but disabled' {
        $row = Get-CloudAppsRow -ServicePlans @(@{ servicePlanName = 'ADALLOM_S_STANDALONE'; provisioningStatus = 'Disabled'; appliesTo = 'User' })
        $row.Status | Should -Be 'Fail'
    }

    It 'is Fail when no Defender for Cloud Apps plan exists' {
        $row = Get-CloudAppsRow -ServicePlans @(@{ servicePlanName = 'EXCHANGE_S_ENTERPRISE'; provisioningStatus = 'Success'; appliesTo = 'User' })
        $row.Status | Should -Be 'Fail'
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}
