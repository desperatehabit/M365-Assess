BeforeAll {
    $script:moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../src/M365-Assess')).Path
    $script:remediateDir = Join-Path $script:moduleRoot 'Remediate'
    $script:psm1 = Join-Path $script:moduleRoot 'M365-Assess.psm1'

    . (Join-Path $script:remediateDir 'Get-RemediationAllowlist.ps1')
    . (Join-Path $script:remediateDir 'Test-RemediationGate.ps1')
    . (Join-Path $script:remediateDir 'Get-RemediationCommand.ps1')
    . (Join-Path $script:remediateDir 'Invoke-RemediationAction.ps1')

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
}

Describe 'Get-RemediationCommand (T-0107)' {

    Context 'typed bindings' {
        It 'maps a validated check to its typed command and parameters' {
            $binding = Get-RemediationCommand -CheckId 'SPO-SHARING-001'
            $binding.Kind | Should -Be 'typed'
            $binding.CommandName | Should -Be 'Set-SpoSharingCapability'
            $binding.Parameters['SharingCapability'] | Should -Be 'ExistingExternalUserSharingOnly'
            $binding.Reason | Should -BeNullOrEmpty
        }

        It 'strips the sub-number suffix before lookup' {
            $binding = Get-RemediationCommand -CheckId 'SPO-SHARING-001.2'
            $binding.RegistryKey | Should -Be 'SPO-SHARING-001'
            $binding.Kind | Should -Be 'typed'
        }
    }

    Context 'unknown commands' {
        It 'refuses an unvalidated check with not-implemented' {
            $binding = Get-RemediationCommand -CheckId 'NOPE-UNKNOWN-999.1'
            $binding.Kind | Should -Be 'not-implemented'
            $binding.Reason | Should -Be 'not-implemented'
            $binding.CommandName | Should -BeNullOrEmpty
        }
    }
}

