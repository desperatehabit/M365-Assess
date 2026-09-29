BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-MailboxRule.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-mailbox-rule.ps1'

    function global:Get-InboxRule {
        param($Mailbox, $Identity)
    }
    function global:New-InboxRule {
        param($Mailbox, $Name, $ForwardTo, $ForwardAsAttachmentTo, $RedirectTo, $DeleteMessage, $Enabled, $Priority)
    }
    function global:Set-InboxRule {
        param($Identity, $Name, $Enabled, $Priority, $ForwardTo, $ForwardAsAttachmentTo, $RedirectTo, $DeleteMessage)
    }
    function global:Remove-InboxRule {
        param($Identity, $Confirm)
    }

    . $script:worker

    function script:New-ForwardingRuleMock {
        return @{
            Identity              = 'rule-1'
            Name                  = 'Forward cover'
            Enabled               = $true
            Priority              = 0
            ForwardTo             = 'smtp:cover@example.invalid'
            ForwardAsAttachmentTo = $null
            RedirectTo            = $null
            DeleteMessage         = $false
        }
    }

    function script:New-PlainRuleMock {
        return @{
            Identity              = 'rule-2'
            Name                  = 'File invoices'
            Enabled               = $true
            Priority              = 1
            ForwardTo             = $null
            ForwardAsAttachmentTo = $null
            RedirectTo            = $null
            DeleteMessage         = $false
        }
    }
}

