BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-MailboxPermission.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-mailbox-permission.ps1'

    function global:Get-EXOMailbox {
        param($Identity)
    }
    function global:Get-MailboxPermission {
        param($Identity)
    }
    function global:Get-RecipientPermission {
        param($Identity)
    }
    function global:Get-EXOMailboxFolderPermission {
        param($Identity)
    }
    function global:Add-MailboxPermission {
        param($Identity, $User, $AccessRights, $AutoMapping)
    }
    function global:Remove-MailboxPermission {
        param($Identity, $User, $AccessRights)
    }
    function global:Add-RecipientPermission {
        param($Identity, $Trustee, $AccessRights)
    }
    function global:Remove-RecipientPermission {
        param($Identity, $Trustee, $AccessRights)
    }
    function global:Add-MailboxFolderPermission {
        param($Identity, $User, $AccessRights)
    }
    function global:Set-MailboxFolderPermission {
        param($Identity, $User, $AccessRights)
    }
    function global:Remove-MailboxFolderPermission {
        param($Identity, $User)
    }
    function global:Set-Mailbox {
        param($Identity)
    }

    . $script:worker
}

Describe 'Set-MailboxPermission worker (T-0384)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-SetMailboxPermission -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SetMailboxPermissionJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-MailboxPermissionInput -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-MailboxPermissionBefore -CommandType Function) | Should -Not -BeNullOrEmpty
        }
    }

    Context 'permission input validation' {
        It 'accepts a valid mailbox grant' {
            $errors = @(Test-MailboxPermissionInput -Scope 'mailbox' -PermissionType 'FullAccess' -Principal 'delegate')
            $errors | Should -BeNullOrEmpty
        }

        It 'accepts a valid calendar grant' {
            $errors = @(Test-MailboxPermissionInput -Scope 'calendar' -Principal 'delegate' -AccessRights @('Reviewer'))
            $errors | Should -BeNullOrEmpty
        }

        It 'rejects a missing principal' {
            $errors = @(Test-MailboxPermissionInput -Scope 'mailbox' -PermissionType 'FullAccess' -Principal '  ')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'principal is required'
        }

        It 'rejects an unknown mailbox permission type' {
            $errors = @(Test-MailboxPermissionInput -Scope 'mailbox' -PermissionType 'Owner' -Principal 'delegate')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'permissionType'
        }

        It 'rejects a calendar grant without access rights' {
            $errors = @(Test-MailboxPermissionInput -Scope 'calendar' -Principal 'delegate')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'accessRights'
        }
    }

    Context 'mailbox permission grant' {
        BeforeEach {
            Mock Get-EXOMailbox {
                param($Identity)
                return @{ PrimarySmtpAddress = 'shared@example.invalid'; GrantSendOnBehalfTo = @() }
            }
            Mock Get-MailboxPermission { return @() }
            Mock Add-MailboxPermission { return @{ Identity = 'mbx-1' } }
            Mock Remove-MailboxPermission { return $null }
        }

        It 'add with DryRun returns the effective change without writing' {
            $plan = Invoke-SetMailboxPermission -TenantId 'tenant-test' -Action 'add' -MailboxId 'mbx-1' -Scope 'mailbox' -PermissionType 'FullAccess' -Principal 'delegate' -DryRun $true
            $plan.action | Should -Be 'add'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.principal | Should -Be 'delegate'
            $plan.after['permissionType'] | Should -Be 'FullAccess'
            $plan.diff[0] | Should -Match 'FullAccess'
            Assert-MockCalled Add-MailboxPermission -Times 0
        }

        It 'add apply without confirmation is refused' {
            {
                Invoke-SetMailboxPermission -TenantId 'tenant-test' -Action 'add' -MailboxId 'mbx-1' -Scope 'mailbox' -PermissionType 'FullAccess' -Principal 'delegate' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Add-MailboxPermission -Times 0
        }

        It 'add apply captures before/after and produces an audit record' {
            $res = Invoke-SetMailboxPermission -TenantId 'tenant-test' -Action 'add' -MailboxId 'mbx-1' -Scope 'mailbox' -PermissionType 'FullAccess' -Principal 'delegate' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.plan.before | Should -BeNullOrEmpty
            $res.plan.after['principal'] | Should -Be 'delegate'
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'mailbox.permission.grant'
            $res.auditEvent.before | Should -BeNullOrEmpty
            $res.auditEvent.after['principal'] | Should -Be 'delegate'
            Assert-MockCalled Add-MailboxPermission -Times 1
        }

        It 'add with an invalid permission type throws before any write' {
            {
                Invoke-SetMailboxPermission -TenantId 'tenant-test' -Action 'add' -MailboxId 'mbx-1' -Scope 'mailbox' -PermissionType 'Owner' -Principal 'delegate' -DryRun $true
            } | Should -Throw '*ValidationFailed*'
            Assert-MockCalled Add-MailboxPermission -Times 0
        }
    }

    Context 'mailbox permission remove' {
        BeforeEach {
            Mock Get-EXOMailbox {
                param($Identity)
                return @{ PrimarySmtpAddress = 'shared@example.invalid'; GrantSendOnBehalfTo = @() }
            }
            Mock Get-MailboxPermission {
                return @(@{ User = 'delegate'; AccessRights = @('FullAccess'); AutoMapping = $true; IsInherited = $false })
            }
            Mock Remove-MailboxPermission { return $null }
            Mock Add-MailboxPermission { return $null }
        }

        It 'remove apply captures before/after and produces an audit record' {
            $res = Invoke-SetMailboxPermission -TenantId 'tenant-test' -Action 'remove' -MailboxId 'mbx-1' -Scope 'mailbox' -PermissionType 'FullAccess' -Principal 'delegate' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.plan.before['principal'] | Should -Be 'delegate'
            $res.plan.after | Should -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'mailbox.permission.remove'
            $res.auditEvent.before['principal'] | Should -Be 'delegate'
            $res.auditEvent.after | Should -BeNullOrEmpty
            Assert-MockCalled Remove-MailboxPermission -Times 1
        }

        It 'remove of a missing grant throws NotFound' {
            Mock Get-MailboxPermission { return @() }
            {
                Invoke-SetMailboxPermission -TenantId 'tenant-test' -Action 'remove' -MailboxId 'mbx-1' -Scope 'mailbox' -PermissionType 'FullAccess' -Principal 'nobody' -DryRun $true
            } | Should -Throw '*NotFound*'
            Assert-MockCalled Remove-MailboxPermission -Times 0
        }
    }

    Context 'calendar permission edit' {
        BeforeEach {
            Mock Get-EXOMailbox {
                param($Identity)
                return @{ PrimarySmtpAddress = 'shared@example.invalid'; GrantSendOnBehalfTo = @() }
            }
            Mock Get-EXOMailboxFolderPermission {
                return @(@{ User = 'delegate'; AccessRights = @('Reviewer') })
            }
            Mock Set-MailboxFolderPermission { return $null }
            Mock Add-MailboxFolderPermission { return $null }
        }

        It 'edit with DryRun shows the effective change without writing' {
            $plan = Invoke-SetMailboxPermission -TenantId 'tenant-test' -Action 'edit' -MailboxId 'mbx-1' -Scope 'calendar' -Principal 'delegate' -AccessRights @('Editor') -DryRun $true
            $plan.action | Should -Be 'edit'
            $plan.before['accessRights'] | Should -Be @('Reviewer')
            $plan.after['accessRights'] | Should -Be @('Editor')
            $plan.diff[0] | Should -Match 'calendar rights'
            Assert-MockCalled Set-MailboxFolderPermission -Times 0
        }

        It 'edit apply replaces the grant and audits before/after' {
            $res = Invoke-SetMailboxPermission -TenantId 'tenant-test' -Action 'edit' -MailboxId 'mbx-1' -Scope 'calendar' -Principal 'delegate' -AccessRights @('Editor') -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.auditEvent.action | Should -Be 'mailbox.permission.grant'
            $res.auditEvent.before['accessRights'] | Should -Be @('Reviewer')
            $res.auditEvent.after['accessRights'] | Should -Be @('Editor')
            Assert-MockCalled Set-MailboxFolderPermission -Times 1
        }
    }

    Context 'job envelope' {
        It 'reads tenant, mailbox, action, and grantee from the envelope' {
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('mailbox-permission-job-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    tenantId       = 'tenant-test'
                    action         = 'add'
                    mailboxId      = 'mbx-1'
                    scope          = 'mailbox'
                    permissionType = 'FullAccess'
                    principal      = 'delegate'
                    accessRights   = @()
                    automap        = $true
                    confirmed      = $true
                    dryRun         = $true
                } | ConvertTo-Json -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                $job = Read-SetMailboxPermissionJob -Path $jobPath
                $job['TenantId'] | Should -Be 'tenant-test'
                $job['MailboxId'] | Should -Be 'mbx-1'
                $job['Action'] | Should -Be 'add'
                $job['Principal'] | Should -Be 'delegate'
                $job['Confirmed'] | Should -BeTrue
                $job['DryRun'] | Should -BeTrue
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }

        It 'throws for a missing envelope' {
            {
                Read-SetMailboxPermissionJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'mailbox-permission-job-does-not-exist.json')
            } | Should -Throw '*job envelope not found*'
        }
    }
}
