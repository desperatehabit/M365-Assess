BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-TeamsVoice.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-teams-voice.ps1'

    function global:Get-MgSubscribedSku {
        param([switch]$All)
    }
    function global:Get-CsPhoneNumberAssignment {
        param([string]$Identity)
    }
    function global:Set-CsPhoneNumberAssignment {
        param([string]$Identity, [string]$PhoneNumber, [string]$PhoneNumberType)
    }
    function global:Remove-CsPhoneNumberAssignment {
        param([string]$Identity)
    }
    function global:Get-CsOnlineUser {
        param([string]$Identity)
    }
    function global:Grant-CsOnlineVoiceRoutingPolicy {
        param([string]$Identity, [string]$PolicyName)
    }

    . $script:worker
}

Describe 'Invoke-TeamsVoice worker (T-0508)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-TeamsVoice -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-TeamsVoiceJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-TeamsVoiceInput -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-TeamsVoiceLicenseState -CommandType Function) | Should -Not -BeNullOrEmpty
        }
    }

    Context 'input validation' {
        It 'accepts a valid assign' {
            $errors = @(Test-TeamsVoiceInput -Action 'assign' -PhoneNumber '+15550100' -TargetId 'user-1')
            $errors | Should -BeNullOrEmpty
        }

        It 'rejects an assign without a phone number' {
            $errors = @(Test-TeamsVoiceInput -Action 'assign' -PhoneNumber '  ' -TargetId 'user-1')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'phoneNumber is required'
        }

        It 'rejects an assign without a target' {
            $errors = @(Test-TeamsVoiceInput -Action 'assign' -PhoneNumber '+15550100' -TargetId '')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'targetId is required'
        }

        It 'rejects a release without a number id' {
            $errors = @(Test-TeamsVoiceInput -Action 'release' -NumberId '')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'numberId is required'
        }

        It 'rejects a policy assignment without a policy id' {
            $errors = @(Test-TeamsVoiceInput -Action 'policy' -PolicyId '' -TargetId 'user-1')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'policyId is required'
        }
    }

    Context 'license gate' {
        It 'reports licensed when the tenant holds the Phone System plan' {
            Mock Get-MgSubscribedSku {
                param([switch]$All)
                return @(
                    @{ SkuPartNumber = 'MCOEV'; ServicePlans = @(@{ ServicePlanName = 'Microsoft 365 Phone System'; ProvisioningStatus = 'Success' }) }
                )
            }
            $state = Get-TeamsVoiceLicenseState
            $state.Licensed | Should -BeTrue
            $state.MissingPlans | Should -BeNullOrEmpty
        }

        It 'reports not licensed when the Phone System plan is absent' {
            Mock Get-MgSubscribedSku {
                param([switch]$All)
                return @(
                    @{ SkuPartNumber = 'SPE_E5'; ServicePlans = @(@{ ServicePlanName = 'EXCHANGE_S_ENTERPRISE'; ProvisioningStatus = 'Success' }) }
                )
            }
            $state = Get-TeamsVoiceLicenseState
            $state.Licensed | Should -BeFalse
            $state.MissingPlans | Should -Contain 'MCOEV'
        }

        It 'refuses assign when voice is not licensed' {
            Mock Get-MgSubscribedSku {
                param([switch]$All)
                return @(@{ SkuPartNumber = 'SPE_E5'; ServicePlans = @() })
            }
            {
                Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'assign' -PhoneNumber '+15550100' -TargetId 'user-1' -DryRun $true
            } | Should -Throw '*license_required*'
        }

        It 'refuses release when voice is not licensed' {
            Mock Get-MgSubscribedSku {
                param([switch]$All)
                return @(@{ SkuPartNumber = 'SPE_E5'; ServicePlans = @() })
            }
            {
                Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'release' -NumberId 'num-1' -DryRun $true
            } | Should -Throw '*license_required*'
        }

        It 'refuses policy assignment when voice is not licensed' {
            Mock Get-MgSubscribedSku {
                param([switch]$All)
                return @(@{ SkuPartNumber = 'SPE_E5'; ServicePlans = @() })
            }
            {
                Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'policy' -PolicyId 'policy-1' -TargetId 'user-1' -DryRun $true
            } | Should -Throw '*license_required*'
        }
    }

    Context 'list' {
        It 'returns the inventory and license state' {
            Mock Get-MgSubscribedSku {
                param([switch]$All)
                return @(@{ SkuPartNumber = 'MCOEV'; ServicePlans = @(@{ ServicePlanName = 'Microsoft 365 Phone System'; ProvisioningStatus = 'Success' }) })
            }
            Mock Get-CsPhoneNumberAssignment {
                param([string]$Identity)
                return @(
                    @{ Id = 'num-1'; Number = '+15550100'; PhoneNumberType = 'DirectRouting'; AssignedTo = 'user-1'; State = 'Assigned' }
                )
            }
            $res = Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'list'
            $res.license.Licensed | Should -BeTrue
            $res.numbers | Should -Not -BeNullOrEmpty
            $res.numbers[0].number | Should -Be '+15550100'
            $res.numbers[0].assignedTo | Should -Be 'user-1'
        }

        It 'returns an empty inventory when not licensed' {
            Mock Get-MgSubscribedSku {
                param([switch]$All)
                return @(@{ SkuPartNumber = 'SPE_E5'; ServicePlans = @() })
            }
            Mock Get-CsPhoneNumberAssignment {
                param([string]$Identity)
                return @()
            }
            $res = Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'list'
            $res.license.Licensed | Should -BeFalse
            $res.numbers | Should -BeNullOrEmpty
            Assert-MockCalled Get-CsPhoneNumberAssignment -Times 0
        }
    }

    Context 'assign' {
        BeforeEach {
            Mock Get-MgSubscribedSku {
                param([switch]$All)
                return @(@{ SkuPartNumber = 'MCOEV'; ServicePlans = @(@{ ServicePlanName = 'Microsoft 365 Phone System'; ProvisioningStatus = 'Success' }) })
            }
            Mock Get-CsOnlineUser {
                param([string]$Identity)
                return @{
                    DisplayName           = 'Operator One'
                    EnterpriseVoiceEnabled = $true
                    OnPremLineURI         = ''
                    OnlineVoiceRoutingPolicy = ''
                }
            }
            Mock Set-CsPhoneNumberAssignment {
                param([string]$Identity, [string]$PhoneNumber, [string]$PhoneNumberType)
                return @{ Identity = $Identity }
            }
        }

        It 'assign with DryRun returns a plan preview without writing' {
            $plan = Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'assign' -PhoneNumber '+15550100' -TargetId 'user-1' -DryRun $true
            $plan.action | Should -Be 'assign'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.phoneNumber | Should -Be '+15550100'
            $plan.targetId | Should -Be 'user-1'
            $plan.before['lineUri'] | Should -Be ''
            $plan.after['lineUri'] | Should -Be '+15550100'
            $plan.diff | Should -Not -BeNullOrEmpty
            Assert-MockCalled Set-CsPhoneNumberAssignment -Times 0
        }

        It 'assign apply without confirmation is refused' {
            {
                Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'assign' -PhoneNumber '+15550100' -TargetId 'user-1' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Set-CsPhoneNumberAssignment -Times 0
        }

        It 'assign apply captures before/after and produces a TeamOperation plus an audit record' {
            $res = Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'assign' -PhoneNumber '+15550100' -TargetId 'user-1' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.plan.after['lineUri'] | Should -Be '+15550100'
            $res.teamOperation | Should -Not -BeNullOrEmpty
            $res.teamOperation.operation | Should -Be 'voice.assign'
            $res.teamOperation.state | Should -Be 'applied'
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'voice.assign'
            $res.auditEvent.targetId | Should -Be 'user-1'
            $res.auditEvent.before['lineUri'] | Should -Be ''
            $res.auditEvent.after['lineUri'] | Should -Be '+15550100'
            Assert-MockCalled Set-CsPhoneNumberAssignment -Times 1 -ParameterFilter { $PhoneNumber -eq '+15550100' }
        }
    }

    Context 'release' {
        BeforeEach {
            Mock Get-MgSubscribedSku {
                param([switch]$All)
                return @(@{ SkuPartNumber = 'MCOEV'; ServicePlans = @(@{ ServicePlanName = 'Microsoft 365 Phone System'; ProvisioningStatus = 'Success' }) })
            }
            Mock Get-CsPhoneNumberAssignment {
                param([string]$Identity)
                return @{
                    Id               = 'num-1'
                    Number           = '+15550100'
                    PhoneNumberType  = 'DirectRouting'
                    AssignedTo       = 'user-1'
                    State            = 'Assigned'
                }
            }
            Mock Remove-CsPhoneNumberAssignment {
                param([string]$Identity)
                return @{ Identity = $Identity }
            }
        }

        It 'release with DryRun returns a plan preview without writing' {
            $plan = Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'release' -NumberId 'num-1' -DryRun $true
            $plan.action | Should -Be 'release'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.requiresConfirmation | Should -BeTrue
            $plan.before['assignedTo'] | Should -Be 'user-1'
            $plan.after['assignedTo'] | Should -Be ''
            Assert-MockCalled Remove-CsPhoneNumberAssignment -Times 0
        }

        It 'release apply without confirmation is refused' {
            {
                Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'release' -NumberId 'num-1' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Remove-CsPhoneNumberAssignment -Times 0
        }

        It 'release apply produces a TeamOperation plus an audit record' {
            $res = Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'release' -NumberId 'num-1' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.teamOperation.operation | Should -Be 'voice.release'
            $res.teamOperation.state | Should -Be 'applied'
            $res.auditEvent.action | Should -Be 'voice.release'
            $res.auditEvent.targetId | Should -Be 'user-1'
            Assert-MockCalled Remove-CsPhoneNumberAssignment -Times 1
        }
    }

    Context 'policy assignment' {
        BeforeEach {
            Mock Get-MgSubscribedSku {
                param([switch]$All)
                return @(@{ SkuPartNumber = 'MCOEV'; ServicePlans = @(@{ ServicePlanName = 'Microsoft 365 Phone System'; ProvisioningStatus = 'Success' }) })
            }
            Mock Get-CsOnlineUser {
                param([string]$Identity)
                return @{
                    DisplayName           = 'Operator One'
                    EnterpriseVoiceEnabled = $true
                    OnPremLineURI         = ''
                    OnlineVoiceRoutingPolicy = ''
                }
            }
            Mock Grant-CsOnlineVoiceRoutingPolicy {
                param([string]$Identity, [string]$PolicyName)
                return @{ Identity = $Identity }
            }
        }

        It 'policy with DryRun returns a plan preview without writing' {
            $plan = Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'policy' -PolicyId 'policy-1' -TargetId 'user-1' -DryRun $true
            $plan.action | Should -Be 'policy'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.policyId | Should -Be 'policy-1'
            $plan.after['voiceRoutingPolicy'] | Should -Be 'policy-1'
            Assert-MockCalled Grant-CsOnlineVoiceRoutingPolicy -Times 0
        }

        It 'policy apply without confirmation is refused' {
            {
                Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'policy' -PolicyId 'policy-1' -TargetId 'user-1' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Grant-CsOnlineVoiceRoutingPolicy -Times 0
        }

        It 'policy apply produces a TeamOperation plus an audit record' {
            $res = Invoke-TeamsVoice -TenantId 'tenant-test' -Action 'policy' -PolicyId 'policy-1' -TargetId 'user-1' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.teamOperation.operation | Should -Be 'voice.policy'
            $res.teamOperation.state | Should -Be 'applied'
            $res.auditEvent.action | Should -Be 'voice.policy'
            $res.auditEvent.after['voiceRoutingPolicy'] | Should -Be 'policy-1'
            Assert-MockCalled Grant-CsOnlineVoiceRoutingPolicy -Times 1 -ParameterFilter { $PolicyName -eq 'policy-1' }
        }
    }
}
