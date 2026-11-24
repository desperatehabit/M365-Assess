BeforeAll {
    $script:repoRoot = (Resolve-Path -LiteralPath (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
    $script:worker = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/Get-AllowBlock.ps1'
    $script:entrypoint = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/get-allow-block.ps1'

    function global:Get-TenantAllowBlockListItems { param($ListType, $Entry, [switch]$Allow, [switch]$Block) }

    . $script:worker

    $script:senderAllow = @{
        Value          = 'trusted@vendor.invalid'
        ExpirationDate = '2026-12-31T00:00:00Z'
        Notes          = 'Approved partner'
    }
    $script:domainBlock = @{
        Value          = 'phish-domain.invalid'
        ExpirationDate = $null
        Notes          = 'Known phish domain'
    }
    $script:urlBlock = @{
        Value          = 'https://evil.invalid/login'
        ExpirationDate = '2027-01-15T00:00:00Z'
        Notes          = 'Credential harvester'
    }
    $script:fileAllow = @{
        Value          = 'abcdef0123456789abcdef0123456789'
        ExpirationDate = $null
        Notes          = 'Internal tool hash'
    }

    function script:New-AllowBlockListMock {
        Mock Get-TenantAllowBlockListItems {
            param($ListType, $Entry, [switch]$Allow, [switch]$Block)
            if ($ListType -eq 'Sender' -and $Allow) { return @($script:senderAllow) }
            if ($ListType -eq 'Sender' -and $Block) { return @($script:domainBlock) }
            if ($ListType -eq 'Url' -and $Block) { return @($script:urlBlock) }
            if ($ListType -eq 'FileHash' -and $Allow) { return @($script:fileAllow) }
            return @()
        }
    }
}

AfterAll {
    Remove-Item -Path 'Function:\Get-TenantAllowBlockListItems' -ErrorAction SilentlyContinue
}

Describe 'Get-AllowBlock worker (T-0852)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command -Name 'Get-AllowBlock' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'ConvertTo-AllowBlockType' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'ConvertTo-AllowBlockAction' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'ConvertTo-ExoAllowBlockListType' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'Read-AllowBlockJob' -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads allow/block entries with Get- cmdlets only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-TenantAllowBlockListItems'
            $source | Should -Not -Match 'New-TenantAllowBlockListItems'
            $source | Should -Not -Match 'Remove-TenantAllowBlockListItems'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'never persists allow/block data to disk, logs, or transcripts' {
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
            $entrySource | Should -Match 'Get-AllowBlock\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-AllowBlockJob -Path'
            $entrySource | Should -Match 'Get-AllowBlock @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'type and action normalization' {
        It 'maps all §3.4 type aliases onto sender, domain, url, and file' {
            ConvertTo-AllowBlockType -Type 'sender' | Should -Be 'sender'
            ConvertTo-AllowBlockType -Type 'senders' | Should -Be 'sender'
            ConvertTo-AllowBlockType -Type 'domain' | Should -Be 'domain'
            ConvertTo-AllowBlockType -Type 'domains' | Should -Be 'domain'
            ConvertTo-AllowBlockType -Type 'url' | Should -Be 'url'
            ConvertTo-AllowBlockType -Type 'urls' | Should -Be 'url'
            ConvertTo-AllowBlockType -Type 'file' | Should -Be 'file'
            ConvertTo-AllowBlockType -Type 'filehash' | Should -Be 'file'
            ConvertTo-AllowBlockType -Type 'file-hash' | Should -Be 'file'
            ConvertTo-AllowBlockType -Type 'hash' | Should -Be 'file'
        }

        It 'normalizes actions and maps logical types to EXO ListType values' {
            ConvertTo-AllowBlockAction -EntryAction 'Allow' | Should -Be 'allow'
            ConvertTo-AllowBlockAction -EntryAction 'BLOCK' | Should -Be 'block'
            ConvertTo-ExoAllowBlockListType -Type 'sender' | Should -Be 'Sender'
            ConvertTo-ExoAllowBlockListType -Type 'domain' | Should -Be 'Sender'
            ConvertTo-ExoAllowBlockListType -Type 'url' | Should -Be 'Url'
            ConvertTo-ExoAllowBlockListType -Type 'file' | Should -Be 'FileHash'
        }

        It 'rejects unknown types and actions' {
            { ConvertTo-AllowBlockType -Type 'spoof' } | Should -Throw '*Unknown allow/block type*'
            { ConvertTo-AllowBlockAction -EntryAction 'quarantine' } | Should -Throw '*Unknown allow/block action*'
        }
    }

    Context 'list and filter mapping' {
        BeforeEach {
            script:New-AllowBlockListMock
        }

        It 'queries Sender, Url, and FileHash across Allow and Block and classifies @ as sender vs domain' {
            $result = Get-AllowBlock -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.totalCount | Should -Be 4
            $result.items | Should -HaveCount 4
            $result.retrievedAt | Should -Not -BeNullOrEmpty

            $senderRow = @($result.items | Where-Object -FilterScript { $_.value -eq 'trusted@vendor.invalid' })[0]
            $senderRow.type | Should -Be 'sender'
            $senderRow.action | Should -Be 'allow'
            $senderRow.expiresOn | Should -Be '2026-12-31T00:00:00.0000000Z'
            $senderRow.notes | Should -Be 'Approved partner'

            $domainRow = @($result.items | Where-Object -FilterScript { $_.value -eq 'phish-domain.invalid' })[0]
            $domainRow.type | Should -Be 'domain'
            $domainRow.action | Should -Be 'block'
            $domainRow.expiresOn | Should -BeNullOrEmpty

            $urlRow = @($result.items | Where-Object -FilterScript { $_.type -eq 'url' })[0]
            $urlRow.value | Should -Be 'https://evil.invalid/login'
            $urlRow.action | Should -Be 'block'

            $fileRow = @($result.items | Where-Object -FilterScript { $_.type -eq 'file' })[0]
            $fileRow.value | Should -Be 'abcdef0123456789abcdef0123456789'
            $fileRow.action | Should -Be 'allow'
        }

        It 'filters by Type so sender does not return domain and vice versa' {
            $senders = Get-AllowBlock -TenantId 'tenant-a' -Type 'sender'
            $senders.totalCount | Should -Be 1
            @($senders.items)[0].type | Should -Be 'sender'

            $domains = Get-AllowBlock -TenantId 'tenant-a' -Type 'domain'
            $domains.totalCount | Should -Be 1
            @($domains.items)[0].type | Should -Be 'domain'

            $files = Get-AllowBlock -TenantId 'tenant-a' -Type 'file-hash'
            $files.totalCount | Should -Be 1
            @($files.items)[0].type | Should -Be 'file'
        }

        It 'filters by Action and Value' {
            $blocked = Get-AllowBlock -TenantId 'tenant-a' -Action 'block'
            $blocked.totalCount | Should -Be 2

            $matched = Get-AllowBlock -TenantId 'tenant-a' -Value 'evil.invalid'
            $matched.totalCount | Should -Be 1
            @($matched.items)[0].type | Should -Be 'url'
        }

        It 'requires the tenant identifier' {
            { Get-AllowBlock -TenantId '' } | Should -Throw
        }
    }

    Context 'job envelope' {
        It 'parses tenantId and optional filters from a v1 envelope' {
            $jobPath = Join-Path -Path $TestDrive -ChildPath 'allow-block-job.json'
            @{
                schemaVersion = 'v1'
                jobId         = 'job-1'
                tenantId      = 'tenant-a'
                payload       = @{
                    type   = 'file-hash'
                    action = 'allow'
                    value  = 'abcdef'
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jobPath -Encoding UTF8

            $job = Read-AllowBlockJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Type'] | Should -Be 'file'
            $job['Action'] | Should -Be 'allow'
            $job['Value'] | Should -Be 'abcdef'
        }

        It 'allows empty payload filters' {
            $jobPath = Join-Path -Path $TestDrive -ChildPath 'allow-block-empty-filters.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{}
            } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $jobPath -Encoding UTF8

            $job = Read-AllowBlockJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Type'] | Should -Be ''
            $job['Action'] | Should -Be ''
            $job['Value'] | Should -Be ''
        }

        It 'rejects unsupported schemaVersion, missing tenantId, unknown type/action, and missing file' {
            $badVersion = Join-Path -Path $TestDrive -ChildPath 'allow-block-bad-ver.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -LiteralPath $badVersion -Encoding UTF8
            { Read-AllowBlockJob -Path $badVersion } | Should -Throw '*schemaVersion*'

            $noTenant = Join-Path -Path $TestDrive -ChildPath 'allow-block-no-tenant.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -LiteralPath $noTenant -Encoding UTF8
            { Read-AllowBlockJob -Path $noTenant } | Should -Throw '*tenantId*'

            $badType = Join-Path -Path $TestDrive -ChildPath 'allow-block-bad-type.json'
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ type = 'spoof' } } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $badType -Encoding UTF8
            { Read-AllowBlockJob -Path $badType } | Should -Throw '*Unknown allow/block type*'

            $badAction = Join-Path -Path $TestDrive -ChildPath 'allow-block-bad-action.json'
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ action = 'quarantine' } } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $badAction -Encoding UTF8
            { Read-AllowBlockJob -Path $badAction } | Should -Throw '*Unknown allow/block action*'

            { Read-AllowBlockJob -Path (Join-Path -Path $TestDrive -ChildPath 'missing.json') } | Should -Throw '*not found*'
        }
    }
}
