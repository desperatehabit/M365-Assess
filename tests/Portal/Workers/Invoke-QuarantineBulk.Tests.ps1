BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-QuarantineBulk.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-quarantine-bulk.ps1'

    function global:Release-QuarantineMessage {
        param($Identity, $User, [switch]$ReleaseToAll, [switch]$Confirm)
    }
    function global:Delete-QuarantineMessage {
        param($Identity, [switch]$Confirm)
    }

    . $script:worker

    function script:New-QuarantineBulkMock {
        Mock Release-QuarantineMessage {
            param($Identity, $User, [switch]$ReleaseToAll, [switch]$Confirm)
            return [pscustomobject]@{ Identity = $Identity; Released = $true }
        }
        Mock Delete-QuarantineMessage {
            param($Identity, [switch]$Confirm)
        }
    }

    function script:New-BulkMessages {
        return @(
            [pscustomobject]@{ messageId = 'message-1'; recipient = 'user-1@example.invalid'; sender = 'sender@example.invalid'; subject = 'Subject 1' }
            [pscustomobject]@{ messageId = 'message-2'; recipient = 'user-2@example.invalid'; sender = 'sender@example.invalid'; subject = 'Subject 2' }
        )
    }
}

Describe 'Invoke-QuarantineBulk worker (T-0425)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-QuarantineBulk -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-QuarantineBulkJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-QuarantineBulkCap -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-QuarantineBulkActions -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'publishes the default cap and the bulk action set' {
            Get-QuarantineBulkCap | Should -Be 100
            Get-QuarantineBulkActions | Should -Be @('release', 'releaseAll', 'delete')
        }

        It 'reuses the T-0424 typed executor and never evaluates strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-QuarantineAction'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'entrypoint connects EXO in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Invoke-QuarantineBulk\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-QuarantineBulkJob -Path'
            $entrySource | Should -Match 'Invoke-QuarantineBulk'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'cap and confirmation gates' {
        BeforeEach {
            script:New-QuarantineBulkMock
        }

        It 'refuses an unknown action with a structured error and no EXO call' {
            { Invoke-QuarantineBulk -TenantId 'tenant-a' -Action 'forward' -Messages (New-BulkMessages) -Confirmed } | Should -Throw '*quarantine.unknown_action*'
            Should -Invoke Release-QuarantineMessage -Times 0 -Exactly
            Should -Invoke Delete-QuarantineMessage -Times 0 -Exactly
        }

        It 'rejects a batch over the configured cap before any release or delete' {
            { Invoke-QuarantineBulk -TenantId 'tenant-a' -Action 'delete' -Messages (New-BulkMessages) -Cap 1 -Confirmed } | Should -Throw '*quarantine.bulk_cap_exceeded*'
            Should -Invoke Delete-QuarantineMessage -Times 0 -Exactly
            Should -Invoke Release-QuarantineMessage -Times 0 -Exactly
        }

        It 'requires explicit confirmation and names the count' {
            $thrown = $null
            try {
                Invoke-QuarantineBulk -TenantId 'tenant-a' -Action 'delete' -Messages (New-BulkMessages)
            }
            catch {
                $thrown = $_
            }
            $thrown | Should -Not -BeNullOrEmpty
            $thrown.Exception.Message | Should -Match 'quarantine.confirm_required'
            $thrown.Exception.Message | Should -Match '2'
            Should -Invoke Delete-QuarantineMessage -Times 0 -Exactly
        }

        It 'rejects an empty selection' {
            { Invoke-QuarantineBulk -TenantId 'tenant-a' -Action 'delete' -Messages @() -Confirmed } | Should -Throw '*validation_failed*'
        }
    }

    Context 'bulk apply' {
        BeforeEach {
            script:New-QuarantineBulkMock
        }

        It 'plans a dry run with the count and cap and no EXO write' {
            $plan = Invoke-QuarantineBulk -TenantId 'tenant-a' -Action 'delete' -Messages (New-BulkMessages) -Cap 5 -DryRun $true
            $plan.action | Should -Be 'delete'
            $plan.count | Should -Be 2
            $plan.cap | Should -Be 5
            $plan.dryRun | Should -BeTrue
            $plan.requiresConfirmation | Should -BeTrue
            Should -Invoke Delete-QuarantineMessage -Times 0 -Exactly
        }

        It 'applies each item and audits actor, message, and recipient per item' {
            $script:audits = @()
            $result = Invoke-QuarantineBulk -TenantId 'tenant-a' -Action 'delete' -Messages (New-BulkMessages) -Confirmed -Actor 'operator-1' -CorrelationId 'corr-1' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.count | Should -Be 2
            $result.failedCount | Should -Be 0
            $result.results.Count | Should -Be 2
            @($result.results | Where-Object { $_.status -eq 'succeeded' }).Count | Should -Be 2

            $result.auditEvents.Count | Should -Be 2
            $result.auditEvents[0].action | Should -Be 'quarantine.action.delete'
            $result.auditEvents[0].messageId | Should -Be 'message-1'
            $result.auditEvents[0].recipient | Should -Be 'user-1@example.invalid'
            $result.auditEvents[0].actor | Should -Be 'operator-1'
            Should -Invoke Delete-QuarantineMessage -Times 2 -Exactly
            $script:audits.Count | Should -Be 2
        }

        It 'reports one message failure without aborting the rest' {
            Mock Release-QuarantineMessage {
                param($Identity, $User, [switch]$ReleaseToAll, [switch]$Confirm)
                if ($Identity -eq 'message-1') {
                    throw 'Authorization_RequestDenied'
                }
                return [pscustomobject]@{ Identity = $Identity; Released = $true }
            }
            $result = Invoke-QuarantineBulk -TenantId 'tenant-a' -Action 'release' -Messages (New-BulkMessages) -Confirmed -Actor 'operator-1'

            $result.success | Should -BeFalse
            $result.failedCount | Should -Be 1
            ($result.results | Where-Object { $_.messageId -eq 'message-1' }).status | Should -Be 'failed'
            ($result.results | Where-Object { $_.messageId -eq 'message-2' }).status | Should -Be 'succeeded'
            Should -Invoke Release-QuarantineMessage -Times 2 -Exactly
            # The failure is still audited, and the sibling applied.
            $result.auditEvents.Count | Should -Be 2
            @($result.auditEvents | Where-Object { $_.result -eq 'failure' }).Count | Should -Be 1
            @($result.auditEvents | Where-Object { $_.result -eq 'success' }).Count | Should -Be 1
        }

        It 'releases to all with a null audit recipient' {
            $result = Invoke-QuarantineBulk -TenantId 'tenant-a' -Action 'releaseAll' -Messages (New-BulkMessages) -Confirmed
            $result.success | Should -BeTrue
            $result.auditEvents[0].recipient | Should -BeNullOrEmpty
            Should -Invoke Release-QuarantineMessage -Times 2 -ParameterFilter { $ReleaseToAll -eq $true }
        }
    }

    Context 'job envelope' {
        It 'reads a bulk envelope with action, messages, confirmation, and actor' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-bulk-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    correlationId = 'correlation-1'
                    payload       = @{
                        action   = 'delete'
                        cap      = 50
                        confirm  = $true
                        dryRun   = $false
                        actor    = 'operator-1'
                        messages = @(
                            @{ messageId = 'message-1'; recipient = 'user-1@example.invalid'; sender = 'sender@example.invalid'; subject = 'Subject 1' }
                        )
                    }
                } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-QuarantineBulkJob -Path $path

                $job['TenantId'] | Should -Be 'tenant-a'
                $job['Action'] | Should -Be 'delete'
                $job['Messages'].Count | Should -Be 1
                $job['Messages'][0].messageId | Should -Be 'message-1'
                $job['Cap'] | Should -Be 50
                $job['Confirmed'] | Should -BeTrue
                $job['Actor'] | Should -Be 'operator-1'
                $job['CorrelationId'] | Should -Be 'correlation-1'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects a missing file, a bad schema version, and missing fields' {
            { Read-QuarantineBulkJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'no-such-quarantine-bulk-job.json') } | Should -Throw

            $badVersion = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-bulk-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a'; payload = @{ action = 'delete'; messages = @(@{ messageId = 'message-1' }) } } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $badVersion -Encoding UTF8
            try {
                { Read-QuarantineBulkJob -Path $badVersion } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $badVersion -Force -ErrorAction SilentlyContinue
            }

            $noAction = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-bulk-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ messages = @(@{ messageId = 'message-1' }) } } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $noAction -Encoding UTF8
            try {
                { Read-QuarantineBulkJob -Path $noAction } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $noAction -Force -ErrorAction SilentlyContinue
            }

            $noMessages = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-bulk-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ action = 'delete' } } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $noMessages -Encoding UTF8
            try {
                { Read-QuarantineBulkJob -Path $noMessages } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $noMessages -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
