BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-Filters.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-filters.ps1'

    function global:Get-HostedContentFilterPolicy { param() }
    function global:Get-HostedContentFilterRule { param() }
    function global:Get-AntiPhishPolicy { param() }
    function global:Get-AntiPhishRule { param() }
    function global:Get-MalwareFilterPolicy { param() }
    function global:Get-MalwareFilterRule { param() }
    function global:Get-HostedConnectionFilterPolicy { param() }
    function global:Get-HostedConnectionFilterRule { param() }

    . $script:worker

    $script:spamPolicy = @{
        Name                      = 'Default'
        BulkThreshold             = 6
        SpamAction                = 'MoveToJmf'
        HighConfidenceSpamAction  = 'Quarantine'
        PhishSpamAction           = 'Quarantine'
        BulkSpamAction            = 'MoveToJmf'
        QuarantineRetentionPeriod = 15
        SpamZapEnabled            = $true
        PhishZapEnabled           = $true
        IsDefault                 = $true
        WhenChangedUTC            = '2026-09-20T10:00:00.000Z'
    }
    $script:spamRule = @{
        Name          = 'Default'
        Priority      = 0
        State         = 'Enabled'
        WhenChangedUTC = '2026-09-21T10:00:00.000Z'
    }
    $script:phishPolicy = @{
        Name                                   = 'Standard Preset Policy'
        Enabled                                = $true
        PhishThresholdLevel                    = 2
        EnableMailboxIntelligence              = $true
        EnableMailboxIntelligenceProtection    = $true
        EnableSpoofIntelligence                = $true
        EnableFirstContactSafetyTips           = $true
        EnableUnauthenticatedSender            = $false
        EnableViaTag                           = $true
        EnableTargetedUserProtection           = $false
        EnableTargetedDomainsProtection        = $false
        EnableOrganizationDomainsProtection    = $false
        WhenChangedUTC                         = '2026-09-22T10:00:00.000Z'
    }
    $script:phishRule = @{
        Name     = 'Standard Preset Policy'
        Priority = 1
        State    = 'Enabled'
    }
    $script:malwarePolicy = @{
        Name                                     = 'Default'
        EnableFileFilter                         = $true
        FileFilterAction                         = 'Quarantine'
        ZapEnabled                               = $true
        EnableInternalSenderAdminNotifications   = $false
        EnableExternalSenderAdminNotifications   = $false
        FileTypes                                = @('exe', 'js')
        IsDefault                                = $true
        WhenChangedUTC                           = '2026-09-23T10:00:00.000Z'
    }
    $script:malwareRule = @{
        Name     = 'Default'
        Priority = 0
        State    = 'Disabled'
    }
    $script:connectionPolicy = @{
        Name             = 'Default'
        IPAllowList      = @()
        IPBlockList      = @('192.0.2.1')
        EnableSafeList   = $false
        WhenChangedUTC   = '2026-09-24T10:00:00.000Z'
    }
    $script:connectionRule = @{
        Name     = 'Default'
        Priority = 0
        State    = 'Enabled'
    }

    function script:New-FilterListMock {
        Mock Get-HostedContentFilterPolicy { return @($script:spamPolicy) }
        Mock Get-HostedContentFilterRule { return @($script:spamRule) }
        Mock Get-AntiPhishPolicy { return @($script:phishPolicy) }
        Mock Get-AntiPhishRule { return @($script:phishRule) }
        Mock Get-MalwareFilterPolicy { return @($script:malwarePolicy) }
        Mock Get-MalwareFilterRule { return @($script:malwareRule) }
        Mock Get-HostedConnectionFilterPolicy { return @($script:connectionPolicy) }
        Mock Get-HostedConnectionFilterRule { return @($script:connectionRule) }
    }
}

