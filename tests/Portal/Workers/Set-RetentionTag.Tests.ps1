BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-RetentionTag.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-retention-tag.ps1'

    function global:Get-EXOMailbox {
        param($Identity)
    }
    function global:Set-Mailbox {
        param($Identity, $RetentionPolicy)
    }

    . $script:worker
}

Describe 'Set-RetentionTag worker (T-0387)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-SetRetentionTag -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SetRetentionTagJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-SetRetentionTagAssignInput -CommandType Function) | Should -Not -BeNullOrEmpty
        }
    }

    Context 'assign input validation' {
        It 'accepts a valid assign' {
            $errors = @(Test-SetRetentionTagAssignInput -TagId 'tag-1' -MailboxIds @('mbx-2'))
            $errors | Should -BeNullOrEmpty
        }

        It 'rejects a missing tag id' {
            $errors = @(Test-SetRetentionTagAssignInput -TagId '  ' -MailboxIds @('mbx-2'))
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'tagId is required'
        }

        It 'rejects a missing mailbox identity' {
            $errors = @(Test-SetRetentionTagAssignInput -TagId 'tag-1' -MailboxIds @())
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'mailboxId is required'
        }
    }

    Context 'single assign' {
        BeforeEach {
            Mock Get-EXOMailbox {
                param($Identity)
                if ($Identity -eq 'mbx-1') {
                    return @{
                        ExchangeObjectId = 'mbx-1'
                        DisplayName      = 'Support Desk'
                        RetentionPolicy  = 'tag-1'
                    }
                }
                if ($Identity -eq 'mbx-2') {
                    return @{
                        ExchangeObjectId = 'mbx-2'
                        DisplayName      = 'Operator One'
                        RetentionPolicy  = ''
                    }
                }
                return $null
            }
            Mock Set-Mailbox {
                param($Identity, $RetentionPolicy)
                return @{ Identity = $Identity }
            }
        }

        It 'assign with DryRun returns a plan preview listing the affected mailbox without writing' {
            $plan = Invoke-SetRetentionTag -TenantId 'tenant-test' -Action 'assign' -TagId 'tag-1' -MailboxId 'mbx-2' -DryRun $true
            $plan.action | Should -Be 'assign'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.tagId | Should -Be 'tag-1'
            $plan.affectedMailboxes | Should -Be @('mbx-2')
            $plan.before['retentionPolicy'] | Should -Be ''
            $plan.after['retentionTag'] | Should -Be 'tag-1'
            $plan.diff | Should -Not -BeNullOrEmpty
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'assign apply without confirmation is refused' {
            {
                Invoke-SetRetentionTag -TenantId 'tenant-test' -Action 'assign' -TagId 'tag-1' -MailboxId 'mbx-2' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'assign apply captures before/after and produces a mailbox operation plus an audit record' {
            $res = Invoke-SetRetentionTag -TenantId 'tenant-test' -Action 'assign' -TagId 'tag-1' -MailboxId 'mbx-2' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.noop | Should -BeNullOrEmpty
            $res.result['tagId'] | Should -Be 'tag-1'
            $res.plan.affectedMailboxes | Should -Be @('mbx-2')
            $res.plan.before['retentionPolicy'] | Should -Be ''
            $res.plan.after['retentionTag'] | Should -Be 'tag-1'
            $res.mailboxOperation | Should -Not -BeNullOrEmpty
            $res.mailboxOperation.operation | Should -Be 'retention.assign'
            $res.mailboxOperation.state | Should -Be 'applied'
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'retention.assign'
            $res.auditEvent.targetId | Should -Be 'mbx-2'
            $res.auditEvent.before['retentionPolicy'] | Should -Be ''
            $res.auditEvent.after['retentionTag'] | Should -Be 'tag-1'
            Assert-MockCalled Set-Mailbox -Times 1 -ParameterFilter { $RetentionPolicy -eq 'tag-1' }
        }

        It 'assign of a mailbox that already carries the tag is a structured no-op with no write' {
            $res = Invoke-SetRetentionTag -TenantId 'tenant-test' -Action 'assign' -TagId 'tag-1' -MailboxId 'mbx-1' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.noop | Should -BeTrue
            $res.mailboxOperation.state | Should -Be 'noop'
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'assign of an unknown mailbox throws NotFound' {
            {
                Invoke-SetRetentionTag -TenantId 'tenant-test' -Action 'assign' -TagId 'tag-1' -MailboxId 'mbx-missing' -DryRun $true
            } | Should -Throw '*NotFound*'
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'assign without a mailbox id throws ValidationFailed' {
            {
                Invoke-SetRetentionTag -TenantId 'tenant-test' -Action 'assign' -TagId 'tag-1' -DryRun $true
            } | Should -Throw '*ValidationFailed*'
        }
    }

    Context 'bulk assign' {
        BeforeEach {
            Mock Get-EXOMailbox {
                param($Identity)
                if ($Identity -eq 'mbx-1') {
                    return @{
                        ExchangeObjectId = 'mbx-1'
                        DisplayName      = 'Support Desk'
                        RetentionPolicy  = 'tag-1'
                    }
                }
                return @{
                    ExchangeObjectId = $Identity
                    DisplayName      = "Mailbox $Identity"
                    RetentionPolicy  = ''
                }
            }
            Mock Set-Mailbox {
                param($Identity, $RetentionPolicy)
                return @{ Identity = $Identity }
            }
        }

        It 'bulk assign with DryRun lists every affected mailbox without writing' {
            $plan = Invoke-SetRetentionTag -TenantId 'tenant-test' -Action 'assignBulk' -TagId 'tag-1' -MailboxIds @('mbx-1', 'mbx-2') -DryRun $true
            $plan.action | Should -Be 'assignBulk'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.affectedMailboxes | Should -Be @('mbx-1', 'mbx-2')
            $plan.diff.Count | Should -Be 2
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'bulk assign apply writes only mailboxes missing the tag and records per-row results' {
            $res = Invoke-SetRetentionTag -TenantId 'tenant-test' -Action 'assignBulk' -TagId 'tag-1' -MailboxIds @('mbx-1', 'mbx-2') -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.plan.affectedMailboxes | Should -Be @('mbx-1', 'mbx-2')
            $res.results.Count | Should -Be 2
            @($res.results | Where-Object { $_['mailboxId'] -eq 'mbx-2' })[0]['status'] | Should -Be 'assigned'
            @($res.results | Where-Object { $_['mailboxId'] -eq 'mbx-1' })[0]['status'] | Should -Be 'skipped'
            $res.mailboxOperations.Count | Should -Be 2
            $res.auditEvents.Count | Should -Be 1
            $res.auditEvents[0]['action'] | Should -Be 'retention.assign'
            $res.auditEvents[0]['targetId'] | Should -Be 'mbx-2'
            Assert-MockCalled Set-Mailbox -Times 1
        }

        It 'bulk assign apply without confirmation is refused' {
            {
                Invoke-SetRetentionTag -TenantId 'tenant-test' -Action 'assignBulk' -TagId 'tag-1' -MailboxIds @('mbx-2') -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Set-Mailbox -Times 0
        }
    }

    Context 'job envelope' {
        It 'reads tenant, action, tag, and flags from the envelope' {
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('retention-job-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    tenantId   = 'tenant-test'
                    action     = 'assignBulk'
                    tagId      = 'tag-1'
                    policyId   = ''
                    mailboxId  = ''
                    mailboxIds = @('mbx-1', 'mbx-2')
                    confirmed  = $true
                    dryRun     = $true
                } | ConvertTo-Json -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                $job = Read-SetRetentionTagJob -Path $jobPath
                $job['TenantId'] | Should -Be 'tenant-test'
                $job['Action'] | Should -Be 'assignBulk'
                $job['TagId'] | Should -Be 'tag-1'
                $job['MailboxIds'] | Should -Be @('mbx-1', 'mbx-2')
                $job['Confirmed'] | Should -BeTrue
                $job['DryRun'] | Should -BeTrue
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }

        It 'throws for a missing envelope' {
            {
                Read-SetRetentionTagJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'retention-job-does-not-exist.json')
            } | Should -Throw '*job envelope not found*'
        }
    }
}
