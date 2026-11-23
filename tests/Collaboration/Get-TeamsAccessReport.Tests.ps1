BeforeDiscovery {
    # Nothing needed at discovery time
}

Describe 'Get-TeamsAccessReport' {
    BeforeAll {
        function global:Assert-GraphConnection { return $true }
        function global:Write-AssessmentLog { param($Message, $Level) }

        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            switch -Wildcard ($Uri) {
                '*/beta/teamwork/teamsAppSettings' {
                    return @{
                        isChatResourceSpecificConsentEnabled            = $true
                        isUserPersonalScopeResourceSpecificConsentEnabled = $false
                    }
                }
                '*/v1.0/groupSettings' {
                    return @{
                        value = @(
                            @{
                                displayName = 'Group.Unified.Guest'
                                values      = @(
                                    @{ name = 'AllowGuestsToAccessGroups'; value = 'true' }
                                )
                            }
                        )
                    }
                }
                '*/beta/teamwork' {
                    return @{
                        isGuestAccessEnabled         = $true
                        allowGuestCreateUpdateChannels = $false
                        allowThirdPartyApps          = $true
                    }
                }
                default { return @{ value = @() } }
            }
        }

        $script:result = & "$PSScriptRoot/../../src/M365-Assess/Collaboration/Get-TeamsAccessReport.ps1"
    }

    It 'returns a non-empty result' {
        $script:result | Should -Not -BeNullOrEmpty
    }

    It 'result has AllowGuestAccess property' {
        $script:result.PSObject.Properties.Name | Should -Contain 'AllowGuestAccess'
    }

    It 'AllowGuestAccess is populated (not null)' {
        $script:result.AllowGuestAccess | Should -Not -BeNullOrEmpty
    }

    It 'result has AllowSideLoading property' {
        $script:result.PSObject.Properties.Name | Should -Contain 'AllowSideLoading'
    }

    It 'result has AllowThirdPartyApps property' {
        $script:result.PSObject.Properties.Name | Should -Contain 'AllowThirdPartyApps'
    }

    It 'result has IsUserPersonalScopeResourceSpecificConsentEnabled property' {
        $script:result.PSObject.Properties.Name | Should -Contain 'IsUserPersonalScopeResourceSpecificConsentEnabled'
    }

    It 'result has AllowGuestCreateUpdateChannels property' {
        $script:result.PSObject.Properties.Name | Should -Contain 'AllowGuestCreateUpdateChannels'
    }

    AfterAll {
        Remove-Item Function:\Assert-GraphConnection -ErrorAction SilentlyContinue
        Remove-Item Function:\Write-AssessmentLog -ErrorAction SilentlyContinue
    }
}

Describe 'Get-TeamsAccessReport - app-only auth reports Skipped (T-0937)' {
    BeforeAll {
        function global:Assert-GraphConnection { return $true }
        function global:Write-AssessmentLog { param($Message, $Level) }
        function global:Get-MgContext {
            return @{ TenantId = 'test-tenant-id'; AuthType = 'AppOnly'; AppName = 'TestApp' }
        }

        Mock Invoke-MgGraphRequest { throw 'Teams Graph APIs do not support app-only auth' }

        $script:appOnlyOutput = @(& "$PSScriptRoot/../../src/M365-Assess/Collaboration/Get-TeamsAccessReport.ps1")
    }

    It 'does not return an all-N/A report row' {
        @($script:appOnlyOutput | Where-Object { $_.PSObject.Properties.Name -contains 'AllowGuestAccess' }).Count |
            Should -Be 0
    }

    It 'reports the collector outcome as Skipped with the app-only reason' {
        $outcome = @($script:appOnlyOutput | Where-Object {
            $_.PSObject.TypeNames -contains 'M365Assess.CollectorOutcome'
        })
        $outcome.Count | Should -Be 1
        $outcome[0].Outcome | Should -Be 'Skipped'
        $outcome[0].Reason | Should -Match 'app-only not supported'
    }

    AfterAll {
        Remove-Item Function:\Assert-GraphConnection -ErrorAction SilentlyContinue
        Remove-Item Function:\Write-AssessmentLog -ErrorAction SilentlyContinue
        Remove-Item Function:\Get-MgContext -ErrorAction SilentlyContinue
    }
}

Describe 'Get-TeamsAccessReport - beta endpoint unavailable' {
    BeforeAll {
        function global:Assert-GraphConnection { return $true }
        function global:Write-AssessmentLog { param($Message, $Level) }

        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            switch -Wildcard ($Uri) {
                '*/beta/teamwork/teamsAppSettings' {
                    throw [System.Exception]::new('503 Service Unavailable')
                }
                '*/v1.0/groupSettings' {
                    return @{ value = @() }
                }
                '*/beta/teamwork' {
                    throw [System.Exception]::new('503 Service Unavailable')
                }
                default { return @{ value = @() } }
            }
        }

        $script:resultDegraded = & "$PSScriptRoot/../../src/M365-Assess/Collaboration/Get-TeamsAccessReport.ps1" -WarningAction SilentlyContinue
    }

    It 'returns a result even when optional endpoints fail' {
        $script:resultDegraded | Should -Not -BeNullOrEmpty
    }

    It 'AllowSideLoading falls back to N/A when beta endpoint unavailable' {
        $script:resultDegraded.AllowSideLoading | Should -Be 'N/A'
    }

    It 'does not throw when optional endpoints fail' {
        { & "$PSScriptRoot/../../src/M365-Assess/Collaboration/Get-TeamsAccessReport.ps1" -WarningAction SilentlyContinue } | Should -Not -Throw
    }

    AfterAll {
        Remove-Item Function:\Assert-GraphConnection -ErrorAction SilentlyContinue
        Remove-Item Function:\Write-AssessmentLog -ErrorAction SilentlyContinue
    }
}