Describe 'Set-MailboxRule worker (T-0385)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-SetMailboxRule -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SetMailboxRuleJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-MailboxRuleInput -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-MailboxRuleChangeSensitive -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-MailboxRuleSnapshot -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Find-MailboxRule -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'entrypoint connects EXO in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Set-MailboxRule\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-SetMailboxRuleJob -Path'
            $entrySource | Should -Match 'Invoke-SetMailboxRule @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'input validation' {
        It 'accepts a valid forwarding create' {
            $errors = @(Test-MailboxRuleInput -Action 'create' -MailboxId 'mbx-1' -Name 'Forward cover' -ForwardTo 'smtp:cover@example.invalid')
            $errors | Should -BeNullOrEmpty
        }

        It 'rejects a create without a rule name' {
            $errors = @(Test-MailboxRuleInput -Action 'create' -MailboxId 'mbx-1')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'name is required'
        }

        It 'rejects edit and delete without a rule id' {
            $errors = @(Test-MailboxRuleInput -Action 'edit' -MailboxId 'mbx-1' -Name 'New name')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'ruleId is required'
            $errors = @(Test-MailboxRuleInput -Action 'delete' -MailboxId 'mbx-1')
            $errors | Should -Not -BeNullOrEmpty
        }

        It 'rejects an edit with no field to change' {
            $errors = @(Test-MailboxRuleInput -Action 'edit' -MailboxId 'mbx-1' -RuleId 'rule-1')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'at least one rule field'
        }

        It 'rejects a missing mailbox id and a negative priority' {
            $errors = @(Test-MailboxRuleInput -Action 'create' -Name 'Forward cover')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'mailboxId is required'
            $errors = @(Test-MailboxRuleInput -Action 'edit' -MailboxId 'mbx-1' -RuleId 'rule-1' -Priority -1)
            $errors | Should -Not -BeNullOrEmpty
        }
    }

    Context 'forwarding sensitivity classification' {
        It 'flags a forwarding-enabling create with the warning path' {
            $guard = Test-MailboxRuleChangeSensitive -Action 'create' -After @{ forwardTo = 'smtp:cover@example.invalid'; deleteMessage = $false }
            $guard.securitySensitive | Should -BeTrue
            $guard.requiresConfirmation | Should -BeTrue
            $guard.warning | Should -Match 'security-sensitive'
            $guard.reasons | Should -Not -BeNullOrEmpty
        }

        It 'leaves a plain create off the warning path' {
            $guard = Test-MailboxRuleChangeSensitive -Action 'create' -After @{ forwardTo = ''; deleteMessage = $false }
            $guard.securitySensitive | Should -BeFalse
            $guard.requiresConfirmation | Should -BeFalse
        }

        It 'flags an edit that enables forwarding' {
            $guard = Test-MailboxRuleChangeSensitive -Action 'edit' `
                -Before @{ enabled = $true; forwardTo = $null; deleteMessage = $false } `
                -After @{ enabled = $true; forwardTo = 'smtp:cover@example.invalid'; deleteMessage = $false }
            $guard.securitySensitive | Should -BeTrue
            $guard.warning | Should -Match 'security-sensitive'
        }

        It 'flags removal of a rule that forwarded mail' {
            $guard = Test-MailboxRuleChangeSensitive -Action 'delete' -Before @{ forwardTo = 'smtp:cover@example.invalid'; deleteMessage = $false }
            $guard.securitySensitive | Should -BeTrue
            $guard.warning | Should -Match 'security-sensitive'
        }

        It 'leaves a non-forwarding edit off the warning path' {
            $guard = Test-MailboxRuleChangeSensitive -Action 'edit' `
                -Before @{ enabled = $true; forwardTo = $null; deleteMessage = $false } `
                -After @{ enabled = $false; forwardTo = $null; deleteMessage = $false }
            $guard.securitySensitive | Should -BeFalse
        }
    }

    Context 'rule create' {
        BeforeEach {
            Mock New-InboxRule {
                param($Mailbox, $Name, $ForwardTo, $ForwardAsAttachmentTo, $RedirectTo, $DeleteMessage, $Enabled, $Priority)
                return @{ Identity = 'rule-new'; Name = $Name }
            }
            Mock Get-InboxRule {
                param($Mailbox, $Identity)
                return @()
            }
        }

        It 'create with DryRun returns a security-sensitive plan preview without calling New-InboxRule' {
            $plan = Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'create' -MailboxId 'mbx-1' -Name 'Forward cover' -ForwardTo 'smtp:cover@example.invalid' -DryRun $true
            $plan.action | Should -Be 'create'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.targetName | Should -Be 'Forward cover'
            $plan.before | Should -BeNullOrEmpty
            $plan.after['forwardTo'] | Should -Be 'smtp:cover@example.invalid'
            $plan.securitySensitive | Should -BeTrue
            $plan.requiresConfirmation | Should -BeTrue
            $plan.warning | Should -Match 'security-sensitive'
            $plan.diff | Should -Not -BeNullOrEmpty
            Assert-MockCalled New-InboxRule -Times 0
        }

        It 'create apply without confirmation is refused' {
            {
                Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'create' -MailboxId 'mbx-1' -Name 'Forward cover' -ForwardTo 'smtp:cover@example.invalid' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled New-InboxRule -Times 0
        }

        It 'create apply with confirmation calls New-InboxRule and produces an audit record' {
            $res = Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'create' -MailboxId 'mbx-1' -Name 'Forward cover' -ForwardTo 'smtp:cover@example.invalid' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.result['id'] | Should -Be 'rule-new'
            $res.plan.before | Should -BeNullOrEmpty
            $res.plan.after['forwardTo'] | Should -Be 'smtp:cover@example.invalid'
            $res.plan.securitySensitive | Should -BeTrue
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'mailbox.rule.create'
            $res.auditEvent.targetId | Should -Be 'rule-new'
            $res.auditEvent.before | Should -BeNullOrEmpty
            $res.auditEvent.after['forwardTo'] | Should -Be 'smtp:cover@example.invalid'
            Assert-MockCalled New-InboxRule -Times 1
        }

        It 'create with a missing name throws before any write' {
            {
                Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'create' -MailboxId 'mbx-1' -DryRun $true
            } | Should -Throw '*ValidationFailed*'
            Assert-MockCalled New-InboxRule -Times 0
        }
    }

    Context 'rule edit' {
        BeforeEach {
            Mock Get-InboxRule {
                param($Mailbox, $Identity)
                return @((script:New-PlainRuleMock))
            }
            Mock Set-InboxRule {
                param($Identity, $Name, $Enabled, $Priority, $ForwardTo, $ForwardAsAttachmentTo, $RedirectTo, $DeleteMessage)
                return @{ Identity = $Identity }
            }
        }

        It 'edit with DryRun returns a diff against the current rule without writing' {
            $plan = Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'edit' -MailboxId 'mbx-1' -RuleId 'rule-2' -RedirectTo 'smtp:r@example.invalid' -DryRun $true
            $plan.action | Should -Be 'edit'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.before['name'] | Should -Be 'File invoices'
            $plan.after['redirectTo'] | Should -Be 'smtp:r@example.invalid'
            $plan.securitySensitive | Should -BeTrue
            $plan.warning | Should -Match 'security-sensitive'
            $plan.diff | Should -Not -BeNullOrEmpty
            Assert-MockCalled Set-InboxRule -Times 0
        }

        It 'edit that changes nothing is a structured no-op with no write' {
            $res = Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'edit' -MailboxId 'mbx-1' -RuleId 'rule-2' -Name 'File invoices' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.noop | Should -BeTrue
            $res.result['noop'] | Should -BeTrue
            $res.plan.before['name'] | Should -Be 'File invoices'
            $res.plan.after['name'] | Should -Be 'File invoices'
            Assert-MockCalled Set-InboxRule -Times 0
        }

        It 'edit apply without confirmation is refused' {
            {
                Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'edit' -MailboxId 'mbx-1' -RuleId 'rule-2' -Name 'Renamed' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Set-InboxRule -Times 0
        }

        It 'edit apply captures before/after and produces an audit record' {
            $res = Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'edit' -MailboxId 'mbx-1' -RuleId 'rule-2' -Name 'Renamed' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.noop | Should -BeNullOrEmpty
            $res.plan.before['name'] | Should -Be 'File invoices'
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'mailbox.rule.edit'
            $res.auditEvent.targetId | Should -Be 'rule-2'
            $res.auditEvent.before['name'] | Should -Be 'File invoices'
            Assert-MockCalled Set-InboxRule -Times 1 -ParameterFilter { $Identity -eq 'rule-2' }
        }

        It 'edit of an unknown rule throws NotFound' {
            Mock Get-InboxRule { param($Mailbox, $Identity) return @() }
            {
                Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'edit' -MailboxId 'mbx-1' -RuleId 'rule-missing' -Name 'Renamed' -DryRun $true
            } | Should -Throw '*NotFound*'
            Assert-MockCalled Set-InboxRule -Times 0
        }
    }

    Context 'rule delete' {
        BeforeEach {
            Mock Get-InboxRule {
                param($Mailbox, $Identity)
                return @((script:New-ForwardingRuleMock))
            }
            Mock Remove-InboxRule {
                param($Identity, $Confirm)
                return $true
            }
        }

        It 'delete with DryRun returns a security-sensitive plan without calling Remove-InboxRule' {
            $plan = Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'delete' -MailboxId 'mbx-1' -RuleId 'rule-1' -DryRun $true
            $plan.action | Should -Be 'delete'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.before['name'] | Should -Be 'Forward cover'
            $plan.after | Should -BeNullOrEmpty
            $plan.securitySensitive | Should -BeTrue
            $plan.warning | Should -Match 'security-sensitive'
            Assert-MockCalled Remove-InboxRule -Times 0
        }

        It 'delete apply without confirmation is refused' {
            {
                Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'delete' -MailboxId 'mbx-1' -RuleId 'rule-1' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Remove-InboxRule -Times 0
        }

        It 'delete apply removes the rule and produces an audit record' {
            $res = Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'delete' -MailboxId 'mbx-1' -RuleId 'rule-1' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.result['deleted'] | Should -BeTrue
            $res.plan.before['forwardTo'] | Should -Be 'smtp:cover@example.invalid'
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'mailbox.rule.delete'
            $res.auditEvent.targetId | Should -Be 'rule-1'
            $res.auditEvent.before['name'] | Should -Be 'Forward cover'
            $res.auditEvent.after | Should -BeNullOrEmpty
            Assert-MockCalled Remove-InboxRule -Times 1 -ParameterFilter { $Identity -eq 'rule-1' }
        }

        It 'delete of an unknown rule throws NotFound' {
            Mock Get-InboxRule { param($Mailbox, $Identity) return @() }
            {
                Invoke-SetMailboxRule -TenantId 'tenant-test' -Action 'delete' -MailboxId 'mbx-1' -RuleId 'rule-missing' -DryRun $true
            } | Should -Throw '*NotFound*'
            Assert-MockCalled Remove-InboxRule -Times 0
        }
    }

    Context 'job envelope' {
        It 'reads tenant, action, mailbox, rule, and flags from the envelope' {
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('mailbox-rule-job-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    tenantId   = 'tenant-test'
                    action     = 'edit'
                    mailboxId  = 'mbx-1'
                    ruleId     = 'rule-1'
                    name       = 'Forward cover'
                    enabled    = $true
                    priority   = 0
                    forwardTo  = 'smtp:cover@example.invalid'
                    confirmed  = $true
                    dryRun     = $true
                } | ConvertTo-Json -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                $job = Read-SetMailboxRuleJob -Path $jobPath
                $job['TenantId'] | Should -Be 'tenant-test'
                $job['Action'] | Should -Be 'edit'
                $job['MailboxId'] | Should -Be 'mbx-1'
                $job['RuleId'] | Should -Be 'rule-1'
                $job['ForwardTo'] | Should -Be 'smtp:cover@example.invalid'
                $job['Confirmed'] | Should -BeTrue
                $job['DryRun'] | Should -BeTrue
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }

        It 'throws for a missing envelope and for envelopes missing tenant, action, or mailbox' {
            {
                Read-SetMailboxRuleJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'mailbox-rule-job-does-not-exist.json')
            } | Should -Throw '*job envelope not found*'
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('mailbox-rule-job-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{ tenantId = 'tenant-test'; action = 'edit' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                { Read-SetMailboxRuleJob -Path $jobPath } | Should -Throw '*mailboxId*'
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
