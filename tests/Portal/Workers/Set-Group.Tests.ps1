BeforeAll {
    $script:repoRoot = (Resolve-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
    $script:worker = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/Set-Group.ps1'
    $script:entrypoint = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/set-group.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }
    function global:Set-UnifiedGroup {
        param($Identity, $HiddenFromAddressListsEnabled, $RequireSenderAuthenticationEnabled, $GrantSendOnBehalfTo, $Confirm)
    }
    function global:Set-DistributionGroup {
        param($Identity, $HiddenFromAddressListsEnabled, $RequireSenderAuthenticationEnabled, $GrantSendOnBehalfTo, $Confirm)
    }

    . $script:worker
}

AfterAll {
    Remove-Item -Path 'Function:\global:Invoke-MgGraphRequest' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\global:Set-UnifiedGroup' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\global:Set-DistributionGroup' -ErrorAction SilentlyContinue
}

Describe 'Set-Group worker (T-0262, T-0900)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command -Name 'Invoke-SetGroup' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'Test-DynamicRuleSyntax' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'Read-SetGroupJob' -CommandType Function) | Should -Not -BeNullOrEmpty
        }
    }

    Context 'Dynamic-rule validation' {
        It 'accepts valid rule syntax' {
            $check = Test-DynamicRuleSyntax -Rule '(user.department -eq "Sales")'
            $check.Valid | Should -BeTrue

            $check2 = Test-DynamicRuleSyntax -Rule '(user.city -startsWith "New")'
            $check2.Valid | Should -BeTrue
        }

        It 'rejects empty or whitespace rules' {
            $check = Test-DynamicRuleSyntax -Rule '  '
            $check.Valid | Should -BeFalse
            $check.Message | Should -Match 'cannot be empty'
        }

        It 'rejects rules with mismatched parentheses' {
            $check = Test-DynamicRuleSyntax -Rule '(user.department -eq "Sales"'
            $check.Valid | Should -BeFalse
            $check.Message | Should -Match 'enclosed in parentheses|Mismatched'
        }

        It 'rejects rules without valid operators' {
            $check = Test-DynamicRuleSyntax -Rule '(user.department is "Sales")'
            $check.Valid | Should -BeFalse
            $check.Message | Should -Match 'valid comparison operator'
        }
    }

    Context 'Read-SetGroupJob envelope parsing' {
        It 'distinguishes omitted or null description from explicit empty string' {
            $omittedPath = Join-Path -Path $TestDrive -ChildPath 'job-omitted.json'
            $nullPath = Join-Path -Path $TestDrive -ChildPath 'job-null.json'
            $emptyPath = Join-Path -Path $TestDrive -ChildPath 'job-empty.json'

            @{ tenantId = 'tenant-test'; action = 'edit'; groupId = 'grp-1' } | ConvertTo-Json | Set-Content -LiteralPath $omittedPath
            @{ tenantId = 'tenant-test'; action = 'edit'; groupId = 'grp-1'; description = $null } | ConvertTo-Json | Set-Content -LiteralPath $nullPath
            @{ tenantId = 'tenant-test'; action = 'edit'; groupId = 'grp-1'; description = '' } | ConvertTo-Json | Set-Content -LiteralPath $emptyPath

            (Read-SetGroupJob -Path $omittedPath)['HasDescription'] | Should -BeFalse
            (Read-SetGroupJob -Path $nullPath)['HasDescription'] | Should -BeFalse

            $emptyJob = Read-SetGroupJob -Path $emptyPath
            $emptyJob['HasDescription'] | Should -BeTrue
            $emptyJob['Description'] | Should -Be ''
        }

        It 'reads targetType and GAL/delivery create options from job JSON' {
            $jobPath = Join-Path -Path $TestDrive -ChildPath 'job-create-convert.json'
            @{
                tenantId                           = 'tenant-test'
                action                             = 'create'
                displayName                        = 'Mail Team'
                groupType                          = 'm365'
                targetType                         = 'm365'
                hiddenFromAddressListsEnabled      = $true
                requireSenderAuthenticationEnabled = $true
                grantSendOnBehalfTo                = @('delegate@example.invalid')
                dryRun                             = $false
            } | ConvertTo-Json | Set-Content -LiteralPath $jobPath

            $job = Read-SetGroupJob -Path $jobPath
            $job['TargetType'] | Should -Be 'm365'
            $job['HiddenFromAddressListsEnabled'] | Should -BeTrue
            $job['RequireSenderAuthenticationEnabled'] | Should -BeTrue
            $job['GrantSendOnBehalfTo'] | Should -Be @('delegate@example.invalid')
        }
    }

    Context 'Group CRUD operations and plan preview' {
        BeforeEach {
            $script:capturedBodies = [System.Collections.Generic.List[object]]::new()
            $script:existingGroup = @{
                id              = 'grp-123'
                displayName     = 'Old Security Group'
                description     = 'Old description'
                groupTypes      = @()
                mailEnabled     = $false
                securityEnabled = $true
                mail            = $null
                membershipRule  = $null
            }
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Body) {
                    $script:capturedBodies.Add(@{ Method = $Method; Uri = $Uri; Body = ($Body | ConvertFrom-Json) })
                }
                if ($Method -eq 'GET' -and $Uri -like '*/groups/grp-123') {
                    return $script:existingGroup
                }
                if ($Method -eq 'POST' -and $Uri -like '*/groups') {
                    return @{
                        id          = 'grp-new-1'
                        displayName = 'New Sec Group'
                    }
                }
                if ($Method -eq 'PATCH') {
                    return @{
                        id          = 'grp-123'
                        displayName = 'Updated Security Group'
                    }
                }
                if ($Method -eq 'DELETE') {
                    return @{ deleted = $true }
                }
            }
            Mock Set-UnifiedGroup {}
            Mock Set-DistributionGroup {}
        }

        It 'create with DryRun returns a plan preview without calling POST' {
            $plan = Invoke-SetGroup -TenantId 'tenant-test' -Action 'create' -DisplayName 'Test Group' -GroupType 'security' -DryRun $true
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.targetName | Should -Be 'Test Group'
            $plan.diff | Should -Not -BeNullOrEmpty
            Should -Invoke Invoke-MgGraphRequest -Times 0 -ParameterFilter { $Method -eq 'POST' }
        }

        It 'create without DryRun calls POST and produces an audit record' {
            $res = Invoke-SetGroup -TenantId 'tenant-test' -Action 'create' -DisplayName 'New Sec Group' -GroupType 'security' -DryRun $false
            $res.success | Should -BeTrue
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'group.create'
            $res.auditEvent.targetId | Should -Be 'grp-new-1'
            Should -Invoke Invoke-MgGraphRequest -Times 1 -ParameterFilter { $Method -eq 'POST' }
        }

        It 'create with GAL and delivery options previews them and applies via EXO on live create' {
            $plan = Invoke-SetGroup -TenantId 'tenant-test' -Action 'create' -DisplayName 'Mail Team' -GroupType 'm365' -HiddenFromAddressListsEnabled $true -RequireSenderAuthenticationEnabled $true -GrantSendOnBehalfTo @('alice@example.invalid') -DryRun $true
            $plan.after.hiddenFromAddressListsEnabled | Should -BeTrue
            $plan.after.requireSenderAuthenticationEnabled | Should -BeTrue
            $plan.after.grantSendOnBehalfTo | Should -Be @('alice@example.invalid')
            ($plan.diff -join ' ') | Should -Match 'GAL'
            ($plan.diff -join ' ') | Should -Match 'delivery management'
            Should -Invoke Set-UnifiedGroup -Times 0

            $res = Invoke-SetGroup -TenantId 'tenant-test' -Action 'create' -DisplayName 'Mail Team' -GroupType 'm365' -HiddenFromAddressListsEnabled $true -RequireSenderAuthenticationEnabled $true -GrantSendOnBehalfTo @('alice@example.invalid') -DryRun $false
            $res.success | Should -BeTrue
            Should -Invoke Set-UnifiedGroup -Times 1 -ParameterFilter {
                $Identity -eq 'grp-new-1' -and
                $HiddenFromAddressListsEnabled -eq $true -and
                $RequireSenderAuthenticationEnabled -eq $true -and
                $GrantSendOnBehalfTo -contains 'alice@example.invalid'
            }
        }

        It 'create distribution group with GAL and delivery options applies via Set-DistributionGroup' {
            $res = Invoke-SetGroup -TenantId 'tenant-test' -Action 'create' -DisplayName 'Distro Team' -GroupType 'distribution' -HiddenFromAddressListsEnabled $true -RequireSenderAuthenticationEnabled $true -DryRun $false
            $res.success | Should -BeTrue
            Should -Invoke Set-DistributionGroup -Times 1 -ParameterFilter {
                $Identity -eq 'grp-new-1' -and
                $HiddenFromAddressListsEnabled -eq $true -and
                $RequireSenderAuthenticationEnabled -eq $true
            }
        }

        It 'edit with DryRun returns diff against existing group' {
            $plan = Invoke-SetGroup -TenantId 'tenant-test' -Action 'edit' -GroupId 'grp-123' -DisplayName 'Renamed Group' -DryRun $true
            $plan.valid | Should -BeTrue
            $plan.diff[0] | Should -Match 'Change displayName'
            $plan.after.description | Should -Be 'Old description'
            Should -Invoke Invoke-MgGraphRequest -Times 1 -ParameterFilter { $Method -eq 'GET' }
            Should -Invoke Invoke-MgGraphRequest -Times 0 -ParameterFilter { $Method -eq 'PATCH' }
        }

        It 'edit with explicit empty description clears description by sending null in Graph PATCH' {
            $plan = Invoke-SetGroup -TenantId 'tenant-test' -Action 'edit' -GroupId 'grp-123' -Description '' -DryRun $true
            $plan.after.description | Should -Be ''
            ($plan.diff -join ' ') | Should -Match "Change description: 'Old description' -> ''"

            $res = Invoke-SetGroup -TenantId 'tenant-test' -Action 'edit' -GroupId 'grp-123' -Description '' -DryRun $false
            $res.success | Should -BeTrue
            $patchCall = $script:capturedBodies | Where-Object -FilterScript { $_.Method -eq 'PATCH' } | Select-Object -First 1
            $patchCall | Should -Not -BeNullOrEmpty
            ($patchCall.Body.PSObject.Properties.Name -contains 'description') | Should -BeTrue
            $patchCall.Body.description | Should -BeNullOrEmpty
        }

        It 'edit without Description parameter does not include description in Graph PATCH' {
            $res = Invoke-SetGroup -TenantId 'tenant-test' -Action 'edit' -GroupId 'grp-123' -DisplayName 'Renamed Only' -DryRun $false
            $res.success | Should -BeTrue
            $patchCall = $script:capturedBodies | Where-Object -FilterScript { $_.Method -eq 'PATCH' } | Select-Object -First 1
            ($patchCall.Body.PSObject.Properties.Name -contains 'description') | Should -BeFalse
            $patchCall.Body.displayName | Should -Be 'Renamed Only'
        }

        It 'delete requires naming confirmation' {
            {
                Invoke-SetGroup -TenantId 'tenant-test' -Action 'delete' -GroupId 'grp-123' -ConfirmName 'Wrong Name'
            } | Should -Throw '*ConfirmationRequired*'
        }

        It 'delete succeeds when ConfirmName matches' {
            $res = Invoke-SetGroup -TenantId 'tenant-test' -Action 'delete' -GroupId 'grp-123' -ConfirmName 'Old Security Group'
            $res.success | Should -BeTrue
            $res.auditEvent.action | Should -Be 'group.delete'
            Should -Invoke Invoke-MgGraphRequest -Times 1 -ParameterFilter { $Method -eq 'DELETE' }
        }
    }

    Context 'Group conversion action (T-0900)' {
        BeforeEach {
            $script:convertBodies = [System.Collections.Generic.List[object]]::new()
            $script:convertSource = @{
                id              = 'grp-conv-1'
                displayName     = 'Convertible Group'
                description     = 'Desc'
                groupTypes      = @()
                mailEnabled     = $false
                securityEnabled = $true
                mail            = $null
                membershipRule  = $null
            }
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Body) {
                    $script:convertBodies.Add(@{ Method = $Method; Uri = $Uri; Body = ($Body | ConvertFrom-Json) })
                }
                if ($Method -eq 'GET' -and $Uri -like '*/groups/grp-conv-1') {
                    return $script:convertSource
                }
                if ($Method -eq 'PATCH') {
                    return @{ id = 'grp-conv-1'; displayName = 'Convertible Group' }
                }
            }
        }

        It 'previews conversion in DryRun without calling PATCH' {
            $plan = Invoke-SetGroup -TenantId 'tenant-test' -Action 'convert' -GroupId 'grp-conv-1' -TargetType 'm365' -DryRun $true
            $plan.action | Should -Be 'convert'
            $plan.before.groupType | Should -Be 'security'
            $plan.after.groupType | Should -Be 'm365'
            $plan.diff[0] | Should -Match 'security -> m365'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -ParameterFilter { $Method -eq 'PATCH' }
        }

        It 'converts security group to dynamic with validated rule' {
            $res = Invoke-SetGroup -TenantId 'tenant-test' -Action 'convert' -GroupId 'grp-conv-1' -TargetType 'dynamic' -DynamicRule '(user.department -eq "IT")' -DryRun $false
            $res.success | Should -BeTrue
            $res.auditEvent.action | Should -Be 'group.convert'
            $patchCall = $script:convertBodies | Where-Object -FilterScript { $_.Method -eq 'PATCH' } | Select-Object -First 1
            $patchCall.Body.groupTypes | Should -Be @('DynamicMembership')
            $patchCall.Body.membershipRule | Should -Be '(user.department -eq "IT")'
            $patchCall.Body.membershipRuleProcessingState | Should -Be 'On'
        }

        It 'rejects conversion to dynamic with invalid rule' {
            {
                Invoke-SetGroup -TenantId 'tenant-test' -Action 'convert' -GroupId 'grp-conv-1' -TargetType 'dynamic' -DynamicRule 'missing parens' -DryRun $false
            } | Should -Throw '*ValidationFailed*'
        }

        It 'treats converting to the same type as a no-op without calling PATCH' {
            $res = Invoke-SetGroup -TenantId 'tenant-test' -Action 'convert' -GroupId 'grp-conv-1' -TargetType 'security' -DryRun $false
            $res.success | Should -BeTrue
            $res.result.unchanged | Should -BeTrue
            Should -Invoke Invoke-MgGraphRequest -Times 0 -ParameterFilter { $Method -eq 'PATCH' }
        }
    }
}
