BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-TransportRules.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-transport-rules.ps1'

    function global:Get-TransportRule {
        param($Identity)
    }

    . $script:worker

    $script:quarantineRule = @{
        Guid                              = 'rule-1'
        Identity                          = 'rule-1'
        Name                              = 'Quarantine executables'
        Priority                          = 0
        State                             = 'Enabled'
        FromScope                         = 'InOrganization'
        HasAttachment                     = $true
        AttachmentExtensionMatchesWords   = @('exe', 'bat')
        Quarantine                        = $true
        ExceptIfSentToMemberOf            = @('allow-list@example.invalid')
        WhenChangedUTC                    = '2026-09-20T12:00:00Z'
    }
    $script:disclaimerRule = @{
        Guid                              = 'rule-2'
        Identity                          = 'rule-2'
        Name                              = 'Prepend external disclaimer'
        Priority                          = 1
        State                             = 'Disabled'
        FromScope                         = 'NotInOrganization'
        SentToScope                       = 'InOrganization'
        PrependSubject                    = '[External] '
        ExceptIfFromMemberOf              = @()
        WhenChanged                       = '2026-09-18T08:00:00Z'
    }
    $script:rejectRule = @{
        Guid                              = 'rule-3'
        Identity                          = 'rule-3'
        Name                              = 'Reject spoofed executive mail'
        Priority                          = 2
        State                             = 'Enabled'
        From                              = @('executive@example.invalid')
        SentTo                            = @('staff@example.invalid')
        RejectMessageReasonText           = 'Suspected spoof'
        ExceptIfFrom                      = @('assistant@example.invalid')
        WhenChangedUTC                    = '2026-09-19T09:30:00Z'
    }

    function script:New-TransportRuleListMock {
        Mock Get-TransportRule {
            param($Identity)
            if ($PSBoundParameters.ContainsKey('Identity') -and -not [string]::IsNullOrWhiteSpace([string]$Identity)) {
                $found = @($script:quarantineRule, $script:disclaimerRule, $script:rejectRule) |
                    Where-Object { $_.Guid -eq $Identity -or $_.Name -eq $Identity }
                return @($found)[0]
            }
            return @($script:quarantineRule, $script:disclaimerRule, $script:rejectRule)
        }
    }
}

Describe 'Get-TransportRules worker (T-0401)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-TransportRules -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-TransportRuleRow -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-TransportRulesJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads rules with Get- cmdlets only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-TransportRule'
            $source | Should -Not -Match 'Set-TransportRule'
            $source | Should -Not -Match 'New-TransportRule'
            $source | Should -Not -Match 'Remove-TransportRule'
            $source | Should -Not -Match 'Enable-TransportRule'
            $source | Should -Not -Match 'Disable-TransportRule'
        }

        It 'never persists transport-rule state to disk, logs, or artifacts' {
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
            $entrySource | Should -Match 'Get-TransportRules\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-TransportRulesJob -Path'
            $entrySource | Should -Match 'Get-TransportRules @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'list mapping' {
        BeforeEach {
            script:New-TransportRuleListMock
        }

        It 'returns the section columns with cursor paging metadata' {
            $result = Get-TransportRules -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.items | Should -HaveCount 3
            $result.nextCursor | Should -Be ''
            $result.totalCount | Should -Be 3
            $result.retrievedAt | Should -Not -BeNullOrEmpty
            $row = @($result.items | Where-Object { $_.id -eq 'rule-1' })[0]
            $row.name | Should -Be 'Quarantine executables'
            $row.priority | Should -Be 0
            $row.state | Should -Be 'enabled'
            $row.conditions | Should -Contain 'HasAttachment=True'
            $row.actions | Should -Contain 'Quarantine=True'
            $row.exceptions | Should -Contain 'ExceptIfSentToMemberOf=allow-list@example.invalid'
            $row.lastModified | Should -Be '2026-09-20T12:00:00Z'
        }

        It 'orders rows by priority and maps the disabled state' {
            $result = Get-TransportRules -TenantId 'tenant-a'

            @($result.items).id | Should -Be @('rule-1', 'rule-2', 'rule-3')
            $disabled = @($result.items | Where-Object { $_.id -eq 'rule-2' })[0]
            $disabled.state | Should -Be 'disabled'
            $disabled.priority | Should -Be 1
        }

        It 'falls back to WhenChanged when WhenChangedUTC is absent' {
            $result = Get-TransportRules -TenantId 'tenant-a'

            $row = @($result.items | Where-Object { $_.id -eq 'rule-2' })[0]
            $row.lastModified | Should -Be '2026-09-18T08:00:00Z'
        }

        It 'requires the tenant identifier' {
            { Get-TransportRules -TenantId '' } | Should -Throw
        }
    }

    Context 'filters' {
        BeforeEach {
            script:New-TransportRuleListMock
        }

        It 'searches rule names case-insensitively' {
            (Get-TransportRules -TenantId 'tenant-a' -Search 'QUARANTINE').items | Should -HaveCount 1
            $result = Get-TransportRules -TenantId 'tenant-a' -Search 'disclaimer'
            $result.items | Should -HaveCount 1
            @($result.items)[0].id | Should -Be 'rule-2'
        }

        It 'filters by enabled and disabled state' {
            @(Get-TransportRules -TenantId 'tenant-a' -State 'enabled').items.id | Should -Be @('rule-1', 'rule-3')
            @(Get-TransportRules -TenantId 'tenant-a' -State 'disabled').items.id | Should -Be @('rule-2')
        }
    }

    Context 'cursor pagination' {
        BeforeEach {
            script:New-TransportRuleListMock
        }

        It 'pages through the filtered set with an opaque cursor' {
            $first = Get-TransportRules -TenantId 'tenant-a' -Top 2

            $first.items | Should -HaveCount 2
            $first.totalCount | Should -Be 3
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-TransportRules -TenantId 'tenant-a' -Top 2 -Cursor $first.nextCursor
            $second.items | Should -HaveCount 1
            $second.nextCursor | Should -Be ''
            @(@($first.items) + @($second.items)).id | Should -Be @('rule-1', 'rule-2', 'rule-3')
        }

        It 'restarts at the first page for a blank or invalid cursor' {
            (Get-TransportRules -TenantId 'tenant-a' -Top 1 -Cursor '').items | Should -HaveCount 1
            $result = Get-TransportRules -TenantId 'tenant-a' -Top 1 -Cursor 'not-a-cursor'
            @($result.items)[0].id | Should -Be 'rule-1'
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id and payload filters' {
            $jobPath = Join-Path $TestDrive 'transport-rules-job.json'
            @{
                schemaVersion = 'v1'
                jobId         = 'job-1'
                jobType       = 'assessment'
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
                    filters       = @{ state = 'enabled'; top = 25 }
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-TransportRulesJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['State'] | Should -Be 'enabled'
            $job['Top'] | Should -Be 25
            $job['Search'] | Should -Be ''
        }

        It 'rejects envelopes with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'transport-rules-job-bad.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-TransportRulesJob -Path $jobPath } | Should -Throw '*schemaVersion*'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $jobPath = Join-Path $TestDrive 'transport-rules-job-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-TransportRulesJob -Path $jobPath } | Should -Throw '*tenantId*'
            { Read-TransportRulesJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }
}
