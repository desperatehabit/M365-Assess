BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Start-HistoricalSearch.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/start-historical-search.ps1'

    function global:New-ComplianceSearch {
        param($Name, $ExchangeLocation, $ContentMatchQuery, $StartDate, $EndDate)
    }
    function global:Start-ComplianceSearch {
        param($Identity)
    }
    function global:Get-ComplianceSearch {
        param($Identity)
    }
    function global:Remove-ComplianceSearch {
        param($Identity, $Confirm)
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
}

Describe 'Start-HistoricalSearch worker (T-0465)' {

    Context 'the worker files' {
        It 'ships the handler functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Start-HistoricalSearch -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-HistoricalSearchResult -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Stop-HistoricalSearch -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-HistoricalSearchJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'drives the EXO compliance-search backend' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'New-ComplianceSearch'
            $source | Should -Match 'Start-ComplianceSearch'
            $source | Should -Match 'Get-ComplianceSearch'
            $source | Should -Match 'Remove-ComplianceSearch'
        }

        It 'never persists message data to disk, logs, or artifacts' {
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
            $entrySource | Should -Match 'Start-HistoricalSearch\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-HistoricalSearchJob -Path'
            $entrySource | Should -Match 'Start-HistoricalSearch -TenantId'
            $entrySource | Should -Match 'Get-HistoricalSearchResult -TenantId'
            $entrySource | Should -Match 'Stop-HistoricalSearch -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'start' {
        BeforeEach {
            Mock New-ComplianceSearch { return @{ Name = $Name } }
            Mock Start-ComplianceSearch { }
        }

        It 'creates and starts the compliance search and returns the running job' {
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            $job = Start-HistoricalSearch -TenantId 'tenant-a' -JobId 'job-1' -Query 'subject:invoice' -ExchangeLocation @('mailbox-a') -WriteProgress $progress.seam -WriteAudit $audits.seam

            $job.state | Should -Be 'running'
            $job.tenantId | Should -Be 'tenant-a'
            $job.searchName | Should -Be 'historical-search-job-1'
            Should -Invoke New-ComplianceSearch -Times 1 -Exactly
            Should -Invoke Start-ComplianceSearch -Times 1 -Exactly
        }

        It 'emits queued then running progress for the enqueued job' {
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            $null = Start-HistoricalSearch -TenantId 'tenant-a' -JobId 'job-1' -Query 'subject:invoice' -WriteProgress $progress.seam -WriteAudit $audits.seam

            @($progress.store.events).Count | Should -Be 2
            @($progress.store.events)[0].state | Should -Be 'queued'
            @($progress.store.events)[1].state | Should -Be 'running'
            @($progress.store.events)[1].jobId | Should -Be 'job-1'
            @($progress.store.events)[1].searchName | Should -Be 'historical-search-job-1'
        }

        It 'records the start audit event' {
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            $null = Start-HistoricalSearch -TenantId 'tenant-a' -JobId 'job-1' -Query 'subject:invoice' -WriteProgress $progress.seam -WriteAudit $audits.seam

            @($audits.store.events).Count | Should -Be 1
            @($audits.store.events)[0].action | Should -Be 'mail.historical_search.start'
            @($audits.store.events)[0].tenantId | Should -Be 'tenant-a'
            @($audits.store.events)[0].targetId | Should -Be 'job-1'
        }

        It 'requires a non-empty query' {
            $progress = script:New-ProgressCollector
            { Start-HistoricalSearch -TenantId 'tenant-a' -JobId 'job-1' -Query '   ' -WriteProgress $progress.seam } | Should -Throw '*invalid_query*'
            Should -Invoke New-ComplianceSearch -Times 0 -Exactly
        }

        It 'rejects a window where the start follows the end' {
            $progress = script:New-ProgressCollector
            { Start-HistoricalSearch -TenantId 'tenant-a' -JobId 'job-1' -Query 'subject:invoice' -StartDate '2026-09-28T00:00:00Z' -EndDate '2026-09-01T00:00:00Z' -WriteProgress $progress.seam } | Should -Throw '*invalid_date_range*'
            Should -Invoke New-ComplianceSearch -Times 0 -Exactly
        }
    }

    Context 'progress and completion' {
        It 'reports running progress with the EXO percent-complete' {
            Mock Get-ComplianceSearch { return [pscustomobject]@{ Status = 'Running'; PercentComplete = 40 } }
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            $job = Get-HistoricalSearchResult -TenantId 'tenant-a' -JobId 'job-1' -SearchName 'historical-search-job-1' -WriteProgress $progress.seam -WriteAudit $audits.seam

            $job.state | Should -Be 'running'
            $job.progressPercent | Should -Be 40
            @($progress.store.events).Count | Should -Be 1
            @($progress.store.events)[0].state | Should -Be 'running'
            @($audits.store.events).Count | Should -Be 0
        }

        It 'returns matches with the download reference and the finish audit on completion' {
            Mock Get-ComplianceSearch {
                return [pscustomobject]@{
                    Status         = 'Completed'
                    SuccessResults = @{ 'mailbox-a' = 1 }
                }
            }
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            $job = Get-HistoricalSearchResult -TenantId 'tenant-a' -JobId 'job-1' -SearchName 'historical-search-job-1' -WriteProgress $progress.seam -WriteAudit $audits.seam

            $job.state | Should -Be 'succeeded'
            @($job.matches).Count | Should -Be 1
            @($job.matches)[0].mailbox | Should -Be 'mailbox-a'
            $job.downloadRef | Should -Be 'compliance-search/historical-search-job-1/export'
            @($progress.store.events)[-1].state | Should -Be 'succeeded'
            @($audits.store.events).Count | Should -Be 1
            @($audits.store.events)[0].action | Should -Be 'mail.historical_search.finish'
        }

        It 'returns metadata-only matches without message bodies' {
            Mock Get-ComplianceSearch {
                return [pscustomobject]@{
                    Status  = 'Completed'
                    Results = @(
                        [pscustomobject]@{ Mailbox = 'mailbox-a'; Subject = 'Quarterly invoice'; ReceivedAt = '2026-09-20T10:00:00Z'; Size = 1234; Body = 'secret-body'; BodyPreview = 'secret-preview' }
                    )
                }
            }
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            $job = Get-HistoricalSearchResult -TenantId 'tenant-a' -JobId 'job-1' -SearchName 'historical-search-job-1' -WriteProgress $progress.seam -WriteAudit $audits.seam

            $match = @($job.matches)[0]
            $match.mailbox | Should -Be 'mailbox-a'
            $match.subject | Should -Be 'Quarterly invoice'
            $match.PSObject.Properties.Name | Should -Not -Contain 'Body'
            $match.PSObject.Properties.Name | Should -Not -Contain 'BodyPreview'
        }

        It 'reports failure with a finish audit' {
            Mock Get-ComplianceSearch { return [pscustomobject]@{ Status = 'Failed' } }
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            $job = Get-HistoricalSearchResult -TenantId 'tenant-a' -JobId 'job-1' -SearchName 'historical-search-job-1' -WriteProgress $progress.seam -WriteAudit $audits.seam

            $job.state | Should -Be 'failed'
            @($progress.store.events)[-1].state | Should -Be 'failed'
            @($audits.store.events)[0].action | Should -Be 'mail.historical_search.finish'
        }

        It 'throws a structured error for an unknown search' {
            Mock Get-ComplianceSearch { return $null }
            $progress = script:New-ProgressCollector

            { Get-HistoricalSearchResult -TenantId 'tenant-a' -JobId 'job-9' -SearchName 'historical-search-job-9' -WriteProgress $progress.seam } | Should -Throw '*not_found*'
        }
    }

    Context 'cancel' {
        BeforeEach {
            Mock Remove-ComplianceSearch { }
        }

        It 'removes the in-flight search, emits cancelled progress, and audits the cancel' {
            Mock Get-ComplianceSearch { return [pscustomobject]@{ Status = 'Running'; PercentComplete = 55 } }
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            $job = Stop-HistoricalSearch -TenantId 'tenant-a' -JobId 'job-1' -SearchName 'historical-search-job-1' -WriteProgress $progress.seam -WriteAudit $audits.seam

            $job.state | Should -Be 'cancelled'
            Should -Invoke Remove-ComplianceSearch -Times 1 -Exactly
            @($progress.store.events).Count | Should -Be 1
            @($progress.store.events)[0].state | Should -Be 'cancelled'
            @($audits.store.events).Count | Should -Be 1
            @($audits.store.events)[0].action | Should -Be 'mail.historical_search.cancel'
        }

        It 'refuses to cancel a completed search' {
            Mock Get-ComplianceSearch { return [pscustomobject]@{ Status = 'Completed' } }
            $progress = script:New-ProgressCollector

            { Stop-HistoricalSearch -TenantId 'tenant-a' -JobId 'job-1' -SearchName 'historical-search-job-1' -WriteProgress $progress.seam } | Should -Throw '*not_cancellable*'
            Should -Invoke Remove-ComplianceSearch -Times 0 -Exactly
        }

        It 'throws a structured error for an unknown search' {
            Mock Get-ComplianceSearch { return $null }
            $progress = script:New-ProgressCollector

            { Stop-HistoricalSearch -TenantId 'tenant-a' -JobId 'job-9' -SearchName 'historical-search-job-9' -WriteProgress $progress.seam } | Should -Throw '*not_found*'
        }
    }

    Context 'no-persistence rule' {
        It 'writes no files while starting and completing a search' {
            Mock New-ComplianceSearch { return @{ Name = $Name } }
            Mock Start-ComplianceSearch { }
            Mock Get-ComplianceSearch {
                return [pscustomobject]@{
                    Status         = 'Completed'
                    SuccessResults = @{ 'mailbox-a' = 2 }
                }
            }
            $progress = script:New-ProgressCollector
            $audits = script:New-AuditCollector

            Push-Location -LiteralPath $TestDrive
            try {
                $before = @(Get-ChildItem -LiteralPath $TestDrive -Recurse -Force -ErrorAction SilentlyContinue).Count
                $null = Start-HistoricalSearch -TenantId 'tenant-a' -JobId 'job-1' -Query 'subject:invoice' -WriteProgress $progress.seam -WriteAudit $audits.seam
                $job = Get-HistoricalSearchResult -TenantId 'tenant-a' -JobId 'job-1' -SearchName 'historical-search-job-1' -WriteProgress $progress.seam -WriteAudit $audits.seam
                @($job.matches).Count | Should -Be 1
                $after = @(Get-ChildItem -LiteralPath $TestDrive -Recurse -Force -ErrorAction SilentlyContinue).Count
                $after | Should -Be $before
            }
            finally {
                Pop-Location
            }
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id, action, and scoped parameters' {
            $jobPath = Join-Path $TestDrive 'historical-search-job.json'
            @{
                schemaVersion = 'v1'
                jobId         = 'job-1'
                jobType       = 'historical-search'
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
                        action           = 'start'
                        query            = 'subject:invoice'
                        exchangeLocation = @('mailbox-a')
                        top              = 25
                    }
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-HistoricalSearchJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['JobId'] | Should -Be 'job-1'
            $job['Action'] | Should -Be 'start'
            $job['Query'] | Should -Be 'subject:invoice'
            @($job['ExchangeLocation']) | Should -Be @('mailbox-a')
            $job['Top'] | Should -Be 25
        }

        It 'rejects envelopes with an unsupported schema version or action' {
            $badVersion = Join-Path $TestDrive 'historical-search-job-bad.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $badVersion -Encoding UTF8
            { Read-HistoricalSearchJob -Path $badVersion } | Should -Throw '*schemaVersion*'

            $badAction = Join-Path $TestDrive 'historical-search-job-action.json'
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ filters = @{ action = 'export' } } } | ConvertTo-Json -Depth 5 | Set-Content -Path $badAction -Encoding UTF8
            { Read-HistoricalSearchJob -Path $badAction } | Should -Throw '*action*'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $empty = Join-Path $TestDrive 'historical-search-job-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $empty -Encoding UTF8

            { Read-HistoricalSearchJob -Path $empty } | Should -Throw '*tenantId*'
            { Read-HistoricalSearchJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }
}
