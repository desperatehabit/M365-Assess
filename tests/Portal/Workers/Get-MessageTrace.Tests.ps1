BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-MessageTrace.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-message-trace.ps1'

    function global:Get-MessageTraceV2 {
        param($StartDate, $EndDate, $SenderAddress, $RecipientAddress, $Status, $PageSize)
    }

    . $script:worker

    $script:traceRecords = @(
        @{
            Received         = '2026-09-26T10:00:00Z'
            SenderAddress    = 'sender@example.invalid'
            RecipientAddress = 'recipient@example.invalid'
            Subject          = 'Quarterly report'
            Status           = 'Delivered'
            Event            = 'Deliver'
        },
        @{
            Received         = '2026-09-26T11:00:00Z'
            SenderAddress    = 'sender@example.invalid'
            RecipientAddress = 'other@example.invalid'
            Subject          = 'Invoice 1024'
            Status           = 'Failed'
            Event            = 'Fail'
        },
        @{
            Received         = '2026-09-27T09:30:00Z'
            SenderAddress    = 'other@example.invalid'
            RecipientAddress = 'recipient@example.invalid'
            Subject          = 'Quarterly report'
            Status           = 'Pending'
        }
    )

    function script:New-MessageTraceMock {
        Mock Get-MessageTraceV2 { return @($script:traceRecords) }
    }

    $script:windowStart = (Get-Date).ToUniversalTime().AddDays(-5).ToString('o')
    $script:windowEnd = (Get-Date).ToUniversalTime().ToString('o')
}

