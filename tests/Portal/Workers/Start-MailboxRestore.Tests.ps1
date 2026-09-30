BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Start-MailboxRestore.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/start-mailbox-restore.ps1'

    function global:Get-EXOMailbox {
        param($Identity, [switch]$SoftDeletedMailbox, $ResultSize, $Properties)
    }
    function global:Get-EXOMailboxStatistics {
        param($Identity)
    }
    function global:Undo-SoftDeletedMailbox {
        param($SoftDeletedMailbox)
    }
    function global:New-MailboxRestoreRequest {
        param($SourceStoreMailbox, $TargetMailbox, $AllowLegacyDNMismatch)
    }

    . $script:worker

    function script:New-ProgressCollector {
        $store = @{ events = [System.Collections.Generic.List[object]]::new() }
        $seam = { param($ProgressEvent) $store.events.Add($ProgressEvent) }.GetNewClosure()
        return @{ store = $store; seam = $seam }
    }

    function script:New-AuditCollector {
        $store = @{ events = [System.Collections.Generic.List[object]]::new() }
        $seam = { param($AuditEvent) $store.events.Add($AuditEvent) }.GetNewClosure()
        return @{ store = $store; seam = $seam }
    }

    function script:New-RestoreMocks {
        Mock Get-EXOMailbox {
            param($Identity, [switch]$SoftDeletedMailbox, $ResultSize, $Properties)
            if ($SoftDeletedMailbox) {
                if ($Identity -eq 'mbx-soft-1') {
                    return [pscustomobject]@{
                        ExchangeObjectId     = 'mbx-soft-1'
                        DisplayName          = 'Departed Operator'
                        PrimarySmtpAddress   = 'departed.operator@example.invalid'
                        RecipientTypeDetails = 'UserMailbox'
                    }
                }
                throw 'not soft-deleted'
            }
            if ($Identity -eq 'mbx-live-1') {
                return [pscustomobject]@{
                    ExchangeObjectId     = 'mbx-live-1'
                    DisplayName          = 'Active Operator'
                    PrimarySmtpAddress   = 'active.operator@example.invalid'
                    RecipientTypeDetails = 'UserMailbox'
                }
            }
            throw 'not found'
        }
        Mock Get-EXOMailboxStatistics {
            param($Identity)
            switch ($Identity) {
                'mbx-soft-1' { return [pscustomobject]@{ ItemCount = 10 } }
                'mbx-live-1' { return [pscustomobject]@{ ItemCount = 20 } }
                'restore-target' { return [pscustomobject]@{ ItemCount = 3 } }
                default { return [pscustomobject]@{ ItemCount = 0 } }
            }
        }
        Mock Undo-SoftDeletedMailbox { param($SoftDeletedMailbox) }
        Mock New-MailboxRestoreRequest { param($SourceStoreMailbox, $TargetMailbox, $AllowLegacyDNMismatch) }
    }
}

