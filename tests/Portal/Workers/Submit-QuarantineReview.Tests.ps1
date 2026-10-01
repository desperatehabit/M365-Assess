BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Submit-QuarantineReview.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/submit-quarantine-review.ps1'

    function global:Export-QuarantineMessage {
        param($Identity)
    }
    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker

    function script:New-SubmitMock {
        Mock Export-QuarantineMessage {
            param($Identity)
            return [pscustomobject]@{ Identity = $Identity; Eml = 'From: sender@example.invalid' }
        }
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body)
            return [pscustomobject]@{ id = 'sub-1'; status = 'succeeded' }
        }
    }
}

Describe 'Submit-QuarantineReview worker (T-0426)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Submit-QuarantineReview -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-QuarantineSubmitJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-QuarantineSubmitStatuses -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Resolve-QuarantineSubmitTransport -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'publishes the status, category, and EXO-support sets' {
            Get-QuarantineSubmitStatuses | Should -Be @('pending', 'inReview', 'reviewed', 'released', 'rejected')
            Get-QuarantineSubmitCategories | Should -Be @('notJunk', 'spam', 'phishing', 'malware')
            Get-QuarantineSubmitExoSupport | Should -Be @('export')
        }

        It 'resolves the §11.1 transport: EXO for the export, Graph for submit and refresh' {
            Resolve-QuarantineSubmitTransport -Operation 'export' | Should -Be 'exo'
            Resolve-QuarantineSubmitTransport -Operation 'submit' | Should -Be 'graph'
            Resolve-QuarantineSubmitTransport -Operation 'refresh' | Should -Be 'graph'
        }

        It 'maps submission statuses onto the tracked review states' {
            ConvertTo-QuarantineSubmitStatus -Value 'pending' | Should -Be 'pending'
            ConvertTo-QuarantineSubmitStatus -Value 'running' | Should -Be 'inReview'
            ConvertTo-QuarantineSubmitStatus -Value 'succeeded' | Should -Be 'reviewed'
            ConvertTo-QuarantineSubmitStatus -Value 'succeededWithErrors' | Should -Be 'reviewed'
            ConvertTo-QuarantineSubmitStatus -Value 'failed' | Should -Be 'rejected'
            ConvertTo-QuarantineSubmitStatus -Value 'something-unknown' | Should -Be 'pending'
        }

        It 'uses the EXO export and Graph submission cmdlets and never evaluates strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Export-QuarantineMessage'
            $source | Should -Match 'Invoke-MgGraphRequest'
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

        It 'entrypoint connects EXO and Graph, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Submit-QuarantineReview\.ps1'
            $entrySource | Should -Match "Connect-WorkerTenant -JobFile \`$JobFile -Service @\('Graph', 'ExchangeOnline'\)"
            $entrySource | Should -Match 'Read-QuarantineSubmitJob -Path'
            $entrySource | Should -Match 'Submit-QuarantineReview'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'submission' {
        BeforeEach {
            script:New-SubmitMock
        }

        It 'requires the tenant and message identifiers' {
            { Submit-QuarantineReview -TenantId '' -MessageId 'message-1' -Recipient 'user@example.invalid' } | Should -Throw
            { Submit-QuarantineReview -TenantId 'tenant-a' -MessageId '' -Recipient 'user@example.invalid' } | Should -Throw
        }

        It 'requires a recipient before exporting or submitting' {
            { Submit-QuarantineReview -TenantId 'tenant-a' -MessageId 'message-1' } | Should -Throw '*recipient*'
            Should -Invoke Export-QuarantineMessage -Times 0 -Exactly
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'exports the message with EXO and submits it to the Graph threat API with a success audit' {
            $script:graphCalls = [System.Collections.Generic.List[object]]::new()
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                $script:graphCalls.Add([pscustomobject]@{ Method = $Method; Uri = $Uri; Body = $Body })
                [pscustomobject]@{ id = 'sub-1'; status = 'succeeded' }
            }
            $script:audits = @()

            $result = Submit-QuarantineReview -TenantId 'tenant-a' -MessageId 'message-1' -Recipient 'user@example.invalid' -Actor 'operator-1' -CorrelationId 'correlation-1' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.action | Should -Be 'submit'
            $result.status | Should -Be 'reviewed'
            $result.submissionId | Should -Be 'sub-1'
            $result.transport | Should -Be 'graph'
            $result.exportTransport | Should -Be 'exo'

            Should -Invoke Export-QuarantineMessage -Times 1 -Exactly -ParameterFilter { $Identity -eq 'message-1' }
            $script:graphCalls | Should -HaveCount 1
            $script:graphCalls[0].Method | Should -Be 'POST'
            $script:graphCalls[0].Uri | Should -Be '/beta/security/threatSubmission/emailThreats'
            $body = $script:graphCalls[0].Body | ConvertFrom-Json
            $body.'@odata.type' | Should -Be '#microsoft.graph.security.emailContentThreatSubmission'
            $body.category | Should -Be 'spam'
            $body.recipientEmailAddress | Should -Be 'user@example.invalid'
            $body.fileContent | Should -Be 'From: sender@example.invalid'

            $result.auditEvent.action | Should -Be 'quarantine.action.submit'
            $result.auditEvent.result | Should -Be 'success'
            $result.auditEvent.actor | Should -Be 'operator-1'
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'success'
        }

        It 'returns a failure audit when the export or submission fails' {
            Mock Export-QuarantineMessage {
                param($Identity)
                throw 'ErrorInvalidIdentity: no such message'
            }
            $script:audits = @()
            $result = Submit-QuarantineReview -TenantId 'tenant-a' -MessageId 'message-1' -Recipient 'user@example.invalid' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeFalse
            $result.error | Should -Match 'ErrorInvalidIdentity'
            $script:audits | Should -HaveCount 1
            $script:audits[0].result | Should -Be 'failure'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'reads the live submission state on refresh with no write and no audit' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                [pscustomobject]@{ id = 'sub-1'; status = 'running' }
            }
            $script:audits = @()

            $result = Submit-QuarantineReview -TenantId 'tenant-a' -MessageId 'message-1' -Refresh -SubmissionId 'sub-1' -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.success | Should -BeTrue
            $result.status | Should -Be 'inReview'
            $result.refreshed | Should -BeTrue
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'GET' -and $Uri -eq '/beta/security/threatSubmission/emailThreats/sub-1' }
            Should -Invoke Export-QuarantineMessage -Times 0 -Exactly
            $script:audits | Should -HaveCount 0
        }

        It 'requires a submission id to refresh' {
            { Submit-QuarantineReview -TenantId 'tenant-a' -MessageId 'message-1' -Refresh } | Should -Throw '*submissionId*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }
    }

    Context 'job envelope' {
        It 'reads a submit envelope with the recipient, category, and actor' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-submit-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    correlationId = 'correlation-1'
                    payload       = @{ messageId = 'message-1'; recipient = 'user@example.invalid'; category = 'phishing'; refresh = $false; actor = 'operator-1' }
                } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-QuarantineSubmitJob -Path $path

                $job['TenantId'] | Should -Be 'tenant-a'
                $job['MessageId'] | Should -Be 'message-1'
                $job['Recipient'] | Should -Be 'user@example.invalid'
                $job['Category'] | Should -Be 'phishing'
                $job['Refresh'] | Should -BeFalse
                $job['Actor'] | Should -Be 'operator-1'
                $job['CorrelationId'] | Should -Be 'correlation-1'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'reads a refresh envelope with the submission id and defaults the category' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-submit-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    payload       = @{ messageId = 'message-1'; refresh = $true; submissionId = 'sub-1' }
                } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-QuarantineSubmitJob -Path $path

                $job['Refresh'] | Should -BeTrue
                $job['SubmissionId'] | Should -Be 'sub-1'
                $job['Category'] | Should -Be 'spam'
                $job['Recipient'] | Should -Be ''
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects a missing file, a bad schema version, and a missing message id' {
            { Read-QuarantineSubmitJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'no-such-quarantine-submit-job.json') } | Should -Throw

            $badVersion = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-submit-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a'; payload = @{ messageId = 'message-1' } } | ConvertTo-Json | Set-Content -LiteralPath $badVersion -Encoding UTF8
            try {
                { Read-QuarantineSubmitJob -Path $badVersion } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $badVersion -Force -ErrorAction SilentlyContinue
            }

            $noMessage = Join-Path ([System.IO.Path]::GetTempPath()) ("quarantine-submit-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ recipient = 'user@example.invalid' } } | ConvertTo-Json | Set-Content -LiteralPath $noMessage -Encoding UTF8
            try {
                { Read-QuarantineSubmitJob -Path $noMessage } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $noMessage -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