Describe 'Invoke-RemediationAction (T-0107)' {

    Context 'dry run' {
        It '-WhatIf writes nothing and reports the intended change' {
            $store = @{ SharingCapability = 'ExternalUserSharingOnly' }
            $get = { $store.SharingCapability }.GetNewClosure()
            $apply = { $store.SharingCapability = 'ExistingExternalUserSharingOnly'; $store.SharingCapability }.GetNewClosure()
            $result = Invoke-RemediationAction -CheckId 'SPO-SHARING-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('SPO-SHARING-001') `
                -GetState $get -ApplyChange $apply -WhatIf -Confirm:$false
            $result.State | Should -Be 'dryrun'
            $result.Before | Should -Be 'ExternalUserSharingOnly'
            $result.IntendedChange['SharingCapability'] | Should -Be 'ExistingExternalUserSharingOnly'
            $result.DryRun | Should -BeTrue
            $store.SharingCapability | Should -Be 'ExternalUserSharingOnly'
        }

        It '-DryRun writes nothing and reports the intended change' {
            $store = @{ SharingCapability = 'ExternalUserSharingOnly' }
            $get = { $store.SharingCapability }.GetNewClosure()
            $apply = { $store.SharingCapability = 'ExistingExternalUserSharingOnly'; $store.SharingCapability }.GetNewClosure()
            $result = Invoke-RemediationAction -CheckId 'SPO-SHARING-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('SPO-SHARING-001') `
                -GetState $get -ApplyChange $apply -DryRun -Confirm:$false
            $result.State | Should -Be 'dryrun'
            $store.SharingCapability | Should -Be 'ExternalUserSharingOnly'
        }
    }

    Context 'unvalidated commands' {
        It 'refuses an unknown command without executing anything' {
            $invoked = @{ Value = $false }
            $get = { 'current' }.GetNewClosure()
            $apply = { $invoked.Value = $true; 'mutated' }.GetNewClosure()
            $result = Invoke-RemediationAction -CheckId 'NOPE-UNKNOWN-999.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('NOPE-UNKNOWN-999') `
                -GetState $get -ApplyChange $apply -Confirm:$false
            $result.State | Should -Be 'not-implemented'
            $result.Reason | Should -Be 'not-implemented'
            $invoked.Value | Should -BeFalse
        }
    }

    Context 'apply' {
        It 'captures before and after around the typed action' {
            $store = @{ Value = 'before-state' }
            $get = { $store.Value }.GetNewClosure()
            $apply = { $store.Value = 'after-state'; $store.Value }.GetNewClosure()
            $result = Invoke-RemediationAction -CheckId 'SPO-SHARING-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('SPO-SHARING-001') `
                -GetState $get -ApplyChange $apply -Confirm:$false
            $result.State | Should -Be 'applied'
            $result.Before | Should -Be 'before-state'
            $result.After | Should -Be 'after-state'
            $result.DryRun | Should -BeFalse
            $store.Value | Should -Be 'after-state'
        }

        It 'exposes ShouldProcess confirmation (-WhatIf / -Confirm)' {
            $command = Get-Command -Name Invoke-RemediationAction
            $command.Parameters.Keys | Should -Contain 'WhatIf'
            $command.Parameters.Keys | Should -Contain 'Confirm'
        }
    }

    Context 'gates' {
        It 'skips a non-allowlisted check without reading or writing state' {
            $touched = @{ Value = $false }
            $get = { $touched.Value = $true; 'current' }.GetNewClosure()
            $apply = { $touched.Value = $true; 'mutated' }.GetNewClosure()
            $result = Invoke-RemediationAction -CheckId 'SPO-SHARING-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller) -AllowlistCheckIds @('SOME-OTHER-CHECK') `
                -GetState $get -ApplyChange $apply -Confirm:$false
            $result.State | Should -Be 'skipped'
            $result.Reason | Should -Be 'not-allowlisted'
            $touched.Value | Should -BeFalse
        }

        It 'rejects a caller without the apply permission' {
            $result = Invoke-RemediationAction -CheckId 'SPO-SHARING-001.1' -TenantId 'tenant-a' `
                -CallerContext (New-TestCaller -Permissions @('remediation.read')) `
                -AllowlistCheckIds @('SPO-SHARING-001') -Confirm:$false
            $result.State | Should -Be 'rejected'
            $result.GateDecision.StatusCode | Should -Be 403
        }
    }

    Context 'no string evaluation' {
        It 'uses no Invoke-Expression anywhere in Remediate/' {
            $violations = @()
            $files = Get-ChildItem -Path $script:remediateDir -Filter '*.ps1' -File
            foreach ($file in $files) {
                $tokens = $null
                $errors = $null
                $ast = [System.Management.Automation.Language.Parser]::ParseFile(
                    $file.FullName, [ref]$tokens, [ref]$errors
                )
                $commands = $ast.FindAll({
                        param($node)
                        $node -is [System.Management.Automation.Language.CommandAst]
                    }, $true)
                foreach ($cmd in $commands) {
                    $nameElement = $cmd.CommandElements[0]
                    if ($nameElement -is [System.Management.Automation.Language.StringConstantExpressionAst] `
                            -and $nameElement.Value -eq 'Invoke-Expression') {
                        $violations += "$($file.Name):$($cmd.Extent.StartLineNumber)"
                    }
                }
            }
            $violations | Should -BeNullOrEmpty
        }
    }

    Context 'module placement' {
        It 'dot-sources both files from the module loader' {
            $psm1Body = Get-Content -Path $script:psm1 -Raw
            $psm1Body | Should -Match 'Remediate[\\/]Get-RemediationCommand\.ps1'
            $psm1Body | Should -Match 'Remediate[\\/]Invoke-RemediationAction\.ps1'
        }

        It 'exports both functions when the module loads' {
            Import-Module $script:psm1 -Force -ErrorAction Stop
            try {
                $module = Get-Module -Name M365-Assess -ErrorAction Stop
                $module.ExportedFunctions.Keys | Should -Contain 'Get-RemediationCommand'
                $module.ExportedFunctions.Keys | Should -Contain 'Invoke-RemediationAction'
            }
            finally {
                Remove-Module -Name M365-Assess -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
