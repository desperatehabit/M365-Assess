BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Restore-Mailbox.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/restore-mailbox.ps1'

    function global:Get-EXOMailbox {
        param($Identity, [switch]$SoftDeletedMailbox, $ResultSize, $Properties)
    }
    function global:Undo-SoftDeletedMailbox {
        param($SoftDeletedMailbox)
    }

    . $script:worker

    $script:deletedUser = @{
        ExchangeObjectId     = 'mbx-deleted-1'
        Guid                 = '00000000-0000-0000-0000-000000000001'
        DisplayName          = 'Departed Operator'
        PrimarySmtpAddress   = 'departed.operator@example.invalid'
        RecipientTypeDetails = 'UserMailbox'
        WhenSoftDeleted      = ((Get-Date).ToUniversalTime().AddDays(-10))
        WhenDeleted          = $null
    }
    $script:deletedShared = @{
        ExchangeObjectId     = 'mbx-deleted-2'
        Guid                 = '00000000-0000-0000-0000-000000000002'
        DisplayName          = 'Old Shared'
        PrimarySmtpAddress   = 'old.shared@example.invalid'
        RecipientTypeDetails = 'SharedMailbox'
        WhenSoftDeleted      = ((Get-Date).ToUniversalTime().AddDays(-8))
        WhenDeleted          = $null
    }
    $script:liveMailbox = @{
        ExchangeObjectId     = 'mbx-live-9'
        DisplayName          = 'Active Operator'
        PrimarySmtpAddress   = 'active.operator@example.invalid'
        RecipientTypeDetails = 'UserMailbox'
    }

    function script:New-DeletedListMock {
        Mock Get-EXOMailbox {
            param($Identity, [switch]$SoftDeletedMailbox, $ResultSize, $Properties)
            if ($PSBoundParameters.ContainsKey('Identity') -and -not [string]::IsNullOrWhiteSpace([string]$Identity)) {
                if ($SoftDeletedMailbox) {
                    $found = @($script:deletedUser, $script:deletedShared) |
                        Where-Object { $_.ExchangeObjectId -eq $Identity -or $_.PrimarySmtpAddress -eq $Identity }
                    return @($found)[0]
                }
                if ($Identity -eq 'mbx-deleted-1') {
                    return $script:liveMailbox
                }
                $found = @($script:deletedUser, $script:deletedShared, $script:liveMailbox) |
                    Where-Object { $_.ExchangeObjectId -eq $Identity -or $_.PrimarySmtpAddress -eq $Identity }
                return @($found)[0]
            }
            if ($SoftDeletedMailbox) {
                return @($script:deletedUser, $script:deletedShared)
            }
            return @($script:liveMailbox)
        }
        Mock Undo-SoftDeletedMailbox {
            param($SoftDeletedMailbox)
            return @{ Identity = $SoftDeletedMailbox }
        }
    }
}

