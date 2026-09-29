BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-MailboxSettings.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-mailbox-settings.ps1'

    function global:Get-EXOMailbox {
        param($Identity)
    }
    function global:Set-Mailbox {
        param($Identity)
    }
    function global:Enable-Mailbox {
        param($Identity, [switch]$Archive)
    }
    function global:Set-MailboxRegionalConfiguration {
        param($Identity, $Language)
    }
    function global:Get-CalendarProcessing {
        param($Identity)
    }
    function global:Set-CalendarProcessing {
        param($Identity)
    }

    . $script:worker
}

Describe 'Set-MailboxSettings worker (T-0383)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-SetMailboxSettings -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SetMailboxSettingsJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-MailboxSettingsInput -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Compare-MailboxSettings -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-MailboxSettingsConfirmation -CommandType Function) | Should -Not -BeNullOrEmpty
        }
    }

    Context 'settings input validation' {
        It 'accepts quota, archive, hold, locale, limits, calendar, and GAL settings' {
            $errors = @(Test-MailboxSettingsInput -Settings @{
                prohibitSendQuota              = '50 GB'
                archiveEnabled                 = $true
                litigationHoldEnabled          = $true
                retentionHoldEnabled           = $false
                locale                         = 'en-US'
                maxRecipientsPerMessage        = 500
                calendarAutomateProcessing     = 'AutoUpdate'
                hiddenFromAddressListsEnabled = $true
            })
            $errors | Should -BeNullOrEmpty
        }

        It 'rejects unknown settings' {
            $errors = @(Test-MailboxSettingsInput -Settings @{ forwardingTo = 'smtp:cover@example.invalid' })
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'unknown mailbox setting'
        }

        It 'rejects an empty settings object' {
            $errors = @(Test-MailboxSettingsInput -Settings @{})
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'at least one mailbox setting'
        }

        It 'rejects a malformed quota' {
            $errors = @(Test-MailboxSettingsInput -Settings @{ prohibitSendQuota = 'huge' })
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'prohibitSendQuota'
        }

        It 'rejects a malformed locale and calendar mode' {
            $errors = @(Test-MailboxSettingsInput -Settings @{ locale = 'english' })
            $errors | Should -Not -BeNullOrEmpty
            $errors = @(Test-MailboxSettingsInput -Settings @{ calendarAutomateProcessing = 'Always' })
            $errors | Should -Not -BeNullOrEmpty
        }

        It 'flags archive enable and hold changes as requiring confirmation' {
            Test-MailboxSettingsConfirmation -Settings @{ archiveEnabled = $true } | Should -BeTrue
            Test-MailboxSettingsConfirmation -Settings @{ autoExpandingArchiveEnabled = $true } | Should -BeTrue
            Test-MailboxSettingsConfirmation -Settings @{ litigationHoldEnabled = $false } | Should -BeTrue
            Test-MailboxSettingsConfirmation -Settings @{ retentionHoldEnabled = $true } | Should -BeTrue
            Test-MailboxSettingsConfirmation -Settings @{ prohibitSendQuota = '50 GB' } | Should -BeFalse
            Test-MailboxSettingsConfirmation -Settings @{ hiddenFromAddressListsEnabled = $true } | Should -BeFalse
        }
    }

    Context 'settings plan preview' {
        BeforeEach {
            $script:exoReads = 0
            Mock Get-EXOMailbox {
                param($Identity)
                $script:exoReads++
                $sendQuota = '49 GB (52613349376 bytes)'
                if ($script:exoReads -gt 1) {
                    $sendQuota = '50 GB (53687091200 bytes)'
                }
                return @{
                    ExchangeObjectId                = 'mbx-2'
                    DisplayName                     = 'Operator One'
                    IssueWarningQuota               = '49 GB (52613349376 bytes)'
                    ProhibitSendQuota               = $sendQuota
                    ProhibitSendReceiveQuota        = '50 GB (53687091200 bytes)'
                    ArchiveStatus                   = 'None'
                    ArchiveGuid                     = '00000000-0000-0000-0000-000000000000'
                    AutoExpandingArchiveEnabled     = $false
                    LitigationHoldEnabled           = $false
                    LitigationHoldDuration          = $null
                    RetentionHoldEnabled            = $false
                    MaxSendSize                     = '35 MB (36700160 bytes)'
                    MaxReceiveSize                  = '36 MB (37748736 bytes)'
                    RecipientLimits                 = 500
                    HiddenFromAddressListsEnabled   = $false
                }
            }
            Mock Get-CalendarProcessing {
                param($Identity)
                return @{ AutomateProcessing = 'AutoUpdate'; AllowConflicts = $false }
            }
            Mock Set-Mailbox { param($Identity) return $null }
            Mock Enable-Mailbox { param($Identity, [switch]$Archive) return $null }
            Mock Set-MailboxRegionalConfiguration { param($Identity, $Language) return $null }
            Mock Set-CalendarProcessing { param($Identity) return $null }
        }

        It 'DryRun returns a diff without writing' {
            $plan = Invoke-SetMailboxSettings -TenantId 'tenant-test' -MailboxId 'mbx-2' -Settings @{ prohibitSendQuota = '50 GB' } -DryRun $true
            $plan.action | Should -Be 'settings'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.before['prohibitSendQuota'] | Should -Match '49 GB'
            $plan.after['prohibitSendQuota'] | Should -Be '50 GB'
            $plan.diff | Should -Not -BeNullOrEmpty
            $plan.requiresConfirmation | Should -BeFalse
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'DryRun of an archive enable flags confirmation' {
            $plan = Invoke-SetMailboxSettings -TenantId 'tenant-test' -MailboxId 'mbx-2' -Settings @{ archiveEnabled = $true } -DryRun $true
            $plan.requiresConfirmation | Should -BeTrue
            $plan.diff[0] | Should -Match 'archiveEnabled'
            Assert-MockCalled Enable-Mailbox -Times 0
        }

        It 'matching settings are a structured no-op with no write' {
            $res = Invoke-SetMailboxSettings -TenantId 'tenant-test' -MailboxId 'mbx-2' -Settings @{ maxRecipientsPerMessage = 500 } -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.noop | Should -BeTrue
            Assert-MockCalled Set-Mailbox -Times 0
            Assert-MockCalled Enable-Mailbox -Times 0
            Assert-MockCalled Set-CalendarProcessing -Times 0
        }

        It 'apply without confirmation is refused' {
            {
                Invoke-SetMailboxSettings -TenantId 'tenant-test' -MailboxId 'mbx-2' -Settings @{ prohibitSendQuota = '50 GB' } -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'quota, hold, locale, limits, calendar, and GAL apply with before/after, an operation, and an audit record' {
            $res = Invoke-SetMailboxSettings -TenantId 'tenant-test' -MailboxId 'mbx-2' -Settings @{
                prohibitSendQuota              = '50 GB'
                locale                         = 'en-US'
                maxRecipientsPerMessage        = 400
                calendarAllowConflicts         = $true
                hiddenFromAddressListsEnabled = $true
            } -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.noop | Should -BeNullOrEmpty
            $res.plan.before['prohibitSendQuota'] | Should -Match '49 GB'
            $res.plan.after['prohibitSendQuota'] | Should -Match '50 GB'
            $res.operation | Should -Not -BeNullOrEmpty
            $res.operation.operation | Should -Be 'mailbox.settings'
            $res.operation.state | Should -Be 'applied'
            $res.operation.before['prohibitSendQuota'] | Should -Match '49 GB'
            $res.operation.after['prohibitSendQuota'] | Should -Match '50 GB'
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'mailbox.settings'
            $res.auditEvent.targetId | Should -Be 'mbx-2'
            $res.auditEvent.before['prohibitSendQuota'] | Should -Match '49 GB'
            $res.auditEvent.after['prohibitSendQuota'] | Should -Match '50 GB'
            Assert-MockCalled Set-Mailbox -Times 1
            Assert-MockCalled Set-MailboxRegionalConfiguration -Times 1
            Assert-MockCalled Set-CalendarProcessing -Times 1
        }

        It 'archive enable calls Enable-Mailbox' {
            $res = Invoke-SetMailboxSettings -TenantId 'tenant-test' -MailboxId 'mbx-2' -Settings @{ archiveEnabled = $true } -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.plan.requiresConfirmation | Should -BeTrue
            Assert-MockCalled Enable-Mailbox -Times 1
        }

        It 'an unknown mailbox throws NotFound' {
            Mock Get-EXOMailbox { param($Identity) return $null }
            {
                Invoke-SetMailboxSettings -TenantId 'tenant-test' -MailboxId 'mbx-missing' -Settings @{ prohibitSendQuota = '50 GB' } -DryRun $true
            } | Should -Throw '*NotFound*'
        }

        It 'invalid settings throw before any write' {
            {
                Invoke-SetMailboxSettings -TenantId 'tenant-test' -MailboxId 'mbx-2' -Settings @{ prohibitSendQuota = 'huge' } -DryRun $true
            } | Should -Throw '*ValidationFailed*'
            Assert-MockCalled Set-Mailbox -Times 0
        }
    }

    Context 'job envelope' {
        It 'reads tenant, mailbox, settings, and flags from the envelope' {
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('mailbox-settings-job-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    tenantId  = 'tenant-test'
                    mailboxId = 'mbx-2'
                    settings  = @{ prohibitSendQuota = '50 GB' }
                    confirmed = $true
                    dryRun    = $true
                } | ConvertTo-Json -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                $job = Read-SetMailboxSettingsJob -Path $jobPath
                $job['TenantId'] | Should -Be 'tenant-test'
                $job['MailboxId'] | Should -Be 'mbx-2'
                $job['Settings']['prohibitSendQuota'] | Should -Be '50 GB'
                $job['Confirmed'] | Should -BeTrue
                $job['DryRun'] | Should -BeTrue
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }

        It 'throws for a missing envelope' {
            {
                Read-SetMailboxSettingsJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'mailbox-settings-job-does-not-exist.json')
            } | Should -Throw '*job envelope not found*'
        }
    }
}
