BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-QuarantineAction.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/invoke-quarantine-action.ps1'

    function global:Release-QuarantineMessage {
        param($Identity, $User, [switch]$ReleaseToAll, [switch]$Confirm)
    }
    function global:Delete-QuarantineMessage {
        param($Identity, [switch]$Confirm)
    }

    . $script:worker

    function script:New-QuarantineMock {
        Mock Release-QuarantineMessage {
            param($Identity, $User, [switch]$ReleaseToAll, [switch]$Confirm)
            return [pscustomobject]@{ Identity = $Identity; Released = $true }
        }
        Mock Delete-QuarantineMessage {
            param($Identity, [switch]$Confirm)
        }
    }
}

Describe 'Invoke-QuarantineAction worker (T-0424)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-QuarantineAction -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-QuarantineActionJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-QuarantineActions -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Resolve-QuarantineActionTransport -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'publishes the action, confirmation, and EXO-support sets' {
            Get-QuarantineActions | Should -Be @('release', 'releaseAll', 'delete', 'preview')
            Get-QuarantineActionConfirmation | Should -Be @('release', 'releaseAll', 'delete')
            Get-QuarantineActionExoSupport | Should -Be @('release', 'releaseAll', 'delete')
        }

        It 'resolves the §11.1 transport: EXO where it supports the action, Graph metadata otherwise' {
            Resolve-QuarantineActionTransport -Action 'release' | Should -Be 'exo'
            Resolve-QuarantineActionTransport -Action 'releaseAll' | Should -Be 'exo'
            Resolve-QuarantineActionTransport -Action 'delete' | Should -Be 'exo'
            Resolve-QuarantineActionTransport -Action 'preview' | Should -Be 'graph'
        }

        It 'writes with the typed EXO cmdlets only and never evaluates strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Release-QuarantineMessage'
            $source | Should -Match 'Delete-QuarantineMessage'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'never persists quarantine data to disk, logs, or transcripts' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Export-Clixml'
            $source | Should -Not -Match 'Add-Content'
            $source | Should -Not -Match 'Set-Content'
            $source | Should -Not -Match 'Start-Transcript'
            $source | Should -Not -Match 'Tee-Object'
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Not -Match 'Out-File'
            $entrySource | Should -Not -Match 'Start-Transcript'
        }

        It 'entrypoint connects EXO in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Invoke-QuarantineAction\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-QuarantineActionJob -Path'
            $entrySource | Should -Match 'Invoke-QuarantineAction'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'action dispatch' {
        BeforeEach {
            script:New-QuarantineMock
        }

        It 'requires the tenant and message identifiers' {
            { Invoke-QuarantineAction -TenantId '' -MessageId 'message-1' -Action 'delete' -Confirmed } | Should -Throw
            { Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId '' -Action 'delete' -Confirmed } | Should -Throw
        }

        It 'refuses an unknown action with a structured error and no EXO call' {
            { Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId 'message-1' -Action 'forward' } | Should -Throw '*quarantine.unknown_action*'
            Should -Invoke Release-QuarantineMessage -Times 0 -Exactly
            Should -Invoke Delete-QuarantineMessage -Times 0 -Exactly
        }

        It 'requires a recipient to release to a recipient' {
            { Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId 'message-1' -Action 'release' -Confirmed } | Should -Throw '*recipient*'
            Should -Invoke Release-QuarantineMessage -Times 0 -Exactly
        }

        It 'requires confirmation for release, release-to-all, and delete with no EXO call' {
            { Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId 'message-1' -Action 'release' -Recipient 'user@example.invalid' } | Should -Throw '*quarantine.confirm_required*'
            { Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId 'message-1' -Action 'releaseAll' } | Should -Throw '*quarantine.confirm_required*'
            { Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId 'message-1' -Action 'delete' } | Should -Throw '*quarantine.confirm_required*'
            Should -Invoke Release-QuarantineMessage -Times 0 -Exactly
            Should -Invoke Delete-QuarantineMessage -Times 0 -Exactly
        }

        It 'plans a release with no EXO write on dry run' {
            $result = Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId 'message-1' -Action 'release' -Recipient 'user@example.invalid' -Confirmed -DryRun:$true

            $result.action | Should -Be 'release'
            $result.transport | Should -Be 'exo'
            $result.dryRun | Should -BeTrue
            $result.requiresConfirmation | Should -BeTrue
            Should -Invoke Release-QuarantineMessage -Times 0 -Exactly
        }

        It 'releases to a recipient with a success audit' {
            $script:audits = @()
            $result = Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId 'message-1' -Action 'release' -Recipient 'user@example.invalid' -Confirmed -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.action | Should -Be 'release'
            $result.auditEvent.action | Should -Be 'quarantine.action.release'
            $result.auditEvent.result | Should -Be 'success'
            $result.auditEvent.recipient | Should -Be 'user@example.invalid'
            Should -Invoke Release-QuarantineMessage -ParameterFilter { $Identity -eq 'message-1' -and $User -eq 'user@example.invalid' }
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'success'
        }

        It 'releases to all with ReleaseToAll and a null audit recipient' {
            $script:audits = @()
            $result = Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId 'message-1' -Action 'releaseAll' -Confirmed -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.action | Should -Be 'releaseAll'
            $result.auditEvent.recipient | Should -BeNullOrEmpty
            Should -Invoke Release-QuarantineMessage -ParameterFilter { $Identity -eq 'message-1' -and $ReleaseToAll -eq $true }
            $script:audits | Should -HaveCount 1
        }

        It 'deletes a message with confirmation and a success audit' {
            $script:audits = @()
            $result = Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId 'message-1' -Action 'delete' -Confirmed -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.action | Should -Be 'delete'
            $result.auditEvent.action | Should -Be 'quarantine.action.delete'
            Should -Invoke Delete-QuarantineMessage -ParameterFilter { $Identity -eq 'message-1' }
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'success'
        }

        It 'returns Graph metadata for a preview with no EXO call and no audit' {
            $script:audits = @()
            $result = Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId 'message-1' -Action 'preview' -Subject 'Invoice overdue' -SenderAddress 'sender@example.invalid' -Recipient 'user@example.invalid' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.plan.transport | Should -Be 'graph'
            $result.preview.source | Should -Be 'graph'
            $result.preview.sender | Should -Be 'sender@example.invalid'
            Should -Invoke Release-QuarantineMessage -Times 0 -Exactly
            Should -Invoke Delete-QuarantineMessage -Times 0 -Exactly
            $script:audits | Should -HaveCount 0
        }

        It 'returns a failure audit when EXO rejects the write' {
            Mock Release-QuarantineMessage {
                param($Identity, $User, [switch]$ReleaseToAll, [switch]$Confirm)
                throw 'Authorization_RequestDenied'
            }
            $script:audits = @()
            $result = Invoke-QuarantineAction -TenantId 'tenant-a' -MessageId 'message-1' -Action 'release' -Recipient 'user@example.invalid' -Confirmed -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'Authorization_RequestDenied'
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'failure'
        }
    }

    Context 'job envelope' {
        It 'reads a release envelope with confirmation, recipient, and actor' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-action-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    correlationId = 'correlation-1'
                    payload       = @{ messageId = 'message-1'; action = 'release'; recipient = 'user@example.invalid'; sender = 'sender@example.invalid'; confirm = $true; dryRun = $false; actor = 'operator-1' }
                } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-QuarantineActionJob -Path $path

                $job['TenantId'] | Should -Be 'tenant-a'
                $job['MessageId'] | Should -Be 'message-1'
                $job['Action'] | Should -Be 'release'
                $job['Recipient'] | Should -Be 'user@example.invalid'
                $job['Confirmed'] | Should -BeTrue
                $job['DryRun'] | Should -BeFalse
                $job['Actor'] | Should -Be 'operator-1'
                $job['CorrelationId'] | Should -Be 'correlation-1'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'reads a delete envelope defaulting the release fields to empty' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-action-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    payload       = @{ messageId = 'message-1'; action = 'delete' }
                } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-QuarantineActionJob -Path $path

                $job['Action'] | Should -Be 'delete'
                $job['Recipient'] | Should -Be ''
                $job['Sender'] | Should -Be ''
                $job['Confirmed'] | Should -BeFalse
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects a missing file, a bad schema version, and missing fields' {
            { Read-QuarantineActionJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'no-such-quarantine-job.json') } | Should -Throw

            $badVersion = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-action-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a'; payload = @{ action = 'delete'; messageId = 'message-1' } } | ConvertTo-Json | Set-Content -LiteralPath $badVersion -Encoding UTF8
            try {
                { Read-QuarantineActionJob -Path $badVersion } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $badVersion -Force -ErrorAction SilentlyContinue
            }

            $noAction = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-action-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ messageId = 'message-1' } } | ConvertTo-Json | Set-Content -LiteralPath $noAction -Encoding UTF8
            try {
                { Read-QuarantineActionJob -Path $noAction } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $noAction -Force -ErrorAction SilentlyContinue
            }

            $noMessage = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-action-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ action = 'delete' } } | ConvertTo-Json | Set-Content -LiteralPath $noMessage -Encoding UTF8
            try {
                { Read-QuarantineActionJob -Path $noMessage } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $noMessage -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