Describe 'Restore-Mailbox worker (T-0388)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-DeletedMailboxes -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Invoke-RestoreMailbox -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-RestoreMailboxJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-DeletedMailboxRow -CommandType Function) | Should -Not -BeNullOrEmpty
        }
    }

    Context 'soft-deleted mailbox list' {
        BeforeEach {
            New-DeletedListMock
        }

        It 'lists soft-deleted mailboxes with identity and deletion metadata' {
            $page = Get-DeletedMailboxes -TenantId 'tenant-test'
            $page.tenantId | Should -Be 'tenant-test'
            $page.totalCount | Should -Be 2
            $page.items.Count | Should -Be 2
            $page.items[0].id | Should -Be 'mbx-deleted-1'
            $page.items[0].displayName | Should -Be 'Departed Operator'
            $page.items[0].primarySmtpAddress | Should -Be 'departed.operator@example.invalid'
            $page.items[0].mailboxType | Should -Be 'UserMailbox'
            $page.items[0].deletedAt | Should -Not -BeNullOrEmpty
            $page.items[0].daysUntilPurge | Should -Be 19
            Assert-MockCalled Undo-SoftDeletedMailbox -Times 0
        }

        It 'filters the projection by search text' {
            $page = Get-DeletedMailboxes -TenantId 'tenant-test' -Search 'old shared'
            $page.totalCount | Should -Be 1
            $page.items[0].id | Should -Be 'mbx-deleted-2'
        }

        It 'pages the projection with an opaque cursor' {
            $first = Get-DeletedMailboxes -TenantId 'tenant-test' -Top 1
            $first.items.Count | Should -Be 1
            $first.nextCursor | Should -Not -BeNullOrEmpty
            $second = Get-DeletedMailboxes -TenantId 'tenant-test' -Top 1 -Cursor $first.nextCursor
            $second.items.Count | Should -Be 1
            $second.items[0].id | Should -Not -Be $first.items[0].id
        }
    }

    Context 'soft-deleted mailbox restore' {
        BeforeEach {
            New-DeletedListMock
        }

        It 'restore with DryRun returns a plan preview without calling Undo-SoftDeletedMailbox' {
            $plan = Invoke-RestoreMailbox -TenantId 'tenant-test' -MailboxId 'mbx-deleted-1' -DryRun $true
            $plan.action | Should -Be 'restore'
            $plan.valid | Should -BeTrue
            $plan.dryRun | Should -BeTrue
            $plan.mailboxId | Should -Be 'mbx-deleted-1'
            $plan.targetName | Should -Be 'Departed Operator'
            $plan.before['state'] | Should -Be 'softDeleted'
            $plan.after['state'] | Should -Be 'active'
            $plan.diff | Should -Not -BeNullOrEmpty
            Assert-MockCalled Undo-SoftDeletedMailbox -Times 0
        }

        It 'restore apply without confirmation is refused' {
            {
                Invoke-RestoreMailbox -TenantId 'tenant-test' -MailboxId 'mbx-deleted-1' -DryRun $false
            } | Should -Throw '*confirm_required*'
            Assert-MockCalled Undo-SoftDeletedMailbox -Times 0
        }

        It 'restore apply with confirmation calls Undo-SoftDeletedMailbox and produces before/after plus an audit record' {
            $res = Invoke-RestoreMailbox -TenantId 'tenant-test' -MailboxId 'mbx-deleted-1' -DryRun $false -Confirmed $true
            $res.success | Should -BeTrue
            $res.result['state'] | Should -Be 'active'
            $res.plan.before['state'] | Should -Be 'softDeleted'
            $res.plan.after['state'] | Should -Be 'active'
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'mailbox.restore'
            $res.auditEvent.targetId | Should -Be 'mbx-deleted-1'
            $res.auditEvent.before['state'] | Should -Be 'softDeleted'
            $res.auditEvent.after['state'] | Should -Be 'active'
            Assert-MockCalled Undo-SoftDeletedMailbox -Times 1 -ParameterFilter { $SoftDeletedMailbox -eq 'mbx-deleted-1' }
        }

        It 'restoring a mailbox that is not soft-deleted throws NotFound without writing' {
            {
                Invoke-RestoreMailbox -TenantId 'tenant-test' -MailboxId 'mbx-live-9' -DryRun $true
            } | Should -Throw '*NotFound*soft-deleted*'
            Assert-MockCalled Undo-SoftDeletedMailbox -Times 0
        }

        It 'restoring an unknown mailbox throws NotFound without writing' {
            {
                Invoke-RestoreMailbox -TenantId 'tenant-test' -MailboxId 'mbx-missing' -DryRun $true
            } | Should -Throw '*NotFound*soft-deleted*'
            Assert-MockCalled Undo-SoftDeletedMailbox -Times 0
        }
    }

    Context 'job envelope' {
        It 'reads tenant, action, and flags from the envelope' {
            $jobPath = Join-Path ([System.IO.Path]::GetTempPath()) ('restore-mailbox-job-' + [guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    tenantId  = 'tenant-test'
                    action    = 'restore'
                    mailboxId = 'mbx-deleted-1'
                    confirmed = $true
                    dryRun    = $true
                } | ConvertTo-Json -Compress | Set-Content -LiteralPath $jobPath -Encoding UTF8
                $job = Read-RestoreMailboxJob -Path $jobPath
                $job['TenantId'] | Should -Be 'tenant-test'
                $job['Action'] | Should -Be 'restore'
                $job['MailboxId'] | Should -Be 'mbx-deleted-1'
                $job['Confirmed'] | Should -BeTrue
                $job['DryRun'] | Should -BeTrue
            }
            finally {
                Remove-Item -LiteralPath $jobPath -Force -ErrorAction SilentlyContinue
            }
        }

        It 'throws for a missing envelope' {
            {
                Read-RestoreMailboxJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'restore-mailbox-job-does-not-exist.json')
            } | Should -Throw '*job envelope not found*'
        }
    }
}
