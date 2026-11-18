BeforeAll {
    $script:repoRoot = (Resolve-Path -LiteralPath (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
    $script:worker = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/Get-Quarantine.ps1'
    $script:entrypoint = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/get-quarantine.ps1'

    Remove-Item -Path 'Function:\Preview-QuarantineMessage' -ErrorAction SilentlyContinue
    function global:Get-QuarantineMessage { param($Identity) }

    . $script:worker

    $script:emailSpam = @{
        Identity         = 'msg-1'
        ReceivedTime     = '2026-09-28T09:00:00Z'
        SenderAddress    = 'spammer@example.invalid'
        RecipientAddress = 'alice@contoso.invalid'
        Subject          = 'Invoice overdue'
        QuarantineTypes  = 'Spam'
        PolicyName       = 'Default Spam Policy'
        PolicyType       = 'HostedContentFilterPolicy'
        Expires          = '2026-10-28T09:00:00Z'
        ReleaseStatus    = 'Quarantined'
        Direction        = 'Inbound'
        Size             = 12345
    }
    $script:emailPhish = @{
        Identity         = 'msg-2'
        ReceivedTime     = '2026-09-27T08:00:00Z'
        SenderAddress    = 'phisher@example.invalid'
        RecipientAddress = 'bob@contoso.invalid'
        Subject          = 'Urgent password reset'
        QuarantineTypes  = 'Phish'
        PolicyName       = 'Strict Phish Policy'
        PolicyType       = 'AntiPhishPolicy'
        Expires          = '2026-10-27T08:00:00Z'
        ReleaseStatus    = 'Released'
        Direction        = 'Outbound'
        Size             = 4096
    }
    $script:fileItem = @{
        Identity         = 'file-1'
        EntityType       = 'File'
        ReceivedTime     = '2026-09-26T12:00:00Z'
        SenderAddress    = 'uploader@example.invalid'
        RecipientAddress = 'alice@contoso.invalid'
        Subject          = 'payload.exe'
        QuarantineTypes  = 'Malware'
        PolicyName       = 'Safe Attachments'
        PolicyType       = 'MalwareFilterPolicy'
        Expires          = $null
        ReleaseStatus    = 'NotReleased'
        Direction        = 'Inbound'
        Size             = 99000
    }
    $script:teamsItem = @{
        Identity         = 'teams-1'
        EntityType       = 'TeamsMessage'
        ReceivedTime     = '2026-09-25T15:00:00Z'
        SenderAddress    = 'external@partner.invalid'
        RecipientAddress = 'team-channel@contoso.invalid'
        Subject          = 'Suspicious link in chat'
        QuarantineTypes  = 'Malware'
        PolicyName       = 'Teams Protection'
        PolicyType       = 'SafeAttachmentsPolicy'
        Expires          = '2026-10-25T15:00:00Z'
        ReleaseStatus    = 'Quarantined'
        Direction        = 'Inbound'
        Size             = 2048
    }

    function script:New-QuarantineListMock {
        Mock Get-QuarantineMessage {
            param($Identity)
            $all = @($script:emailSpam, $script:emailPhish, $script:fileItem, $script:teamsItem)
            if ($Identity) {
                return @($all | Where-Object -FilterScript { $_.Identity -eq $Identity })
            }
            return $all
        }
    }
}

AfterAll {
    Remove-Item -Path 'Function:\Get-QuarantineMessage' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Function:\Preview-QuarantineMessage' -ErrorAction SilentlyContinue
}

Describe 'Get-Quarantine worker (T-0852)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command -Name 'Get-Quarantine' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'ConvertTo-QuarantineTab' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'ConvertTo-QuarantineRow' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'Read-QuarantineJob' -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads quarantine messages with read-only cmdlets' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-QuarantineMessage'
            $source | Should -Not -Match 'Release-QuarantineMessage'
            $source | Should -Not -Match 'Delete-QuarantineMessage'
            $source | Should -Not -Match 'Export-QuarantineMessage'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'never persists quarantine data to disk, logs, or artifacts' {
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
            $entrySource | Should -Match 'Get-Quarantine\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-QuarantineJob -Path'
            $entrySource | Should -Match 'Get-Quarantine @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'tab normalization' {
        It 'accepts email, files, and teams aliases' {
            ConvertTo-QuarantineTab -Tab 'email' | Should -Be 'email'
            ConvertTo-QuarantineTab -Tab 'messages' | Should -Be 'email'
            ConvertTo-QuarantineTab -Tab 'files' | Should -Be 'files'
            ConvertTo-QuarantineTab -Tab 'teams' | Should -Be 'teams'
            ConvertTo-QuarantineTab -Tab 'teamsmessages' | Should -Be 'teams'
            ConvertTo-QuarantineTab -Tab 'teams-messages' | Should -Be 'teams'
        }

        It 'rejects unknown tabs' {
            { ConvertTo-QuarantineTab -Tab 'userReported' } | Should -Throw '*Unknown quarantine tab*'
            { Get-Quarantine -TenantId 'tenant-a' -Tab 'userReported' } | Should -Throw '*Unknown quarantine tab*'
        }
    }

    Context 'row mapping' {
        It 'maps EXO quarantine fields to the BFF QuarantineMessage shape' {
            $row = ConvertTo-QuarantineRow -Message $script:emailSpam

            $row.messageId | Should -Be 'msg-1'
            $row.tab | Should -Be 'email'
            $row.received | Should -Be '2026-09-28T09:00:00Z'
            $row.subject | Should -Be 'Invoice overdue'
            $row.sender | Should -Be 'spammer@example.invalid'
            $row.recipient | Should -Be 'alice@contoso.invalid'
            $row.reason | Should -Be 'Spam'
            $row.policy | Should -Be 'Default Spam Policy'
            $row.expires | Should -Be '2026-10-28T09:00:00Z'
            $row.state | Should -Be 'Quarantined'
            $row.direction | Should -Be 'Inbound'
            $row.policyType | Should -Be 'HostedContentFilterPolicy'
            $row.size | Should -Be 12345
        }

        It 'handles MessageId fallback, array recipients, and null expires' {
            $msg = [pscustomobject]@{
                MessageId        = 'alt-id-1'
                ReceivedTime     = [datetime]'2026-09-20T10:00:00Z'
                SenderAddress    = 's@example.invalid'
                RecipientAddress = @('u1@example.invalid', 'u2@example.invalid')
                Subject          = 'Multi'
                Type             = 'Phish'
                PolicyName       = 'Default'
                Expires          = $null
                ReleaseStatus    = ''
                Direction        = 'Inbound'
            }

            $row = ConvertTo-QuarantineRow -Message $msg -Tab 'email'

            $row.messageId | Should -Be 'alt-id-1'
            $row.recipient | Should -Be 'u1@example.invalid, u2@example.invalid'
            $row.reason | Should -Be 'Phish'
            $row.expires | Should -BeNullOrEmpty
            $row.state | Should -Be 'Quarantined'
        }
    }

    Context 'list mode and filtering' {
        BeforeEach {
            script:New-QuarantineListMock
        }

        It 'filters by tab across email, files, and teams' {
            $emailPage = Get-Quarantine -TenantId 'tenant-a' -Tab 'email'
            $emailPage.tenantId | Should -Be 'tenant-a'
            $emailPage.tab | Should -Be 'email'
            $emailPage.totalCount | Should -Be 2
            $emailPage.items | Should -HaveCount 2
            $emailPage.nextCursor | Should -BeNullOrEmpty
            $emailPage.retrievedAt | Should -Not -BeNullOrEmpty

            $filesPage = Get-Quarantine -TenantId 'tenant-a' -Tab 'files'
            $filesPage.tab | Should -Be 'files'
            $filesPage.totalCount | Should -Be 1
            @($filesPage.items)[0].messageId | Should -Be 'file-1'

            $teamsPage = Get-Quarantine -TenantId 'tenant-a' -Tab 'teams-messages'
            $teamsPage.tab | Should -Be 'teams'
            $teamsPage.totalCount | Should -Be 1
            @($teamsPage.items)[0].messageId | Should -Be 'teams-1'
        }

        It 'filters by Reason, Direction, Recipient, State, DateFrom, and DateTo' {
            $byReason = Get-Quarantine -TenantId 'tenant-a' -Tab 'email' -Reason 'phish'
            $byReason.totalCount | Should -Be 1
            @($byReason.items)[0].messageId | Should -Be 'msg-2'

            $byDirection = Get-Quarantine -TenantId 'tenant-a' -Tab 'email' -Direction 'outbound'
            $byDirection.totalCount | Should -Be 1
            @($byDirection.items)[0].messageId | Should -Be 'msg-2'

            $byRecipient = Get-Quarantine -TenantId 'tenant-a' -Tab 'email' -Recipient 'alice'
            $byRecipient.totalCount | Should -Be 1
            @($byRecipient.items)[0].messageId | Should -Be 'msg-1'

            $byState = Get-Quarantine -TenantId 'tenant-a' -Tab 'email' -State 'Released'
            $byState.totalCount | Should -Be 1
            @($byState.items)[0].messageId | Should -Be 'msg-2'

            $byDate = Get-Quarantine -TenantId 'tenant-a' -Tab 'email' -DateFrom '2026-09-28T00:00:00Z' -DateTo '2026-09-28T23:59:59Z'
            $byDate.totalCount | Should -Be 1
            @($byDate.items)[0].messageId | Should -Be 'msg-1'
        }

        It 'paginates with offset cursors' {
            $page1 = Get-Quarantine -TenantId 'tenant-a' -Tab 'email' -Limit 1
            $page1.totalCount | Should -Be 2
            $page1.items | Should -HaveCount 1
            @($page1.items)[0].messageId | Should -Be 'msg-1'
            $page1.nextCursor | Should -Not -BeNullOrEmpty

            $page2 = Get-Quarantine -TenantId 'tenant-a' -Tab 'email' -Limit 1 -Cursor $page1.nextCursor
            $page2.totalCount | Should -Be 2
            $page2.items | Should -HaveCount 1
            @($page2.items)[0].messageId | Should -Be 'msg-2'
            $page2.nextCursor | Should -BeNullOrEmpty
        }
    }

    Context 'single-message mode' {
        BeforeEach {
            script:New-QuarantineListMock
        }

        It 'returns null when the message is not found' {
            $result = Get-Quarantine -TenantId 'tenant-a' -MessageId 'missing-id'
            $result | Should -BeNullOrEmpty
            Should -Invoke Get-QuarantineMessage -Times 1 -Exactly -ParameterFilter { $Identity -eq 'missing-id' }
        }

        It 'falls back to Graph metadata preview when Preview-QuarantineMessage is absent' {
            $detail = Get-Quarantine -TenantId 'tenant-a' -MessageId 'msg-1'

            $detail.messageId | Should -Be 'msg-1'
            $detail.subject | Should -Be 'Invoice overdue'
            $detail.preview.source | Should -Be 'graph'
            $detail.preview.available | Should -BeFalse
            $detail.preview.body | Should -BeNullOrEmpty
        }

        Context 'when Preview-QuarantineMessage is available' {
            BeforeAll {
                function global:Preview-QuarantineMessage { param($Identity) }
            }

            AfterAll {
                Remove-Item -Path 'Function:\Preview-QuarantineMessage' -ErrorAction SilentlyContinue
            }

            It 'returns EXO preview body when Preview-QuarantineMessage succeeds' {
                Mock Preview-QuarantineMessage {
                    param($Identity)
                    return [pscustomobject]@{ Identity = $Identity; Body = '<p>Preview content</p>' }
                }

                $detail = Get-Quarantine -TenantId 'tenant-a' -MessageId 'msg-1'

                $detail.preview.source | Should -Be 'exo'
                $detail.preview.available | Should -BeTrue
                $detail.preview.body | Should -Be '<p>Preview content</p>'
            }

            It 'falls back to Graph metadata when Preview-QuarantineMessage throws' {
                Mock Preview-QuarantineMessage {
                    param($Identity)
                    throw 'Preview unavailable'
                }

                $detail = Get-Quarantine -TenantId 'tenant-a' -MessageId 'msg-1'

                $detail.preview.source | Should -Be 'graph'
                $detail.preview.available | Should -BeFalse
                $detail.preview.body | Should -BeNullOrEmpty
            }
        }
    }

    Context 'job envelope' {
        It 'parses list filters, tab, limit, and ISO dates from a v1 envelope' {
            $jobPath = Join-Path -Path $TestDrive -ChildPath 'quarantine-job.json'
            @{
                schemaVersion = 'v1'
                jobId         = 'job-1'
                tenantId      = 'tenant-a'
                correlationId = 'corr-1'
                payload       = @{
                    tab       = 'teams-messages'
                    reason    = 'Malware'
                    direction = 'Inbound'
                    recipient = 'alice@contoso.invalid'
                    state     = 'Quarantined'
                    dateFrom  = '2026-09-01T00:00:00Z'
                    dateTo    = '2026-09-30T23:59:59Z'
                    cursor    = 'NTA'
                    limit     = 25
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jobPath -Encoding UTF8

            $job = Read-QuarantineJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Tab'] | Should -Be 'teams'
            $job['Reason'] | Should -Be 'Malware'
            $job['Direction'] | Should -Be 'Inbound'
            $job['Recipient'] | Should -Be 'alice@contoso.invalid'
            $job['State'] | Should -Be 'Quarantined'
            $job['DateFrom'] | Should -Match '^2026-09-01T00:00:00'
            $job['DateTo'] | Should -Match '^2026-09-30T23:59:59'
            $job['Cursor'] | Should -Be 'NTA'
            $job['Limit'] | Should -Be 25
        }

        It 'parses single-message mode envelope with default tab and limit' {
            $jobPath = Join-Path -Path $TestDrive -ChildPath 'quarantine-single-job.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ messageId = 'msg-1' }
            } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jobPath -Encoding UTF8

            $job = Read-QuarantineJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['MessageId'] | Should -Be 'msg-1'
            $job['Tab'] | Should -Be 'email'
            $job['Limit'] | Should -Be 50
        }

        It 'rejects unsupported schemaVersion, missing tenantId, unknown tab, and missing file' {
            $badVersion = Join-Path -Path $TestDrive -ChildPath 'quarantine-bad-ver.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -LiteralPath $badVersion -Encoding UTF8
            { Read-QuarantineJob -Path $badVersion } | Should -Throw '*schemaVersion*'

            $noTenant = Join-Path -Path $TestDrive -ChildPath 'quarantine-no-tenant.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -LiteralPath $noTenant -Encoding UTF8
            { Read-QuarantineJob -Path $noTenant } | Should -Throw '*tenantId*'

            $badTab = Join-Path -Path $TestDrive -ChildPath 'quarantine-bad-tab.json'
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ tab = 'userReported' } } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $badTab -Encoding UTF8
            { Read-QuarantineJob -Path $badTab } | Should -Throw '*Unknown quarantine tab*'

            { Read-QuarantineJob -Path (Join-Path -Path $TestDrive -ChildPath 'missing.json') } | Should -Throw '*not found*'
        }
    }
}
