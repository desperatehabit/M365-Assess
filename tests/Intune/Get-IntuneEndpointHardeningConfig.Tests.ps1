BeforeAll {
    $script:collector = "$PSScriptRoot/../../src/M365-Assess/Intune/Get-IntuneEndpointHardeningConfig.ps1"

    # Settings catalog instances as Graph returns them (choice values carry the setting id).
    function script:New-ChoiceSetting {
        param([string]$DefinitionId, [string]$Value)
        @{ settingInstance = @{
            '@odata.type'       = '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance'
            settingDefinitionId = $DefinitionId
            choiceSettingValue  = @{ value = $Value; children = @() }
        } }
    }

    function script:New-FirewallSettings {
        param([string[]]$Profiles)
        foreach ($fwProfile in $Profiles) {
            New-ChoiceSetting -DefinitionId "vendor_msft_firewall_mdmstore_$($fwProfile)profile_enablefirewall" -Value "vendor_msft_firewall_mdmstore_$($fwProfile)profile_enablefirewall_true"
            New-ChoiceSetting -DefinitionId "vendor_msft_firewall_mdmstore_$($fwProfile)profile_defaultinboundaction" -Value "vendor_msft_firewall_mdmstore_$($fwProfile)profile_defaultinboundaction_1"
        }
    }

    # Scenario data the Graph mock serves; each Describe sets it before running the collector.
    $script:graph = [ordered]@{}
    function script:Invoke-Collector {
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $ErrorAction)
            if ($script:graph.Contains('Throw')) { throw $script:graph['Throw'] }
            foreach ($key in $script:graph.Keys) {
                if ($Uri -like $key) { return @{ value = @($script:graph[$key]) } }
            }
            return @{ value = @() }
        }
        & $script:collector
    }
}

Describe 'Get-IntuneEndpointHardeningConfig - hardened tenant' {
    BeforeAll {
        function global:Update-CheckProgress { param($CheckId, $Setting, $Status) }
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        $script:graph = [ordered]@{
            '*/deviceCompliancePolicies*' = @(
                @{ '@odata.type' = '#microsoft.graph.windows10CompliancePolicy'; displayName = 'Windows baseline'; bitLockerEnabled = $true; assignments = @(@{ id = 'a1' }) }
            )
            '*/configurationPolicies/fw-1/settings*'    = @(New-FirewallSettings -Profiles 'domain', 'private', 'public')
            '*/configurationPolicies/ps-1/settings*'    = @(New-ChoiceSetting -DefinitionId 'device_vendor_msft_policy_config_admx_powershellexecutionpolicy_enablescripts_executionpolicy' -Value 'device_vendor_msft_policy_config_admx_powershellexecutionpolicy_enablescripts_executionpolicy_allsigned')
            '*/configurationPolicies/*/assignments*'    = @(@{ id = 'assign-1' })
            '*/configurationPolicies[?]*'               = @(
                @{ id = 'fw-1'; name = 'Firewall baseline'; platforms = 'windows10'; templateReference = @{ templateFamily = 'endpointSecurityFirewall' } }
                @{ id = 'ps-1'; name = 'PowerShell signed only'; platforms = 'windows10'; templateReference = @{ templateFamily = 'none' } }
            )
        }
        $script:result = Invoke-Collector
    }

    It 'passes device encryption (INTUNE-ENCRYPTION-001)' {
        $row = $script:result | Where-Object { $_.Setting -eq 'Device Encryption Required (Assigned)' }
        $row.CheckId | Should -Match '^INTUNE-ENCRYPTION-001\.\d+$'
        $row.Status | Should -Be 'Pass'
    }

    It 'passes PowerShell execution policy (INTUNE-MOBILECODE-001)' {
        $row = $script:result | Where-Object { $_.Setting -eq 'PowerShell Script Execution Restricted (Assigned)' }
        $row.CheckId | Should -Match '^INTUNE-MOBILECODE-001\.\d+$'
        $row.Status | Should -Be 'Pass'
        $row.CurrentValue | Should -Match 'PowerShell signed only'
    }

    It 'passes the host firewall check on all three profiles (INTUNE-FIREWALL-001)' {
        $row = $script:result | Where-Object { $_.Setting -eq 'Windows Firewall Enabled with Default Inbound Block (Assigned)' }
        $row.CheckId | Should -Match '^INTUNE-FIREWALL-001\.\d+$'
        $row.Status | Should -Be 'Pass'
    }

    AfterAll { Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue }
}

Describe 'Get-IntuneEndpointHardeningConfig - firewall missing the public profile' {
    BeforeAll {
        function global:Update-CheckProgress { param($CheckId, $Setting, $Status) }
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        $script:graph = [ordered]@{
            '*/configurationPolicies/fw-1/settings*' = @(New-FirewallSettings -Profiles 'domain', 'private')
            '*/configurationPolicies/*/assignments*' = @(@{ id = 'assign-1' })
            '*/configurationPolicies[?]*'            = @(
                @{ id = 'fw-1'; name = 'Firewall baseline'; platforms = 'windows10'; templateReference = @{ templateFamily = 'endpointSecurityFirewall' } }
            )
        }
        $script:result = Invoke-Collector
    }

    It 'warns and names the uncovered profile' {
        $row = $script:result | Where-Object { $_.Setting -eq 'Windows Firewall Enabled with Default Inbound Block (Assigned)' }
        $row.Status | Should -Be 'Warning'
        $row.CurrentValue | Should -Match 'public'
    }

    AfterAll { Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue }
}

Describe 'Get-IntuneEndpointHardeningConfig - nothing configured' {
    BeforeAll {
        function global:Update-CheckProgress { param($CheckId, $Setting, $Status) }
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        $script:graph = [ordered]@{
            '*/deviceCompliancePolicies*' = @(
                @{ '@odata.type' = '#microsoft.graph.windows10CompliancePolicy'; displayName = 'Unassigned'; bitLockerEnabled = $true; assignments = @() }
            )
        }
        $script:result = Invoke-Collector
    }

    It 'fails all three checks' {
        foreach ($id in 'INTUNE-ENCRYPTION-001', 'INTUNE-MOBILECODE-001', 'INTUNE-FIREWALL-001') {
            $row = $script:result | Where-Object { $_.CheckId -like "$id*" }
            $row | Should -Not -BeNullOrEmpty -Because "$id should be emitted"
            $row.Status | Should -Be 'Fail' -Because "$id has no assigned policy"
        }
    }

    AfterAll { Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue }
}

Describe 'Get-IntuneEndpointHardeningConfig - insufficient permissions' {
    BeforeAll {
        function global:Update-CheckProgress { param($CheckId, $Setting, $Status) }
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        $script:graph = [ordered]@{ Throw = 'Response status code does not indicate success: 403 (Forbidden).' }
        $script:result = Invoke-Collector
    }

    It 'reports Review for every check instead of throwing' {
        @($script:result).Count | Should -Be 3
        foreach ($row in $script:result) {
            $row.Status | Should -Be 'Review'
            $row.CurrentValue | Should -Match 'Insufficient permissions'
        }
    }

    AfterAll { Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue }
}