Describe 'Start-MailboxRestore worker (T-0467)' {

    Context 'the worker files' {
        It 'ships the handler functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command New-MailboxRestorePlan -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Start-MailboxRestore -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-MailboxRestoreJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command New-MailboxRestoreAuditEvent -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'drives the EXO restore backend' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Undo-SoftDeletedMailbox'
            $source | Should -Match 'New-MailboxRestoreRequest'
        }

        It 'entrypoint connects EXO in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Start-MailboxRestore\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-MailboxRestoreJob -Path'
            $entrySource | Should -Match 'Start-MailboxRestore -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'plan preview' {
        BeforeEach {
            New-RestoreMocks
        }

        It 'returns a plan preview for a whole mailbox and writes nothing' {
            $plan = New-MailboxRestorePlan -TenantId 'tenant-a' -MailboxId 'mbx-soft-1' -Scope 'mailbox'

            $plan.action | Should -Be 'restore'
            $plan.scope | Should -Be 'mailbox'
            $plan.mailboxId | Should -Be 'mbx-soft-1'
            $plan.before.state | Should -Be 'softDeleted'
            $plan.after.state | Should -Be 'active'
            $plan.before.itemCount | Should -Be 10
            $plan.dryRun | Should -BeTrue
            $plan.requiresConfirmation | Should -BeTrue
            $plan.diff | Should -Not -BeNullOrEmpty
            Should -Invoke Undo-SoftDeletedMailbox -Times 0 -Exactly
            Should -Invoke New-MailboxRestoreRequest -Times 0 -Exactly
        }

        It 'requires an explicit target for item-level scope' {
            { New-MailboxRestorePlan -TenantId 'tenant-a' -MailboxId 'mbx-live-1' -Scope 'items' } |
                Should -Throw '*target_required*'
            Should -Invoke New-MailboxRestoreRequest -Times 0 -Exactly
        }

        It 'throws a structured error for a mailbox outside the recovery window' {
            { New-MailboxRestorePlan -TenantId 'tenant-a' -MailboxId 'mbx-missing' -Scope 'mailbox' } |
                Should -Throw '*restore_not_found*'
        }
    }

    Context 'apply' {
        BeforeEach {
            New-RestoreMocks
        }

        It 'previews with -DryRun and does not write' {
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            $res = Start-MailboxRestore -TenantId 'tenant-a' -JobId 'job-1' -MailboxId 'mbx-soft-1' -Scope 'mailbox' -DryRun $true -WriteProgress $progress.seam -WriteAudit $audits.seam

            $res.dryRun | Should -BeTrue
            $res.job.state | Should -Be 'planned'
            Should -Invoke Undo-SoftDeletedMailbox -Times 0 -Exactly
            @($audits.store.events).Count | Should -Be 0
        }

        It 'restores a whole mailbox with before/after counts and an audit record' {
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            $res = Start-MailboxRestore -TenantId 'tenant-a' -JobId 'job-1' -MailboxId 'mbx-soft-1' -Scope 'mailbox' -DryRun $false -Confirmed $true -WriteProgress $progress.seam -WriteAudit $audits.seam

            $res.success | Should -BeTrue
            $res.job.state | Should -Be 'completed'
            $res.job.scope | Should -Be 'mailbox'
            $res.result.before.itemCount | Should -Be 10
            $res.result.after.itemCount | Should -Be 10
            $res.auditEvent.action | Should -Be 'mailbox.restore'
            $res.auditEvent.targetId | Should -Be 'mbx-soft-1'
            $res.auditEvent.scope | Should -Be 'mailbox'
            $res.auditEvent.before.itemCount | Should -Be 10
            $res.auditEvent.after.itemCount | Should -Be 10
            Should -Invoke Undo-SoftDeletedMailbox -Times 1 -Exactly -ParameterFilter { $SoftDeletedMailbox -eq 'mbx-soft-1' }
            Should -Invoke New-MailboxRestoreRequest -Times 0 -Exactly
            @($audits.store.events).Count | Should -Be 1
            @($progress.store.events)[-1].state | Should -Be 'completed'
        }

        It 'accepts an explicitly scoped item-level restore into the target' {
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            $res = Start-MailboxRestore -TenantId 'tenant-a' -JobId 'job-2' -MailboxId 'mbx-live-1' -Scope 'items' -Target 'restore-target' -DryRun $false -Confirmed $true -WriteProgress $progress.seam -WriteAudit $audits.seam

            $res.job.scope | Should -Be 'items'
            $res.job.target | Should -Be 'restore-target'
            $res.result.before.itemCount | Should -Be 20
            $res.result.after.itemCount | Should -Be 3
            Should -Invoke New-MailboxRestoreRequest -Times 1 -Exactly -ParameterFilter { $TargetMailbox -eq 'restore-target' }
            Should -Invoke Undo-SoftDeletedMailbox -Times 0 -Exactly
            @($audits.store.events)[0].scope | Should -Be 'items'
            @($audits.store.events)[0].after.itemCount | Should -Be 3
        }

        It 'refuses to apply without confirmation and writes nothing' {
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            { Start-MailboxRestore -TenantId 'tenant-a' -JobId 'job-1' -MailboxId 'mbx-soft-1' -Scope 'mailbox' -DryRun $false -Confirmed $false -WriteProgress $progress.seam -WriteAudit $audits.seam } |
                Should -Throw '*confirm_required*'
            Should -Invoke Undo-SoftDeletedMailbox -Times 0 -Exactly
            @($audits.store.events).Count | Should -Be 0
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id, action, scope, and target' {
            $jobPath = Join-Path $TestDrive 'mailbox-restore-job.json'
            @{
                schemaVersion = 'v1'
                jobId         = 'job-1'
                jobType       = 'mailbox-restore'
                tenantId      = 'tenant-a'
                runId         = 'run-1'
                requestId     = 'req-1'
                correlationId = 'corr-1'
                createdAt     = '2026-01-01T00:00:00.000Z'
                payload       = @{
                    contextRef    = 'runs/run-1/context.json'
                    outputRef     = 'runs/run-1'
                    credentialRef = 'tenants/tenant-a/credential'
                    sectionRefs   = @()
                    artifactRefs  = @()
                    filters       = @{
                        action    = 'apply'
                        mailboxId = 'mbx-soft-1'
                        scope     = 'items'
                        target    = 'restore-target'
                        confirmed = $true
                    }
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-MailboxRestoreJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['JobId'] | Should -Be 'job-1'
            $job['Action'] | Should -Be 'apply'
            $job['MailboxId'] | Should -Be 'mbx-soft-1'
            $job['Scope'] | Should -Be 'items'
            $job['Target'] | Should -Be 'restore-target'
            $job['Confirmed'] | Should -BeTrue
        }

        It 'rejects envelopes with an unsupported schema version, action, or scope' {
            $badVersion = Join-Path $TestDrive 'mailbox-restore-bad-version.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $badVersion -Encoding UTF8
            { Read-MailboxRestoreJob -Path $badVersion } | Should -Throw '*schemaVersion*'

            $badAction = Join-Path $TestDrive 'mailbox-restore-bad-action.json'
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ filters = @{ action = 'delete' } } } | ConvertTo-Json -Depth 5 | Set-Content -Path $badAction -Encoding UTF8
            { Read-MailboxRestoreJob -Path $badAction } | Should -Throw '*action*'

            $badScope = Join-Path $TestDrive 'mailbox-restore-bad-scope.json'
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ filters = @{ action = 'plan'; scope = 'everything' } } } | ConvertTo-Json -Depth 5 | Set-Content -Path $badScope -Encoding UTF8
            { Read-MailboxRestoreJob -Path $badScope } | Should -Throw '*scope*'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $empty = Join-Path $TestDrive 'mailbox-restore-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $empty -Encoding UTF8

            { Read-MailboxRestoreJob -Path $empty } | Should -Throw '*tenantId*'
            { Read-MailboxRestoreJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }
}
