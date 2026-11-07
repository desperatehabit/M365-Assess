BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-Connectors.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-connectors.ps1'

    function global:Get-InboundConnector {
        param($Identity)
    }
    function global:Get-OutboundConnector {
        param($Identity)
    }

    . $script:worker

    $script:partnerInbound = @{
        Guid             = 'conn-in-1'
        Identity         = 'conn-in-1'
        Name             = 'Partner inbound'
        Enabled          = $true
        SenderDomains    = @('partner.example.invalid')
        RecipientDomains = @()
        RequireTls       = $true
        WhenChangedUTC   = '2026-09-20T12:00:00Z'
    }

    $script:legacyInbound = @{
        Guid             = 'conn-in-2'
        Identity         = 'conn-in-2'
        Name             = 'Legacy inbound'
        Enabled          = $false
        SenderDomains    = @('legacy.example.invalid')
        RecipientDomains = @()
        RequireTls       = $false
        WhenChanged       = '2026-09-10T09:00:00Z'
    }

    $script:partnerOutbound = @{
        Guid             = 'conn-out-1'
        Identity         = 'conn-out-1'
        Name             = 'Partner outbound'
        Enabled          = $false
        SenderDomains    = @()
        RecipientDomains = @('partner.example.invalid')
        RequireTls       = $false
        WhenChangedUTC   = '2026-09-18T08:00:00Z'
    }

    function script:New-ConnectorListMock {
        Mock Get-InboundConnector { @($script:partnerInbound, $script:legacyInbound) }
        Mock Get-OutboundConnector { @($script:partnerOutbound) }
    }
}

Describe 'Get-Connectors worker (T-0851)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-Connectors -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-ConnectorRow -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-ConnectorsJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads connectors with Get- cmdlets only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-InboundConnector'
            $source | Should -Match 'Get-OutboundConnector'
            $source | Should -Not -Match 'Set-InboundConnector'
            $source | Should -Not -Match 'Set-OutboundConnector'
            $source | Should -Not -Match 'New-InboundConnector'
            $source | Should -Not -Match 'New-OutboundConnector'
            $source | Should -Not -Match 'Remove-InboundConnector'
            $source | Should -Not -Match 'Remove-OutboundConnector'
        }

        It 'entrypoint connects EXO in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-Connectors\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-ConnectorsJob -Path'
            $entrySource | Should -Match 'Get-Connectors @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'list mapping' {
        BeforeEach {
            script:New-ConnectorListMock
        }

        It 'returns the section columns with cursor paging metadata' {
            $result = Get-Connectors -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.items | Should -HaveCount 3
            $result.nextCursor | Should -Be ''
            $result.totalCount | Should -Be 3
            $result.retrievedAt | Should -Not -BeNullOrEmpty

            $inbound = @($result.items | Where-Object { $_.id -eq 'conn-in-1' })[0]
            $inbound.name | Should -Be 'Partner inbound'
            $inbound.type | Should -Be 'inbound'
            $inbound.state | Should -Be 'enabled'
            $inbound.from | Should -Be 'partner.example.invalid'
            $inbound.to | Should -BeNullOrEmpty
            $inbound.tls | Should -BeTrue
            $inbound.lastModified | Should -Be '2026-09-20T12:00:00Z'

            $outbound = @($result.items | Where-Object { $_.id -eq 'conn-out-1' })[0]
            $outbound.type | Should -Be 'outbound'
            $outbound.state | Should -Be 'disabled'
            $outbound.to | Should -Be 'partner.example.invalid'
        }

        It 'falls back to WhenChanged when WhenChangedUTC is absent' {
            $result = Get-Connectors -TenantId 'tenant-a'
            $row = @($result.items | Where-Object { $_.id -eq 'conn-in-2' })[0]
            $row.lastModified | Should -Be '2026-09-10T09:00:00Z'
        }

        It 'requires the tenant identifier' {
            { Get-Connectors -TenantId '' } | Should -Throw
        }
    }

    Context 'filters' {
        BeforeEach {
            script:New-ConnectorListMock
        }

        It 'searches connector names case-insensitively' {
            (Get-Connectors -TenantId 'tenant-a' -Search 'PARTNER').items | Should -HaveCount 2
            @((Get-Connectors -TenantId 'tenant-a' -Search 'legacy').items)[0].id | Should -Be 'conn-in-2'
        }

        It 'filters by type and state' {
            @(Get-Connectors -TenantId 'tenant-a' -Type 'inbound').items.id | Should -Be @('conn-in-2', 'conn-in-1')
            @(Get-Connectors -TenantId 'tenant-a' -Type 'outbound').items.id | Should -Be @('conn-out-1')
            @(Get-Connectors -TenantId 'tenant-a' -State 'enabled').items.id | Should -Be @('conn-in-1')
            @(Get-Connectors -TenantId 'tenant-a' -State 'disabled').items.id | Should -Be @('conn-in-2', 'conn-out-1')
        }
    }

    Context 'cursor pagination' {
        BeforeEach {
            script:New-ConnectorListMock
        }

        It 'pages through the filtered set with an opaque cursor' {
            $first = Get-Connectors -TenantId 'tenant-a' -Top 2

            $first.items | Should -HaveCount 2
            $first.totalCount | Should -Be 3
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-Connectors -TenantId 'tenant-a' -Top 2 -Cursor $first.nextCursor
            $second.items | Should -HaveCount 1
            $second.nextCursor | Should -Be ''
            @(@($first.items) + @($second.items)).Count | Should -Be 3
        }

        It 'restarts at the first page for a blank or invalid cursor' {
            (Get-Connectors -TenantId 'tenant-a' -Top 1 -Cursor '').items | Should -HaveCount 1
            $result = Get-Connectors -TenantId 'tenant-a' -Top 1 -Cursor 'not-a-cursor'
            @($result.items)[0].id | Should -Be 'conn-in-2'
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id and flat filters' {
            $jobPath = Join-Path $TestDrive 'connectors-job.json'
            @{
                tenantId = 'tenant-a'
                search   = 'partner'
                type     = 'inbound'
                state    = 'enabled'
                top      = 25
                cursor   = 'abc'
            } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-ConnectorsJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Search'] | Should -Be 'partner'
            $job['Type'] | Should -Be 'inbound'
            $job['State'] | Should -Be 'enabled'
            $job['Top'] | Should -Be 25
            $job['Cursor'] | Should -Be 'abc'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $jobPath = Join-Path $TestDrive 'connectors-job-empty.json'
            @{ tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-ConnectorsJob -Path $jobPath } | Should -Throw '*tenantId*'
            { Read-ConnectorsJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }
}
