BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-Mailbox.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-mailbox.ps1'

    function global:Get-EXOMailbox {
        param($Identity)
    }
    function global:New-Mailbox {
        param($Shared, $Name, $DisplayName, $Alias, $PrimarySmtpAddress)
    }
    function global:Set-Mailbox {
        param($Identity, $Type)
    }

    . $script:worker
}

Describe 'Set-Mailbox worker (T-0382)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-SetMailbox -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SetMailboxJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-SharedMailboxCreateInput -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-SetMailboxAlias -CommandType Function) | Should -Not -BeNullOrEmpty
        }
    }

    Context 'create input validation' {
        It 'accepts a valid create' {
            $errors = @(Test-SharedMailboxCreateInput -DisplayName 'Support Desk' -Alias 'support' -PrimarySmtpAddress 'support@example.invalid')
            $errors | Should -BeNullOrEmpty
        }

        It 'rejects a missing display name' {
            $errors = @(Test-SharedMailboxCreateInput -DisplayName '  ')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'displayName is required'
        }

        It 'rejects aliases with characters EXO rejects' {
            $errors = @(Test-SharedMailboxCreateInput -DisplayName 'Support Desk' -Alias 'not an alias!')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'alias'
        }

        It 'rejects a malformed primary SMTP address' {
            $errors = @(Test-SharedMailboxCreateInput -DisplayName 'Support Desk' -PrimarySmtpAddress 'not-an-address')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'primarySmtpAddress'
        }

        It 'derives an alias from the display name' {
            Get-SetMailboxAlias -DisplayName 'Support Desk' | Should -Be 'supportdesk'
        }
    }

    Context 'shared-mailbox create' {
        BeforeEach {
            Mock New-Mailbox {
                param($Shared, $Name, $DisplayName, $Alias, $PrimarySmtpAddress)
                return @{
                    ExchangeObjectId   = 'mbx-new'
                    DisplayName        = $DisplayName
                    Alias              = $Alias
                    PrimarySmtpAddress = 'support@example.invalid'
                }
            }
        }

        It 'create with DryRun returns a plan preview without calling New-Mailbox' {
            $plan = Invoke-SetMailbox -TenantId 'tenant-test' -Action 'create' -DisplayName 'Support Desk' -DryRun $true
            $plan.action | Should -Be 'create'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.targetName | Should -Be 'Support Desk'
            $plan.before | Should -BeNullOrEmpty
            $plan.after['type'] | Should -Be 'shared'
            $plan.diff | Should -Not -BeNullOrEmpty
            Assert-MockCalled New-Mailbox -Times 0
        }

        It 'create apply without confirmation is refused' {
            {
                Invoke-SetMailbox -TenantId 'tenant-test' -Action 'create' -DisplayName 'Support Desk' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled New-Mailbox -Times 0
        }

        It 'create apply with confirmation calls New-Mailbox and produces an audit record' {
            $res = Invoke-SetMailbox -TenantId 'tenant-test' -Action 'create' -DisplayName 'Support Desk' -Alias 'support' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.result['type'] | Should -Be 'shared'
            $res.result['id'] | Should -Be 'mbx-new'
            $res.plan.before | Should -BeNullOrEmpty
            $res.plan.after['type'] | Should -Be 'shared'
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'mailbox.create'
            $res.auditEvent.targetId | Should -Be 'mbx-new'
            $res.auditEvent.before | Should -BeNullOrEmpty
            $res.auditEvent.after['type'] | Should -Be 'shared'
            Assert-MockCalled New-Mailbox -Times 1
        }

        It 'create with an invalid alias throws before any write' {
            {
                Invoke-SetMailbox -TenantId 'tenant-test' -Action 'create' -DisplayName 'Support Desk' -Alias 'not an alias!' -DryRun $true
            } | Should -Throw '*ValidationFailed*'
            Assert-MockCalled New-Mailbox -Times 0
        }
    }

    Context 'convert to shared' {
        BeforeEach {
            Mock Get-EXOMailbox {
                param($Identity)
                if ($Identity -eq 'mbx-1') {
                    return @{
                        ExchangeObjectId     = 'mbx-1'
                        DisplayName          = 'Support Desk'
                        PrimarySmtpAddress   = 'support@example.invalid'
                        RecipientTypeDetails = 'SharedMailbox'
                    }
                }
                if ($Identity -eq 'mbx-2') {
                    return @{
                        ExchangeObjectId     = 'mbx-2'
                        DisplayName          = 'Operator One'
                        PrimarySmtpAddress   = 'operator.one@example.invalid'
                        RecipientTypeDetails = 'UserMailbox'
                    }
                }
                return $null
            }
            Mock Set-Mailbox {
                param($Identity, $Type)
                return @{ Identity = $Identity }
            }
        }

        It 'convert with DryRun returns a diff against the current mailbox without writing' {
            $plan = Invoke-SetMailbox -TenantId 'tenant-test' -Action 'convert' -MailboxId 'mbx-2' -DryRun $true
            $plan.action | Should -Be 'convert'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.before['type'] | Should -Be 'user'
            $plan.after['type'] | Should -Be 'shared'
            $plan.diff[0] | Should -Match 'from user to shared'
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'convert of an already-shared mailbox is a structured no-op with no write' {
            $res = Invoke-SetMailbox -TenantId 'tenant-test' -Action 'convert' -MailboxId 'mbx-1' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.noop | Should -BeTrue
            $res.result['noop'] | Should -BeTrue
            $res.plan.before['type'] | Should -Be 'shared'
            $res.plan.after['type'] | Should -Be 'shared'
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'convert apply without confirmation is refused' {
            {
                Invoke-SetMailbox -TenantId 'tenant-test' -Action 'convert' -MailboxId 'mbx-2' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'convert apply captures before/after and produces an audit record' {
            $res = Invoke-SetMailbox -TenantId 'tenant-test' -Action 'convert' -MailboxId 'mbx-2' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.noop | Should -BeNullOrEmpty
            $res.result['type'] | Should -Be 'shared'
            $res.plan.before['type'] | Should -Be 'user'
            $res.plan.after['type'] | Should -Be 'shared'
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'mailbox.convert'
            $res.auditEvent.targetId | Should -Be 'mbx-2'
            $res.auditEvent.before['type'] | Should -Be 'user'
            $res.auditEvent.after['type'] | Should -Be 'shared'
            Assert-MockCalled Set-Mailbox -Times 1 -ParameterFilter { $Type -eq 'Shared' }
        }

        It 'convert of an unknown mailbox throws NotFound' {
            {
                Invoke-SetMailbox -TenantId 'tenant-test' -Action 'convert' -MailboxId 'mbx-missing' -DryRun $true
            } | Should -Throw '*NotFound*'
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'convert without a mailbox id throws ValidationFailed' {
            {
                Invoke-SetMailbox -TenantId 'tenant-test' -Action 'convert' -DryRun $true
            } | Should -Throw '*ValidationFailed*'
        }
    }

    Context 'job envelope' {
        It 'reads tenant, action, and flags from the envelope' {
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('mailbox-job-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    tenantId           = 'tenant-test'
                    action             = 'convert'
                    mailboxId          = 'mbx-2'
                    displayName        = ''
                    alias              = ''
                    primarySmtpAddress = ''
                    confirmed          = $true
                    dryRun             = $true
                } | ConvertTo-Json -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                $job = Read-SetMailboxJob -Path $jobPath
                $job['TenantId'] | Should -Be 'tenant-test'
                $job['Action'] | Should -Be 'convert'
                $job['MailboxId'] | Should -Be 'mbx-2'
                $job['Confirmed'] | Should -BeTrue
                $job['DryRun'] | Should -BeTrue
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }

        It 'throws for a missing envelope' {
            {
                Read-SetMailboxJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'mailbox-job-does-not-exist.json')
            } | Should -Throw '*job envelope not found*'
        }
    }
}