Describe 'Get-Filters worker (T-0421)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-Filters -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-FilterType -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-FilterRow -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-FiltersJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads filter policies with Get- cmdlets only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-HostedContentFilterPolicy'
            $source | Should -Match 'Get-AntiPhishPolicy'
            $source | Should -Match 'Get-MalwareFilterPolicy'
            $source | Should -Match 'Get-HostedConnectionFilterPolicy'
            $source | Should -Not -Match 'Set-HostedContentFilterPolicy'
            $source | Should -Not -Match 'Set-AntiPhishPolicy'
            $source | Should -Not -Match 'Set-MalwareFilterPolicy'
            $source | Should -Not -Match 'Set-HostedConnectionFilterPolicy'
            $source | Should -Not -Match 'New-HostedContentFilterPolicy'
            $source | Should -Not -Match 'Remove-HostedContentFilterPolicy'
            $source | Should -Not -Match 'Enable-HostedContentFilterRule'
            $source | Should -Not -Match 'Disable-AntiPhishRule'
        }

        It 'never persists filter data to disk, logs, or artifacts' {
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
            $entrySource | Should -Match 'Get-Filters\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-FiltersJob -Path'
            $entrySource | Should -Match 'Get-Filters -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'filter type' {
        It 'accepts the four §3.1 types and the anti-phish alias' {
            ConvertTo-FilterType -FilterType 'spam' | Should -Be 'spam'
            ConvertTo-FilterType -FilterType 'antiphish' | Should -Be 'antiphish'
            ConvertTo-FilterType -FilterType 'anti-phish' | Should -Be 'antiphish'
            ConvertTo-FilterType -FilterType 'malware' | Should -Be 'malware'
            ConvertTo-FilterType -FilterType 'connection' | Should -Be 'connection'
        }

        It 'rejects unknown filter types' {
            { ConvertTo-FilterType -FilterType 'quarantine' } | Should -Throw '*Unknown filter type*'
            { Get-Filters -TenantId 'tenant-a' -FilterType 'quarantine' } | Should -Throw '*Unknown filter type*'
        }

        It 'requires the tenant identifier' {
            script:New-FilterListMock
            { Get-Filters -TenantId '' -FilterType 'spam' } | Should -Throw
        }
    }

    Context 'list mapping' {
        BeforeEach {
            script:New-FilterListMock
        }

        It 'returns the §3.1 columns for spam policies' {
            $result = Get-Filters -TenantId 'tenant-a' -FilterType 'spam'

            $result.tenantId | Should -Be 'tenant-a'
            $result.filterType | Should -Be 'spam'
            $result.items | Should -HaveCount 1
            $result.totalCount | Should -Be 1
            $result.retrievedAt | Should -Not -BeNullOrEmpty
            $row = @($result.items)[0]
            $row.name | Should -Be 'Default'
            $row.priority | Should -Be 0
            $row.state | Should -Be 'Enabled'
            $row.summary | Should -Match 'BulkThreshold=6'
            $row.summary | Should -Match 'SpamAction=MoveToJmf'
            $row.lastModified | Should -Be '2026-09-20T10:00:00.000Z'
        }

        It 'returns the §3.1 columns for anti-phish policies' {
            $result = Get-Filters -TenantId 'tenant-a' -FilterType 'anti-phish'

            $result.filterType | Should -Be 'antiphish'
            $row = @($result.items)[0]
            $row.name | Should -Be 'Standard Preset Policy'
            $row.priority | Should -Be 1
            $row.state | Should -Be 'Enabled'
            $row.summary | Should -Match 'PhishThresholdLevel=2'
            $row.lastModified | Should -Be '2026-09-22T10:00:00.000Z'
        }

        It 'returns the §3.1 columns for malware policies' {
            $result = Get-Filters -TenantId 'tenant-a' -FilterType 'malware'

            $row = @($result.items)[0]
            $row.name | Should -Be 'Default'
            $row.state | Should -Be 'Disabled'
            $row.summary | Should -Match 'EnableFileFilter=True'
            $row.summary | Should -Match 'FileTypesCount=2'
        }

        It 'returns the §3.1 columns for connection filter policies' {
            $result = Get-Filters -TenantId 'tenant-a' -FilterType 'connection'

            $row = @($result.items)[0]
            $row.name | Should -Be 'Default'
            $row.priority | Should -Be 0
            $row.state | Should -Be 'Enabled'
            $row.summary | Should -Match 'IPAllowListCount=0'
            $row.summary | Should -Match 'EnableSafeList=False'
        }

        It 'falls back to the policy flag when no rule names the policy' {
            Mock Get-HostedContentFilterRule { return @() }

            $result = Get-Filters -TenantId 'tenant-a' -FilterType 'spam'

            $row = @($result.items)[0]
            $row.priority | Should -BeNullOrEmpty
            $row.state | Should -Be 'Enabled'
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id and filter type' {
            $jobPath = Join-Path $TestDrive 'filters-job.json'
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
                    filters       = @{ filterType = 'spam' }
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-FiltersJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['FilterType'] | Should -Be 'spam'
        }

        It 'rejects envelopes with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'filters-job-bad.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-FiltersJob -Path $jobPath } | Should -Throw '*schemaVersion*'
        }

        It 'rejects envelopes without a tenant id, filter type, or file' {
            $jobPath = Join-Path $TestDrive 'filters-job-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-FiltersJob -Path $jobPath } | Should -Throw '*tenantId*'
            $noTypePath = Join-Path $TestDrive 'filters-job-notype.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ filters = @{} }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $noTypePath -Encoding UTF8
            { Read-FiltersJob -Path $noTypePath } | Should -Throw '*filterType*'
            { Read-FiltersJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }

        It 'rejects envelopes with an unknown filter type' {
            $jobPath = Join-Path $TestDrive 'filters-job-unknown.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ filterType = 'quarantine' }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            { Read-FiltersJob -Path $jobPath } | Should -Throw '*Unknown filter type*'
        }
    }
}
