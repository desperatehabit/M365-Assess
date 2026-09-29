BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-MessageDetail.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-message-detail.ps1'

    function global:Get-MessageTrace {
        param($MessageId, $MessageTraceId, $StartDate, $EndDate, $SenderAddress, $RecipientAddress)
    }
    function global:Get-MessageTraceDetail {
        param($MessageId, $MessageTraceId, $RecipientAddress, $StartDate, $EndDate)
    }

    . $script:worker

    $script:summary = @{
        Subject          = 'Quarterly report'
        SenderAddress    = 'sender@example.invalid'
        Recipients       = @('recipient@example.invalid')
        Received         = '2026-09-26T10:00:00Z'
        Status           = 'Delivered'
        Size             = '12 KB'
    }
    $script:detailRecords = @(
        @{
            Date   = '2026-09-26T10:00:01Z'
            Event  = 'Receive'
            Detail = 'Received by connector'
            Data   = @{
                ConnectorId        = 'Inbound from partner'
                SpamFilterVerdict  = 'Pass'
                MessageHeaders     = @{ 'Authentication-Results' = 'dkim=pass' }
            }
        },
        @{
            Date   = '2026-09-26T10:00:04Z'
            Event  = 'Deliver'
            Detail = 'Delivered to mailbox'
            Data   = @{
                ConnectorId       = 'Inbound from partner'
                TransportRuleHit  = 'Allow list rule'
            }
        }
    )

    function script:New-MessageDetailMock {
        Mock Get-MessageTrace { return $script:summary }
        Mock Get-MessageTraceDetail { return @($script:detailRecords) }
    }
}

Describe 'Get-MessageDetail worker (T-0464)' {

    Context 'the worker files' {
        It 'ships the worker function and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-MessageDetail -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'issues Get- cmdlets only and never writes to the tenant' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-MessageTrace'
            $source | Should -Not -Match 'Set-\w'
            $source | Should -Not -Match 'New-\w+ -'
            $source | Should -Not -Match 'Remove-\w'
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Set-Content'
            $source | Should -Not -Match 'Add-Content'
        }

        It 'entrypoint delegates to the worker and emits the response as JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-MessageDetail\.ps1'
            $entrySource | Should -Match 'Get-MessageDetail -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'message detail retrieval' {
        BeforeEach {
            New-MessageDetailMock
        }

        It 'returns delivery events, connectors, filters hit, and headers' {
            $result = Get-MessageDetail -TenantId 'tenant-a' -MessageId 'message-1'

            $result.tenantId | Should -Be 'tenant-a'
            $result.messageId | Should -Be 'message-1'
            $result.subject | Should -Be 'Quarterly report'
            $result.deliveryEvents.Count | Should -Be 2
            $result.deliveryEvents[0].event | Should -Be 'Receive'
            $result.deliveryEvents[1].event | Should -Be 'Deliver'
            $result.connectors | Should -Contain 'Inbound from partner'
            $result.filtersHit -join ';' | Should -Match 'SpamFilterVerdict'
            $result.filtersHit -join ';' | Should -Match 'TransportRuleHit'
            $result.headers.Count | Should -Be 1
            $result.headers[0].name | Should -Be 'Authentication-Results'
        }

        It 'omits the body and reports it as gated without -IncludeBody' {
            $result = Get-MessageDetail -TenantId 'tenant-a' -MessageId 'message-1'

            $result.body | Should -BeNullOrEmpty
            $result.bodyGated | Should -BeTrue
            $result.bodyGateReason | Should -Match 'mailtools\.content'
        }

        It 'returns the body only with -IncludeBody' {
            Mock Read-MessageBodyContent { return '<p>Hello</p>' }

            $result = Get-MessageDetail -TenantId 'tenant-a' -MessageId 'message-1' -IncludeBody

            $result.body | Should -Be '<p>Hello</p>'
            $result.bodyGated | Should -BeFalse
        }

        It 'reports the body as gated when the privileged fetch is unavailable' {
            Mock Read-MessageBodyContent { return $null }

            $result = Get-MessageDetail -TenantId 'tenant-a' -MessageId 'message-1' -IncludeBody

            $result.body | Should -BeNullOrEmpty
            $result.bodyGated | Should -BeTrue
            $result.deliveryEvents.Count | Should -Be 2
        }

        It 'throws a structured error for an unknown message' {
            Mock Get-MessageTrace { return $null }

            { Get-MessageDetail -TenantId 'tenant-a' -MessageId 'missing' } | Should -Throw '*not_found*'
        }
    }

    Context 'job envelope parsing' {
        It 'reads tenant, message, and body flag from the envelope' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ('message-detail-job-{0}.json' -f [guid]::NewGuid())
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    payload       = @{ messageId = 'message-1'; includeBody = $true }
                } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-MessageDetailJob -Path $path
                $job['TenantId'] | Should -Be 'tenant-a'
                $job['MessageId'] | Should -Be 'message-1'
                $job['IncludeBody'] | Should -BeTrue
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects an envelope without a message id' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ('message-detail-job-{0}.json' -f [guid]::NewGuid())
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    payload       = @{}
                } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8

                { Read-MessageDetailJob -Path $path } | Should -Throw '*messageId*'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
