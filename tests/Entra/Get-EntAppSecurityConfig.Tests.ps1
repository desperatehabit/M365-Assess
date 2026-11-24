BeforeDiscovery {
    # Nothing needed at discovery time
}

Describe 'Get-EntAppSecurityConfig' {
    BeforeAll {
        function global:Update-CheckProgress {
            param($CheckId, $Setting, $Status)
        }

        function Get-MgContext { return @{ TenantId = 'test-tenant-id' } }

        Mock Import-Module { }

        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            switch -Wildcard ($Uri) {
                '*/organization' {
                    return @{ value = @(
                        @{ id = 'tenant-id-001' }
                    )}
                }
                '*/servicePrincipals?*' {
                    return @{ value = @(
                        @{
                            id                       = 'sp-001'
                            appId                    = 'app-001'
                            displayName              = 'Internal App'
                            appOwnerOrganizationId   = 'tenant-id-001'
                            servicePrincipalType     = 'Application'
                            accountEnabled           = $true
                            keyCredentials           = @(@{ keyId = 'key-1' })
                            passwordCredentials      = @()
                        }
                        @{
                            id                       = 'sp-002'
                            appId                    = 'app-002'
                            displayName              = 'Foreign Risky App'
                            appOwnerOrganizationId   = 'foreign-tenant-999'
                            servicePrincipalType     = 'Application'
                            accountEnabled           = $true
                            keyCredentials           = @()
                            passwordCredentials      = @(@{ keyId = 'pwd-1' })
                        }
                        @{
                            id                       = 'sp-003'
                            appId                    = 'app-003'
                            displayName              = 'My Managed Identity'
                            appOwnerOrganizationId   = 'tenant-id-001'
                            servicePrincipalType     = 'ManagedIdentity'
                            accountEnabled           = $true
                            keyCredentials           = @()
                            passwordCredentials      = @()
                        }
                    )}
                }
                '*/roleManagement/directory/roleAssignments*' {
                    return @{ value = @() }
                }
                '*/servicePrincipals/sp-001/appRoleAssignments' {
                    return @{ value = @() }
                }
                '*/servicePrincipals/sp-002/appRoleAssignments' {
                    return @{ value = @() }
                }
                '*/servicePrincipals/sp-003/appRoleAssignments' {
                    return @{ value = @() }
                }
                '*/servicePrincipals/*/oauth2PermissionGrants' {
                    return @{ value = @() }
                }
                '*/servicePrincipals/*?*signInActivity*' {
                    return @{ signInActivity = @{ lastSignInDateTime = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssZ') } }
                }
                '*/policies/defaultAppManagementPolicy' {
                    return @{ isEnabled = $false }
                }
                default {
                    return @{ value = @() }
                }
            }
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Entra/Get-EntAppSecurityConfig.ps1"
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

    It 'ENTRA-ENTAPP-001 check produces a result for apps with credentials' {
        $check = $settings | Where-Object { $_.CheckId -like 'ENTRA-ENTAPP-001*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Category | Should -Be 'Enterprise Applications'
    }

    It 'ENTRA-ENTAPP-003 check produces a result for foreign app permissions' {
        $check = $settings | Where-Object { $_.CheckId -like 'ENTRA-ENTAPP-003*' }
        $check | Should -Not -BeNullOrEmpty
    }

    It 'ENTRA-ENTAPP-008 check produces a result for managed identity permissions' {
        $check = $settings | Where-Object { $_.CheckId -like 'ENTRA-ENTAPP-008*' }
        $check | Should -Not -BeNullOrEmpty
        $check.Category | Should -Be 'Managed Identities'
    }

    It 'ENTRA-ENTAPP-009 check produces a result for managed identity roles' {
        $check = $settings | Where-Object { $_.CheckId -like 'ENTRA-ENTAPP-009*' }
        $check | Should -Not -BeNullOrEmpty
    }

    It 'Produces settings across Enterprise Applications and Managed Identities categories' {
        $categories = $settings | Select-Object -ExpandProperty Category -Unique
        $categories | Should -Contain 'Enterprise Applications'
        $categories | Should -Contain 'Managed Identities'
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}

Describe 'Get-EntAppSecurityConfig - ENTRA-ENTAPP-020 Microsoft tenant exclusion' {
    BeforeAll {
        function global:Update-CheckProgress { param($CheckId, $Setting, $Status) }
        function Get-MgContext { return @{ TenantId = 'test-tenant-id' } }
        Mock Import-Module { }

        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            switch -Wildcard ($Uri) {
                '*/organization' {
                    return @{ value = @(@{ id = 'tenant-id-001' }) }
                }
                '*/servicePrincipals?*' {
                    return @{ value = @(
                        # Legitimate Microsoft first-party SP — should NOT be flagged
                        @{
                            id                     = 'sp-ms-001'
                            appId                  = 'ms-app-001'
                            displayName            = 'Microsoft Intune Service Discovery'
                            appOwnerOrganizationId = 'f8cdef31-a31e-4b4a-93e4-5f571e91255a'
                            servicePrincipalType   = 'Application'
                            accountEnabled         = $true
                            keyCredentials         = @()
                            passwordCredentials    = @()
                        }
                        # Third-party SP with Microsoft-like name — SHOULD be flagged
                        @{
                            id                     = 'sp-evil-001'
                            appId                  = 'evil-app-001'
                            displayName            = 'Microsoft Defender Fake'
                            appOwnerOrganizationId = 'evil-tenant-999'
                            servicePrincipalType   = 'Application'
                            accountEnabled         = $true
                            keyCredentials         = @()
                            passwordCredentials    = @()
                        }
                    )}
                }
                '*/roleManagement/directory/roleAssignments*' { return @{ value = @() } }
                '*/policies/defaultAppManagementPolicy'        { return @{ isEnabled = $false } }
                default                                        { return @{ value = @() } }
            }
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Entra/Get-EntAppSecurityConfig.ps1"
    }

    It 'should not flag legitimate Microsoft first-party SPs from the Microsoft tenant' {
        $check = $settings | Where-Object { $_.Setting -eq 'Foreign Apps Impersonating Microsoft Names' }
        $check | Should -Not -BeNullOrEmpty
        $check.CurrentValue | Should -Not -Match 'Microsoft Intune Service Discovery'
    }

    It 'should flag genuinely foreign SPs with Microsoft-like names' {
        $check = $settings | Where-Object { $_.Setting -eq 'Foreign Apps Impersonating Microsoft Names' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Fail'
        $check.CurrentValue | Should -Match 'Microsoft Defender Fake'
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}

Describe 'Get-EntAppSecurityConfig - app registration credentials (T-0955)' {
    BeforeAll {
        function global:Update-CheckProgress { param($CheckId, $Setting, $Status) }
        function Get-MgContext { return @{ TenantId = 'test-tenant-id' } }
        Mock Import-Module { }

        # Secrets and certificates sit on the app registrations, not on their service
        # principals. A Microsoft first-party SP also carries a secret on the SP itself.
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            $past = (Get-Date).AddDays(-30).ToString('o')
            $future = (Get-Date).AddDays(300).ToString('o')
            # Owner routes first: in -Wildcard, '?' matches any character, so the list
            # routes below would also match the owners URIs.
            switch -Wildcard ($Uri) {
                '*/applications/*/owners*'      { return @{ value = @() } }
                '*/servicePrincipals/*/owners*' { return @{ value = @() } }
                '*/organization' {
                    return @{ value = @(@{ id = 'tenant-id-001' }) }
                }
                '*/applications?*' {
                    return @{ value = @(
                        @{ id = 'app-obj-1'; appId = 'app-secret'; displayName = 'Secret Only App'
                           passwordCredentials = @(@{ keyId = 'p1'; endDateTime = $past }); keyCredentials = @() }
                        @{ id = 'app-obj-2'; appId = 'app-cert'; displayName = 'Cert App'
                           passwordCredentials = @(); keyCredentials = @(@{ keyId = 'k1'; endDateTime = $future }) }
                        @{ id = 'app-obj-3'; appId = 'app-dual'; displayName = 'Dual App'
                           passwordCredentials = @(@{ keyId = 'p2'; endDateTime = $future })
                           keyCredentials = @(@{ keyId = 'k2'; endDateTime = $future }) }
                    )}
                }
                '*/servicePrincipals?*' {
                    return @{ value = @(
                        foreach ($appId in 'app-secret', 'app-cert', 'app-dual') {
                            @{ id = "sp-$appId"; appId = $appId; displayName = "SP $appId"
                               appOwnerOrganizationId = 'tenant-id-001'; servicePrincipalType = 'Application'
                               accountEnabled = $true; keyCredentials = @(); passwordCredentials = @() }
                        }
                        @{ id = 'sp-ms-fp'; appId = 'ms-fp-app'; displayName = 'Microsoft First Party'
                           appOwnerOrganizationId = 'f8cdef31-a31e-4b4a-93e4-5f571e91255a'; servicePrincipalType = 'Application'
                           accountEnabled = $true; keyCredentials = @()
                           passwordCredentials = @(@{ keyId = 'p3'; endDateTime = $future }) }
                    )}
                }
                '*/roleManagement/directory/roleAssignments*' { return @{ value = @() } }
                '*/policies/defaultAppManagementPolicy'       { return @{ isEnabled = $false } }
                default                                       { return @{ value = @() } }
            }
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Entra/Get-EntAppSecurityConfig.ps1"
    }

    It 'ENTRA-ENTAPP-001 counts credentials on app registrations and service principals' {
        $check = $settings | Where-Object { $_.Setting -eq 'Apps with Client Credentials' }
        $check.CurrentValue | Should -Match '^4 enabled app\(s\)'
        $check.CurrentValue | Should -Match '3 app registration\(s\), 1 service principal\(s\)'
    }

    It 'ENTRA-ENTAPP-012 flags an app registration that uses only a client secret' {
        $check = $settings | Where-Object { $_.Setting -eq 'Apps Using Secrets Instead of Certificates' }
        $check.Status | Should -Be 'Warning'
        $check.CurrentValue | Should -Match ([regex]::Escape('Secret Only App (app registration)'))
        $check.CurrentValue | Should -Not -Match 'Cert App'
    }

    It 'ENTRA-ENTAPP-013 flags an app registration with an expired secret' {
        $check = $settings | Where-Object { $_.Setting -eq 'Apps with Expired Credentials' }
        $check.Status | Should -Be 'Warning'
        $check.CurrentValue | Should -Match ([regex]::Escape('1 app(s): Secret Only App (app registration)'))
    }

    It 'ENTRA-ENTAPP-014 flags an app registration with both a secret and a certificate' {
        $check = $settings | Where-Object { $_.Setting -eq 'Apps with Both Secrets and Certificates' }
        $check.CurrentValue | Should -Match ([regex]::Escape('1 app(s): Dual App (app registration)'))
    }

    It 'ENTRA-ENTAPP-018 checks app registration owners and skips Microsoft first-party service principals' {
        $check = $settings | Where-Object { $_.Setting -eq 'Credentialed Apps with No Owners' }
        $check.CurrentValue | Should -Match '^3 orphaned app\(s\)'
        $check.CurrentValue | Should -Not -Match 'Microsoft First Party'
        Should -Invoke Invoke-MgGraphRequest -Scope Describe -ParameterFilter { $Uri -like '*/applications/app-obj-1/owners*' }
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}

Describe 'Get-EntAppSecurityConfig - ENTRA-ENTAPP-003 first-party classification (#1001)' {
    BeforeAll {
        function global:Update-CheckProgress { param($CheckId, $Setting, $Status) }
        function Get-MgContext { return @{ TenantId = 'test-tenant-id' } }
        Mock Import-Module { }

        # Both a Microsoft first-party app (owner = Microsoft first-party tenant) and a
        # genuine third-party app hold the same Tier 0 Graph permission. The third-party
        # app must Fail the check; the first-party app must be classified separately
        # (surfaced in Evidence, not driving the Fail).
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            switch -Wildcard ($Uri) {
                '*/organization' {
                    return @{ value = @(@{ id = 'tenant-id-001' }) }
                }
                # Microsoft Graph resource SP: maps the tier0 app-role id to its name
                '*00000003-0000-0000-c000-000000000000*' {
                    return @{ value = @(@{
                        id = 'graph-sp-id'
                        appRoles = @(
                            @{ id = 'role-tier0-dmc'; value = 'DeviceManagementConfiguration.ReadWrite.All' }
                        )
                        oauth2PermissionScopes = @()
                    }) }
                }
                # Bulk app-role assignments from the Graph resource SP side
                '*/servicePrincipals/graph-sp-id/appRoleAssignedTo*' {
                    return @{ value = @(
                        @{ principalId = 'sp-ms-fp'; appRoleId = 'role-tier0-dmc'; resourceId = 'graph-sp-id' }
                        @{ principalId = 'sp-third'; appRoleId = 'role-tier0-dmc'; resourceId = 'graph-sp-id' }
                    )}
                }
                '*/servicePrincipals?*' {
                    return @{ value = @(
                        # Microsoft first-party app (Modern Workplace Management / Autopatch).
                        # Owner tenant is deliberately NOT one of the well-known Microsoft
                        # tenants, so classification relies on the AppId being in the allowlist
                        # JSON - this exercises the AppId detection path and the JSON addition.
                        @{
                            id                     = 'sp-ms-fp'
                            appId                  = '789997c7-d888-4475-a0a0-35014494de85'
                            displayName            = 'Modern Workplace Management'
                            appOwnerOrganizationId = 'unlisted-tenant-777'
                            servicePrincipalType   = 'Application'
                            accountEnabled         = $true
                            keyCredentials         = @()
                            passwordCredentials    = @()
                        }
                        # Genuine third-party app with the same Tier 0 permission
                        @{
                            id                     = 'sp-third'
                            appId                  = 'third-app-001'
                            displayName            = 'Third Party Risky App'
                            appOwnerOrganizationId = 'foreign-tenant-999'
                            servicePrincipalType   = 'Application'
                            accountEnabled         = $true
                            keyCredentials         = @()
                            passwordCredentials    = @()
                        }
                    )}
                }
                '*/roleManagement/directory/roleAssignments*' { return @{ value = @() } }
                '*/policies/defaultAppManagementPolicy'       { return @{ isEnabled = $false } }
                default                                       { return @{ value = @() } }
            }
        }

        . "$PSScriptRoot/../../src/M365-Assess/Orchestrator/AssessmentHelpers.ps1"
        . "$PSScriptRoot/../../src/M365-Assess/Entra/Get-EntAppSecurityConfig.ps1"
    }

    It 'flags the third-party app with Tier 0 permissions' {
        $check = $settings | Where-Object { $_.Setting -eq 'Foreign Apps with Tier 0 Permissions (GA Escalation)' }
        $check | Should -Not -BeNullOrEmpty
        $check.Status | Should -Be 'Fail'
        $check.CurrentValue | Should -Match 'Third Party Risky App'
    }

    It 'does not flag the Microsoft first-party app as a Tier 0 finding' {
        $check = $settings | Where-Object { $_.Setting -eq 'Foreign Apps with Tier 0 Permissions (GA Escalation)' }
        $check.CurrentValue | Should -Not -Match 'Modern Workplace Management'
    }

    It 'still reports the first-party app separately in Evidence' {
        $check = $settings | Where-Object { $_.Setting -eq 'Foreign Apps with Tier 0 Permissions (GA Escalation)' }
        ($check.Evidence.MicrosoftFirstParty -join '; ') | Should -Match 'Modern Workplace Management'
    }

    AfterAll {
        Remove-Item Function:\Update-CheckProgress -ErrorAction SilentlyContinue
    }
}