Describe 'Get-MessageTrace worker (T-0462)' {

    Context 'the worker files' {
        It 'ships the worker function and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-MessageTrace -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'issues Get- cmdlets only and never writes to the tenant' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-MessageTraceV2'
            $source | Should -Not -Match 'Set-\w'
            $source | Should -Not -Match 'New-\w+ '
            $source | Should -Not -Match 'Remove-\w'
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Set-Content'
            $source | Should -Not -Match 'Add-Content'
        }

        It 'entrypoint delegates to the worker and emits the response as JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-MessageTrace\.ps1'
            $entrySource | Should -Match 'Get-MessageTrace -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'trace retrieval' {
        BeforeEach {
            New-MessageTraceMock
        }

        It 'returns the §3.1 rows for a sender/recipient/subject/date filter' {
            $result = Get-MessageTrace -TenantId 'tenant-a' -SenderAddress 'sender@example.invalid' -RecipientAddress 'recipient@example.invalid' -Subject 'Quarterly' -Status 'Delivered' -StartDate $script:windowStart -EndDate $script:windowEnd

            $result.tenantId | Should -Be 'tenant-a'
            $result.items.Count | Should -Be 1
            $result.items[0].timestamp | Should -Be '2026-09-26T10:00:00Z'
            $result.items[0].sender | Should -Be 'sender@example.invalid'
            $result.items[0].recipient | Should -Be 'recipient@example.invalid'
            $result.items[0].subject | Should -Be 'Quarterly report'
            $result.items[0].status | Should -Be 'Delivered'
            $result.items[0].event | Should -Be 'Deliver'
            $result.totalCount | Should -Be 1
        }

        It 'filters by subject substring and status across senders' {
            $result = Get-MessageTrace -TenantId 'tenant-a' -Subject 'Invoice' -Status 'Failed' -StartDate $script:windowStart -EndDate $script:windowEnd

            $result.items.Count | Should -Be 1
            $result.items[0].subject | Should -Be 'Invoice 1024'
            $result.items[0].event | Should -Be 'Fail'
        }

        It 'falls back to the status for the event when the record carries none' {
            $result = Get-MessageTrace -TenantId 'tenant-a' -Status 'Pending' -StartDate $script:windowStart -EndDate $script:windowEnd

            $result.items.Count | Should -Be 1
            $result.items[0].event | Should -Be 'Pending'
        }

        It 'pages the filtered rows with an opaque cursor' {
            $first = Get-MessageTrace -TenantId 'tenant-a' -Top 2 -StartDate $script:windowStart -EndDate $script:windowEnd
            $first.items.Count | Should -Be 2
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-MessageTrace -TenantId 'tenant-a' -Top 2 -Cursor $first.nextCursor -StartDate $script:windowStart -EndDate $script:windowEnd
            $second.items.Count | Should -Be 1
            $second.nextCursor | Should -BeNullOrEmpty
            $second.items[0].subject | Should -Be 'Quarterly report'
        }

        It 'passes the exact filters through to Get-MessageTraceV2' {
            $null = Get-MessageTrace -TenantId 'tenant-a' -SenderAddress 'sender@example.invalid' -Status 'Delivered' -StartDate $script:windowStart -EndDate $script:windowEnd

            Assert-MockCalled Get-MessageTraceV2 -ParameterFilter {
                $SenderAddress -eq 'sender@example.invalid' -and
                $Status -eq 'Delivered' -and
                $StartDate -is [datetime] -and
                $EndDate -is [datetime]
            } -Scope It -Exactly 1
        }
    }

    Context 'the EXO trace window' {
        It 'rejects a start date older than the trace window with a structured error naming the limit' {
            $oldStart = (Get-Date).ToUniversalTime().AddDays(-30).ToString('o')

            { Get-MessageTrace -TenantId 'tenant-a' -StartDate $oldStart -EndDate $script:windowEnd } | Should -Throw '*window_exceeded*'
            { Get-MessageTrace -TenantId 'tenant-a' -StartDate $oldStart -EndDate $script:windowEnd } | Should -Throw '*10 days*'
            { Get-MessageTrace -TenantId 'tenant-a' -StartDate $oldStart -EndDate $script:windowEnd } | Should -Throw '*historical search*'
        }

        It 'rejects an end date older than the trace window' {
            $oldEnd = (Get-Date).ToUniversalTime().AddDays(-20).ToString('o')

            { Get-MessageTrace -TenantId 'tenant-a' -EndDate $oldEnd } | Should -Throw '*window_exceeded*'
        }

        It 'rejects a range spanning more than the trace window' {
            $start = (Get-Date).ToUniversalTime().AddDays(-9).ToString('o')
            $end = (Get-Date).ToUniversalTime().AddDays(2).ToString('o')

            { Get-MessageTrace -TenantId 'tenant-a' -StartDate $start -EndDate $end } | Should -Throw '*window_exceeded*'
        }

        It 'rejects a start date after the end date' {
            { Get-MessageTrace -TenantId 'tenant-a' -StartDate $script:windowEnd -EndDate $script:windowStart } | Should -Throw '*invalid_date_range*'
        }

        It 'accepts a range inside the trace window' {
            New-MessageTraceMock

            $result = Get-MessageTrace -TenantId 'tenant-a' -StartDate $script:windowStart -EndDate $script:windowEnd

            $result.items.Count | Should -Be 3
        }
    }

    Context 'job envelope parsing' {
        It 'reads the tenant and scoped filters from the envelope' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ('message-trace-job-{0}.json' -f [guid]::NewGuid())
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    payload       = @{
                        sender      = 'sender@example.invalid'
                        subject     = 'invoice'
                        startDate   = $script:windowStart
                        endDate     = $script:windowEnd
                        top         = 25
                        cursor      = 'abc'
                    }
                } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-MessageTraceJob -Path $path
                $job['TenantId'] | Should -Be 'tenant-a'
                $job['SenderAddress'] | Should -Be 'sender@example.invalid'
                $job['Subject'] | Should -Be 'invoice'
                $job['Top'] | Should -Be 25
                $job['Cursor'] | Should -Be 'abc'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects an envelope without a tenant' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ('message-trace-job-{0}.json' -f [guid]::NewGuid())
            try {
                @{
                    schemaVersion = 'v1'
                    payload       = @{ subject = 'invoice' }
                } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8

                { Read-MessageTraceJob -Path $path } | Should -Throw '*tenantId*'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
