BeforeDiscovery {
    # Nothing needed at discovery time
}

Describe 'Get-FormsSecurityConfig' {
    BeforeAll {
        # Stub the progress function so Add-Setting's guard passes
        function global:Update-CheckProgress {
            param($CheckId, $Setting, $Status)
        }

        # Stub Get-MgContext so the connection check passes
        function Get-MgContext {
            return @{
                TenantId = 'test-tenant-id'
                AuthType = 'Delegated'
                Account  = 'admin@contoso.com'
            }
        }

        # Mock Invoke-MgGraphRequest with secure Forms settings data
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            switch -Wildcard ($Uri) {
                '*/beta/admin/forms/settings' {
                    return @{
                        isExternalSendFormEnabled            = $false
                        isExternalShareCollaborationEnabled  = $false
                        isExternalShareResultEnabled         = $false
                        isPhishingScanEnabled                = $true
                        isRecordIdentityByDefaultEnabled     = $true
                        isBingImageVideoSearchEnabled        = $false
                    }
                }
                default {
                    return @{ value = @() }
                }
            }
        }

        # Run the collector by dot-sourcing it
        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Collaboration/Get-FormsSecurityConfig.ps1"
    }

    It 'Returns a non-empty settings list' {
        $settings.Count | Should -BeGreaterThan 0
    }

    It 'All settings have required properties' {
        foreach ($s in $settings) {
            $s.PSObject.Properties.Name | Should -Contain 'Category'
            $s.PSObject.Properties.Name | Should -Contain 'Setting'
            $s.PSObject.Properties.Name | Should -Contain 'Status'
            $s.PSObject.Properties.Name | Should -Contain 'CurrentValue'
            $s.PSObject.Properties.Name | Should -Contain 'RecommendedValue'
            $s.PSObject.Properties.Name | Should -Contain 'CheckId'
        }
    }

    It 'All Status values are valid' {
        $validStatuses = @('Pass', 'Fail', 'Warning', 'Review', 'Info', 'N/A')
        foreach ($s in $settings) {
            $s.Status | Should -BeIn $validStatuses `
                -Because "Setting '$($s.Setting)' has status '$($s.Status)'"
        }
    }

    It 'All non-empty CheckIds follow naming convention' {
        $withCheckId = $settings | Where-Object { $_.CheckId -and $_.CheckId.Trim() -ne '' }
        $withCheckId.Count | Should -BeGreaterThan 0
        foreach ($s in $withCheckId) {
            $s.CheckId | Should -Match '^[A-Z]+(-[A-Z0-9]+)+-\d{3}(\.\d+)?$' `
                -Because "CheckId '$($s.CheckId)' should follow convention"
        }
    }

    It 'All CheckIds use the FORMS- prefix' {
        $withCheckId = $settings | Where-Object { $_.CheckId -and $_.CheckId.Trim() -ne '' }
        foreach ($s in $withCheckId) {
            $s.CheckId | Should -Match '^FORMS-' `
                -Because "CheckId '$($s.CheckId)' should use FORMS- prefix"
        }
    }

    It 'External users cannot respond passes when disabled' {
        $check = $settings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-001*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Pass'
    }

    It 'External collaboration passes when disabled' {
        $check = $settings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-002*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Pass'
    }

    It 'External result viewing passes when disabled' {
        $check = $settings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-003*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Pass'
    }

    It 'Phishing protection passes when enabled' {
        $check = $settings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-004*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Pass'
    }

    It 'Record respondent identity passes when enabled' {
        $check = $settings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-005*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Pass'
    }

    It 'Bing search passes when disabled' {
        $check = $settings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-006*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Pass'
    }

    It 'Produces settings across multiple categories' {
        $categories = $settings | Select-Object -ExpandProperty Category -Unique
        $categories.Count | Should -BeGreaterOrEqual 2
    }

    It 'Returns at least 6 checks' {
        $settings.Count | Should -BeGreaterOrEqual 6
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}

Describe 'Get-FormsSecurityConfig - Insecure Settings Fail' {
    BeforeAll {
        function global:Update-CheckProgress {
            param($CheckId, $Setting, $Status)
        }

        function Get-MgContext {
            return @{
                TenantId = 'test-tenant-id'
                AuthType = 'Delegated'
                Account  = 'admin@contoso.com'
            }
        }

        # Return insecure Forms settings
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            switch -Wildcard ($Uri) {
                '*/beta/admin/forms/settings' {
                    return @{
                        isExternalSendFormEnabled            = $true
                        isExternalShareCollaborationEnabled  = $true
                        isExternalShareResultEnabled         = $true
                        isPhishingScanEnabled                = $false
                        isRecordIdentityByDefaultEnabled     = $false
                        isBingImageVideoSearchEnabled        = $true
                    }
                }
                default { return @{ value = @() } }
            }
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Collaboration/Get-FormsSecurityConfig.ps1"
    }

    It 'External users can respond fails when enabled' {
        $check = $settings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-001*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Fail'
    }

    It 'Phishing protection fails when disabled' {
        $check = $settings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-004*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Fail'
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}

Describe 'Get-FormsSecurityConfig - Sovereign Cloud API Gap (#941)' {
    # The /beta/admin/forms/settings endpoint returns BadRequest in GCC High
    # (live run 2026-06-12). Before the fix the collector emitted only a bare
    # Write-Warning and recorded no result, so the check vanished from the report.
    # It should instead emit a Skipped row so the gap is visible in the
    # not-assessed group.
    BeforeAll {
        function global:Update-CheckProgress {
            param($CheckId, $Setting, $Status)
        }

        function global:Get-MgContext {
            return @{
                TenantId    = 'test-tenant-id'
                AuthType    = 'Delegated'
                Account     = 'admin@contoso.onmicrosoft.us'
                Environment = 'USGov'
            }
        }

        Mock Invoke-MgGraphRequest {
            throw 'Response status code does not indicate success: BadRequest (Bad Request).'
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Collaboration/Get-FormsSecurityConfig.ps1"
    }

    It 'emits a Skipped Forms check instead of silently warning' {
        $formsCheck = $settings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-001*' }
        $formsCheck | Should -Not -BeNullOrEmpty
        $formsCheck.Status | Should -Be 'Skipped'
    }

    It 'names the sovereign cloud in the skipped message' {
        $formsCheck = $settings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-001*' }
        $formsCheck.CurrentValue | Should -Match 'USGov|sovereign|not available'
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
        Remove-Item Function:\Get-MgContext -ErrorAction SilentlyContinue
    }
}

Describe 'Get-FormsSecurityConfig - Not Connected' {
    BeforeAll {
        function global:Update-CheckProgress {
            param($CheckId, $Setting, $Status)
        }

        function Get-MgContext {
            return $null
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        $script:collectorOutput = . "$PSScriptRoot/../../src/M365-Assess/Collaboration/Get-FormsSecurityConfig.ps1"
    }

    It 'Returns nothing when not connected' {
        @($script:collectorOutput).Count | Should -Be 0
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}

Describe 'Get-FormsSecurityConfig - current formsSettings property names (T-0932)' {
    # Synthetic fixture shaped like a GET /beta/admin/forms/settings response,
    # using the documented property names. No tenant names, domains, or UPNs.
    BeforeAll {
        function global:Update-CheckProgress {
            param($CheckId, $Setting, $Status)
        }

        function Get-MgContext {
            return @{
                TenantId = 'test-tenant-id'
                AuthType = 'Delegated'
                Account  = 'admin@contoso.com'
            }
        }

        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            switch -Wildcard ($Uri) {
                '*/beta/admin/forms/settings' {
                    return @{
                        isExternalSendFormEnabled            = $false
                        isExternalShareCollaborationEnabled  = $false
                        isExternalShareResultEnabled         = $false
                        isInOrgFormsPhishingScanEnabled      = $true
                        isRecordIdentityByDefaultEnabled     = $true
                        isBingImageSearchEnabled             = $false
                    }
                }
                default { return @{ value = @() } }
            }
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        $script:documentedNameSettings = . "$PSScriptRoot/../../src/M365-Assess/Collaboration/Get-FormsSecurityConfig.ps1"
    }

    It 'FORMS-CONFIG-004 reads isInOrgFormsPhishingScanEnabled and passes when enabled' {
        $check = $script:documentedNameSettings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-004*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Pass'
        $check.CurrentValue | Should -Be 'True'
    }

    It 'FORMS-CONFIG-006 reads isBingImageSearchEnabled and passes when disabled' {
        $check = $script:documentedNameSettings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-006*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Pass'
        $check.CurrentValue | Should -Be 'False'
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}

Describe 'Get-FormsSecurityConfig - preferred property wins when both shapes are present' {
    BeforeAll {
        function global:Update-CheckProgress {
            param($CheckId, $Setting, $Status)
        }

        function Get-MgContext {
            return @{
                TenantId = 'test-tenant-id'
                AuthType = 'Delegated'
                Account  = 'admin@contoso.com'
            }
        }

        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            switch -Wildcard ($Uri) {
                '*/beta/admin/forms/settings' {
                    return @{
                        isExternalSendFormEnabled            = $false
                        isExternalShareCollaborationEnabled  = $false
                        isExternalShareResultEnabled         = $false
                        # Documented names disagree with the legacy fallbacks; the
                        # documented value must be used.
                        isInOrgFormsPhishingScanEnabled      = $false
                        isPhishingScanEnabled                = $true
                        isRecordIdentityByDefaultEnabled     = $true
                        isBingImageSearchEnabled             = $true
                        isBingImageVideoSearchEnabled        = $false
                    }
                }
                default { return @{ value = @() } }
            }
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        $script:bothShapeSettings = . "$PSScriptRoot/../../src/M365-Assess/Collaboration/Get-FormsSecurityConfig.ps1"
    }

    It 'FORMS-CONFIG-004 uses the documented phishing property' {
        $check = $script:bothShapeSettings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-004*' }
        $check.Status | Should -Be 'Fail'
        $check.CurrentValue | Should -Be 'False'
    }

    It 'FORMS-CONFIG-006 uses the documented Bing search property' {
        $check = $script:bothShapeSettings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-006*' }
        $check.Status | Should -Be 'Review'
        $check.CurrentValue | Should -Be 'True'
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}

Describe 'Get-FormsSecurityConfig - absent properties yield Review' {
    BeforeAll {
        function global:Update-CheckProgress {
            param($CheckId, $Setting, $Status)
        }

        function Get-MgContext {
            return @{
                TenantId = 'test-tenant-id'
                AuthType = 'Delegated'
                Account  = 'admin@contoso.com'
            }
        }

        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            switch -Wildcard ($Uri) {
                '*/beta/admin/forms/settings' {
                    return @{
                        isExternalSendFormEnabled            = $false
                        isExternalShareCollaborationEnabled  = $false
                        isExternalShareResultEnabled         = $false
                        isRecordIdentityByDefaultEnabled     = $true
                        # Neither phishing nor Bing search properties returned.
                    }
                }
                default { return @{ value = @() } }
            }
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        $script:missingPropertySettings = . "$PSScriptRoot/../../src/M365-Assess/Collaboration/Get-FormsSecurityConfig.ps1"
    }

    It 'FORMS-CONFIG-004 reports Review, never Fail, when the property is absent' {
        $check = $script:missingPropertySettings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-004*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Review'
        $check.CurrentValue | Should -Match 'Not returned by API'
    }

    It 'FORMS-CONFIG-006 reports Review, never Pass, when the property is absent' {
        $check = $script:missingPropertySettings | Where-Object { $_.CheckId -like 'FORMS-CONFIG-006*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Review'
        $check.CurrentValue | Should -Match 'Not returned by API'
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}
