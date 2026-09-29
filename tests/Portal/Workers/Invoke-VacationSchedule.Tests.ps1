BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-VacationSchedule.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-vacation-schedule.ps1'

    function global:Get-MailboxAutoReplyConfiguration {
        param($Identity)
    }
    function global:Set-MailboxAutoReplyConfiguration {
        param($Identity, $AutoReplyState, $InternalMessage, $ExternalMessage)
    }
    function global:Get-Mailbox {
        param($Identity)
    }
    function global:Set-Mailbox {
        param($Identity, $ForwardingAddress, $ForwardingSmtpAddress, $DeliverToMailboxAndForward)
    }

    . $script:worker

    $script:start = '2026-10-01T00:00:00Z'
    $script:end = '2026-10-08T00:00:00Z'
    $script:futureBound = '2099-01-01T00:00:00Z'
}

Describe 'Invoke-VacationSchedule worker (T-0386)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-VacationSchedule -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-VacationScheduleJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-VacationScheduleInput -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-VacationMailboxState -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-VacationRevertedState -CommandType Function) | Should -Not -BeNullOrEmpty
        }
    }

    Context 'schedule input validation' {
        It 'accepts a valid enable' {
            $errors = @(Test-VacationScheduleInput -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -OooMessage 'Out.' -ForwardTo 'cover@example.invalid' -Phase 'enable')
            $errors | Should -BeNullOrEmpty
        }

        It 'rejects a missing mailbox id' {
            $errors = @(Test-VacationScheduleInput -StartsAt $script:start -EndsAt $script:end -OooMessage 'Out.' -Phase 'enable')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'mailboxId is required'
        }

        It 'rejects an inverted window' {
            $errors = @(Test-VacationScheduleInput -MailboxId 'mbx-1' -StartsAt $script:end -EndsAt $script:start -OooMessage 'Out.' -Phase 'enable')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'endsAt must be after startsAt'
        }

        It 'rejects enable without an OoO message but allows revert without one' {
            $errors = @(Test-VacationScheduleInput -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -Phase 'enable')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'oooMessage is required'
            $revertErrors = @(Test-VacationScheduleInput -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -Phase 'revert')
            $revertErrors | Should -BeNullOrEmpty
        }

        It 'rejects a malformed forwarding target' {
            $errors = @(Test-VacationScheduleInput -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -OooMessage 'Out.' -ForwardTo 'not-an-address' -Phase 'enable')
            $errors | Should -Not -BeNullOrEmpty
            $errors[0] | Should -Match 'forwardTo'
        }
    }

    Context 'vacation enable' {
        BeforeEach {
            $script:autoReplyState = 'Disabled'
            $script:storedMessage = ''
            $script:forwarding = ''
            Mock Get-MailboxAutoReplyConfiguration {
                param($Identity)
                return @{
                    AutoReplyState  = $script:autoReplyState
                    InternalMessage = $script:storedMessage
                    ExternalMessage = $script:storedMessage
                }
            }
            Mock Get-Mailbox {
                param($Identity)
                return @{
                    ForwardingAddress         = ''
                    ForwardingSmtpAddress     = $script:forwarding
                    DeliverToMailboxAndForward = ($script:forwarding -ne '')
                }
            }
            Mock Set-MailboxAutoReplyConfiguration {
                param($Identity, $AutoReplyState, $InternalMessage, $ExternalMessage)
                $script:autoReplyState = [string]$AutoReplyState
                if ($InternalMessage) { $script:storedMessage = [string]$InternalMessage }
            }
            Mock Set-Mailbox {
                param($Identity, $ForwardingAddress, $ForwardingSmtpAddress, $DeliverToMailboxAndForward)
                if ($PSBoundParameters.ContainsKey('ForwardingSmtpAddress')) {
                    $script:forwarding = [string]$ForwardingSmtpAddress
                }
            }
        }

        It 'enable with DryRun returns a plan preview without writing' {
            $plan = Invoke-VacationSchedule -TenantId 'tenant-test' -Phase 'enable' -ScheduleId 'vac-1' -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -OooMessage 'Out.' -ForwardTo 'cover@example.invalid' -NotAfter $script:futureBound -DryRun $true
            $plan.action | Should -Be 'enable'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.before['autoReplyState'] | Should -Be 'Disabled'
            $plan.after['autoReplyState'] | Should -Be 'Enabled'
            $plan.after['forwardingSmtpAddress'] | Should -Be 'cover@example.invalid'
            $plan.diff | Should -Not -BeNullOrEmpty
            Assert-MockCalled Set-MailboxAutoReplyConfiguration -Times 0
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'enable apply without confirmation is refused' {
            {
                Invoke-VacationSchedule -TenantId 'tenant-test' -Phase 'enable' -ScheduleId 'vac-1' -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -OooMessage 'Out.' -NotAfter $script:futureBound -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Set-MailboxAutoReplyConfiguration -Times 0
        }

        It 'enable apply writes OoO + forwarding and produces audit and operation records' {
            $res = Invoke-VacationSchedule -TenantId 'tenant-test' -Phase 'enable' -ScheduleId 'vac-1' -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -OooMessage 'Out.' -ForwardTo 'cover@example.invalid' -NotAfter $script:futureBound -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.scheduleState | Should -Be 'active'
            $res.plan.before['autoReplyState'] | Should -Be 'Disabled'
            $res.plan.after['autoReplyState'] | Should -Be 'Enabled'
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'vacation.enable'
            $res.auditEvent.targetId | Should -Be 'vac-1'
            $res.auditEvent.before['autoReplyState'] | Should -Be 'Disabled'
            $res.auditEvent.after['autoReplyState'] | Should -Be 'Enabled'
            $res.mailboxOperation | Should -Not -BeNullOrEmpty
            $res.mailboxOperation.operation | Should -Be 'enable'
            $res.mailboxOperation.state | Should -Be 'applied'
            Assert-MockCalled Set-MailboxAutoReplyConfiguration -Times 1 -ParameterFilter { $AutoReplyState -eq 'Enabled' }
            Assert-MockCalled Set-Mailbox -Times 1
        }

        It 'enable of an already-enabled mailbox with the same message is a structured no-op' {
            $script:autoReplyState = 'Enabled'
            $script:storedMessage = 'Out.'
            $script:forwarding = 'cover@example.invalid'
            $res = Invoke-VacationSchedule -TenantId 'tenant-test' -Phase 'enable' -ScheduleId 'vac-1' -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -OooMessage 'Out.' -ForwardTo 'cover@example.invalid' -NotAfter $script:futureBound -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.noop | Should -BeTrue
            $res.scheduleState | Should -Be 'active'
            Assert-MockCalled Set-MailboxAutoReplyConfiguration -Times 0
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'enable past NotAfter is an expired skip with no write' {
            $res = Invoke-VacationSchedule -TenantId 'tenant-test' -Phase 'enable' -ScheduleId 'vac-1' -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -OooMessage 'Out.' -NotAfter '2000-01-01T00:00:00Z' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.expired | Should -BeTrue
            $res.scheduleState | Should -Be 'ended'
            Assert-MockCalled Set-MailboxAutoReplyConfiguration -Times 0
            Assert-MockCalled Set-Mailbox -Times 0
        }
    }

    Context 'vacation revert' {
        BeforeEach {
            $script:autoReplyState = 'Enabled'
            $script:storedMessage = 'Out.'
            $script:forwarding = 'cover@example.invalid'
            Mock Get-MailboxAutoReplyConfiguration {
                param($Identity)
                return @{
                    AutoReplyState  = $script:autoReplyState
                    InternalMessage = $script:storedMessage
                    ExternalMessage = $script:storedMessage
                }
            }
            Mock Get-Mailbox {
                param($Identity)
                return @{
                    ForwardingAddress         = ''
                    ForwardingSmtpAddress     = $script:forwarding
                    DeliverToMailboxAndForward = ($script:forwarding -ne '')
                }
            }
            Mock Set-MailboxAutoReplyConfiguration {
                param($Identity, $AutoReplyState, $InternalMessage, $ExternalMessage)
                $script:autoReplyState = [string]$AutoReplyState
            }
            Mock Set-Mailbox {
                param($Identity, $ForwardingAddress, $ForwardingSmtpAddress, $DeliverToMailboxAndForward)
                if ($PSBoundParameters.ContainsKey('ForwardingSmtpAddress')) {
                    $script:forwarding = [string]$ForwardingSmtpAddress
                }
            }
        }

        It 'revert with DryRun returns a diff against the current mailbox without writing' {
            $plan = Invoke-VacationSchedule -TenantId 'tenant-test' -Phase 'revert' -ScheduleId 'vac-1' -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -DryRun $true
            $plan.action | Should -Be 'revert'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.before['autoReplyState'] | Should -Be 'Enabled'
            $plan.after['autoReplyState'] | Should -Be 'Disabled'
            $plan.after['forwardingSmtpAddress'] | Should -Be ''
            Assert-MockCalled Set-MailboxAutoReplyConfiguration -Times 0
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'revert apply without confirmation is refused' {
            {
                Invoke-VacationSchedule -TenantId 'tenant-test' -Phase 'revert' -ScheduleId 'vac-1' -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Set-MailboxAutoReplyConfiguration -Times 0
        }

        It 'revert apply captures before/after and produces audit and operation records' {
            $res = Invoke-VacationSchedule -TenantId 'tenant-test' -Phase 'revert' -ScheduleId 'vac-1' -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.scheduleState | Should -Be 'ended'
            $res.noop | Should -BeNullOrEmpty
            $res.plan.before['autoReplyState'] | Should -Be 'Enabled'
            $res.plan.after['autoReplyState'] | Should -Be 'Disabled'
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'vacation.revert'
            $res.auditEvent.targetId | Should -Be 'vac-1'
            $res.auditEvent.before['autoReplyState'] | Should -Be 'Enabled'
            $res.auditEvent.after['autoReplyState'] | Should -Be 'Disabled'
            $res.mailboxOperation | Should -Not -BeNullOrEmpty
            $res.mailboxOperation.operation | Should -Be 'revert'
            $res.mailboxOperation.state | Should -Be 'applied'
            Assert-MockCalled Set-MailboxAutoReplyConfiguration -Times 1 -ParameterFilter { $AutoReplyState -eq 'Disabled' }
            Assert-MockCalled Set-Mailbox -Times 1
        }

        It 'revert of an already-reverted mailbox is a structured no-op with no write' {
            $script:autoReplyState = 'Disabled'
            $script:forwarding = ''
            $res = Invoke-VacationSchedule -TenantId 'tenant-test' -Phase 'revert' -ScheduleId 'vac-1' -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.noop | Should -BeTrue
            $res.scheduleState | Should -Be 'ended'
            Assert-MockCalled Set-MailboxAutoReplyConfiguration -Times 0
            Assert-MockCalled Set-Mailbox -Times 0
        }

        It 'a failed revert is recorded as failed and raises an alert rather than silently ending' {
            Mock Set-MailboxAutoReplyConfiguration { param($Identity, $AutoReplyState) throw 'EXO is unavailable' }
            $script:raised = @()
            $raise = { param($alertEvent) $script:raised += $alertEvent }
            $res = Invoke-VacationSchedule -TenantId 'tenant-test' -Phase 'revert' -ScheduleId 'vac-1' -MailboxId 'mbx-1' -StartsAt $script:start -EndsAt $script:end -DryRun $false -Confirmed $true -RaiseAlert $raise
            $res.success | Should -BeFalse
            $res.scheduleState | Should -Be 'failed'
            $res.alerted | Should -BeTrue
            $res.alertEvent | Should -Not -BeNullOrEmpty
            $res.alertEvent.kind | Should -Be 'vacation.revert'
            $res.alertEvent.severity | Should -Be 'High'
            $res.alertEvent.scheduleId | Should -Be 'vac-1'
            $res.auditEvent.action | Should -Be 'vacation.revert'
            $res.mailboxOperation.operation | Should -Be 'revert'
            $res.mailboxOperation.state | Should -Be 'failed'
            $script:raised.Count | Should -Be 1
            $script:raised[0].kind | Should -Be 'vacation.revert'
        }
    }

    Context 'job envelope' {
        It 'reads tenant, schedule, phase, and flags from the envelope' {
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('vacation-job-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    tenantId   = 'tenant-test'
                    scheduleId = 'vac-1'
                    phase      = 'revert'
                    mailboxId  = 'mbx-1'
                    startsAt   = $script:start
                    endsAt     = $script:end
                    oooMessage = ''
                    forwardTo  = ''
                    notAfter   = $script:futureBound
                    confirmed  = $true
                    dryRun     = $true
                } | ConvertTo-Json -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                $job = Read-VacationScheduleJob -Path $jobPath
                $job['TenantId'] | Should -Be 'tenant-test'
                $job['ScheduleId'] | Should -Be 'vac-1'
                $job['Phase'] | Should -Be 'revert'
                $job['MailboxId'] | Should -Be 'mbx-1'
                $job['Confirmed'] | Should -BeTrue
                $job['DryRun'] | Should -BeTrue
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }

        It 'throws for a missing envelope' {
            {
                Read-VacationScheduleJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'vacation-job-does-not-exist.json')
            } | Should -Throw '*job envelope not found*'
        }
    }
}
