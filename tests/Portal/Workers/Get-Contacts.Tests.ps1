BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-Contacts.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-contacts.ps1'

    function global:Get-MailContact {
        param($Identity, $ResultSize, $Properties, $RecipientTypeDetails, $Filter)
    }
    function global:Get-MailUser {
        param($Identity, $ResultSize, $Properties, $RecipientTypeDetails, $Filter)
    }

    . $script:worker

    $script:mailContact = @{
        ExchangeObjectId              = 'contact-1'
        DisplayName                   = 'Vendor Support'
        PrimarySmtpAddress            = 'vendor@example.invalid'
        ExternalEmailAddress          = 'smtp:vendor@example.invalid'
        RecipientTypeDetails          = 'MailContact'
        HiddenFromAddressListsEnabled = $false
        WhenChanged                   = '2026-09-20T10:00:00Z'
    }
    $script:mailUser = @{
        ExchangeObjectId              = 'contact-2'
        DisplayName                   = 'External User'
        PrimarySmtpAddress            = 'external@example.invalid'
        ExternalEmailAddress          = 'smtp:external@example.invalid'
        RecipientTypeDetails          = 'MailUser'
        HiddenFromAddressListsEnabled = $true
        WhenChanged                   = '2026-09-21T10:00:00Z'
    }

    function script:New-ContactListMock {
        Mock Get-MailContact {
            param($Identity, $ResultSize, $Properties, $RecipientTypeDetails, $Filter)
            return @($script:mailContact)
        }
        Mock Get-MailUser {
            param($Identity, $ResultSize, $Properties, $RecipientTypeDetails, $Filter)
            return @($script:mailUser)
        }
    }
}

Describe 'Get-Contacts worker (T-0442)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-Contacts -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-ContactsJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads contacts with Get- cmdlets only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-MailContact'
            $source | Should -Match 'Get-MailUser'
            $source | Should -Not -Match 'Set-MailContact'
            $source | Should -Not -Match 'New-MailContact'
            $source | Should -Not -Match 'Remove-MailContact'
            $source | Should -Not -Match 'Set-MailUser'
            $source | Should -Not -Match 'New-MailUser'
            $source | Should -Not -Match 'Remove-MailUser'
            $source | Should -Not -Match 'Enable-MailUser'
            $source | Should -Not -Match 'Disable-MailUser'
        }

        It 'never persists contact data to disk, logs, or artifacts' {
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
            $entrySource | Should -Match 'Get-Contacts\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-ContactsJob -Path'
            $entrySource | Should -Match 'Get-Contacts -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'list mapping' {
        BeforeEach {
            script:New-ContactListMock
        }

        It 'returns the section columns with cursor paging metadata' {
            $result = Get-Contacts -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.items | Should -HaveCount 2
            $result.nextCursor | Should -Be ''
            $result.totalCount | Should -Be 2
            $result.retrievedAt | Should -Not -BeNullOrEmpty
            $row = @($result.items | Where-Object { $_.id -eq 'contact-1' })[0]
            $row.displayName | Should -Be 'Vendor Support'
            $row.externalAddress | Should -Be 'smtp:vendor@example.invalid'
            $row.type | Should -Be 'mailContact'
            $row.hiddenFromGal | Should -BeFalse
            $row.lastModified | Should -Be '2026-09-20T10:00:00Z'
        }

        It 'maps mail user type with hidden flag' {
            $result = Get-Contacts -TenantId 'tenant-a'

            $user = @($result.items | Where-Object { $_.id -eq 'contact-2' })[0]
            $user.type | Should -Be 'mailUser'
            $user.hiddenFromGal | Should -BeTrue
        }

        It 'requires the tenant identifier' {
            { Get-Contacts -TenantId '' } | Should -Throw
        }
    }

    Context 'filters' {
        BeforeEach {
            script:New-ContactListMock
        }

        It 'searches display name and external address case-insensitively' {
            (Get-Contacts -TenantId 'tenant-a' -Search 'VENDOR').items | Should -HaveCount 1
            $result = Get-Contacts -TenantId 'tenant-a' -Search 'external@'
            $result.items | Should -HaveCount 1
            @($result.items)[0].id | Should -Be 'contact-2'
        }

        It 'filters by contact type' {
            (Get-Contacts -TenantId 'tenant-a' -Type 'mailContact').items | Should -HaveCount 1
            (Get-Contacts -TenantId 'tenant-a' -Type 'mailUser').items | Should -HaveCount 1
        }

        It 'filters by hidden from GAL' {
            @(Get-Contacts -TenantId 'tenant-a' -Hidden 'true').items.id | Should -Be @('contact-2')
            @(Get-Contacts -TenantId 'tenant-a' -Hidden 'false').items.id | Should -Be @('contact-1')
        }
    }

    Context 'cursor pagination' {
        BeforeEach {
            script:New-ContactListMock
        }

        It 'pages through the filtered set with an opaque cursor' {
            $first = Get-Contacts -TenantId 'tenant-a' -Top 1

            $first.items | Should -HaveCount 1
            $first.totalCount | Should -Be 2
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-Contacts -TenantId 'tenant-a' -Top 1 -Cursor $first.nextCursor
            $second.items | Should -HaveCount 1
            $second.nextCursor | Should -Be ''
            @(@($first.items) + @($second.items)).id | Should -Be @('contact-1', 'contact-2')
        }

        It 'restarts at the first page for a blank or invalid cursor' {
            (Get-Contacts -TenantId 'tenant-a' -Top 1 -Cursor '').items | Should -HaveCount 1
            $result = Get-Contacts -TenantId 'tenant-a' -Top 1 -Cursor 'not-a-cursor'
            @($result.items)[0].id | Should -Be 'contact-1'
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id and payload filters' {
            $jobPath = Join-Path $TestDrive 'contacts-job.json'
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
                    filters       = @{ type = 'mailContact'; top = 25 }
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-ContactsJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Type'] | Should -Be 'mailContact'
            $job['Top'] | Should -Be 25
        }

        It 'rejects envelopes with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'contacts-job-bad.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-ContactsJob -Path $jobPath } | Should -Throw '*schemaVersion*'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $jobPath = Join-Path $TestDrive 'contacts-job-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-ContactsJob -Path $jobPath } | Should -Throw '*tenantId*'
            { Read-ContactsJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }
}
