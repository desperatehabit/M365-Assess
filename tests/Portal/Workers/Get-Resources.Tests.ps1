BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-Resources.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-resources.ps1'

    function global:Get-EXOMailbox {
        param($Identity, $Filter, $ResultSize, $Properties)
    }
    function global:Get-DistributionGroup {
        param($Identity, $Filter, $ResultSize, $Properties)
    }
    function global:Get-DistributionGroupMember {
        param($Identity, $ResultSize)
    }

    . $script:worker

    $script:roomMailbox = @{
        ExchangeObjectId            = 'room-1'
        DisplayName                 = 'Board Room'
        PrimarySmtpAddress          = 'board.room@example.invalid'
        RecipientTypeDetails        = 'RoomMailbox'
        Capacity                    = '12'
        CustomAttribute1            = 'Building A'
        HiddenFromAddressListsEnabled = $false
    }
    $script:equipmentMailbox = @{
        ExchangeObjectId            = 'equip-1'
        DisplayName                 = 'Projector Cart'
        PrimarySmtpAddress          = 'projector.cart@example.invalid'
        RecipientTypeDetails        = 'EquipmentMailbox'
        Capacity                    = $null
        CustomAttribute1            = ''
        HiddenFromAddressListsEnabled = $true
    }
    $script:userMailbox = @{
        ExchangeObjectId            = 'user-1'
        DisplayName                 = 'Operator One'
        PrimarySmtpAddress          = 'operator.one@example.invalid'
        RecipientTypeDetails        = 'UserMailbox'
        Capacity                    = $null
        CustomAttribute1            = ''
        HiddenFromAddressListsEnabled = $false
    }
    $script:roomList = @{
        ExchangeObjectId            = 'rl-1'
        DisplayName                 = 'Building A Rooms'
        PrimarySmtpAddress          = 'building.a.rooms@example.invalid'
        RecipientTypeDetails        = 'RoomList'
        HiddenFromAddressListsEnabled = $false
    }
    $script:regularGroup = @{
        ExchangeObjectId            = 'dg-1'
        DisplayName                 = 'All Staff'
        PrimarySmtpAddress          = 'all.staff@example.invalid'
        RecipientTypeDetails        = 'MailUniversalDistributionGroup'
        HiddenFromAddressListsEnabled = $false
    }
    $script:roomListMembers = @(
        @{ DisplayName = 'Board Room'; PrimarySmtpAddress = 'board.room@example.invalid' }
        @{ DisplayName = 'Focus Room'; PrimarySmtpAddress = 'focus.room@example.invalid' }
    )

    function script:New-ResourceListMock {
        Mock Get-EXOMailbox {
            param($Identity, $Filter, $ResultSize, $Properties)
            $all = @($script:roomMailbox, $script:equipmentMailbox, $script:userMailbox)
            if ($PSBoundParameters.ContainsKey('Identity') -and -not [string]::IsNullOrWhiteSpace([string]$Identity)) {
                $found = @($all) | Where-Object { $_.ExchangeObjectId -eq $Identity -or $_.PrimarySmtpAddress -eq $Identity }
                return @($found)[0]
            }
            if ($Filter -like "*RoomMailbox*") { return @($script:roomMailbox) }
            if ($Filter -like "*EquipmentMailbox*") { return @($script:equipmentMailbox) }
            return @($all)
        }
        Mock Get-DistributionGroup {
            param($Identity, $Filter, $ResultSize, $Properties)
            $all = @($script:roomList, $script:regularGroup)
            if ($PSBoundParameters.ContainsKey('Identity') -and -not [string]::IsNullOrWhiteSpace([string]$Identity)) {
                $found = @($all) | Where-Object { $_.ExchangeObjectId -eq $Identity -or $_.PrimarySmtpAddress -eq $Identity }
                return @($found)[0]
            }
            if ($Filter -like "*RoomList*") { return @($script:roomList) }
            return @($all)
        }
        Mock Get-DistributionGroupMember {
            param($Identity, $ResultSize)
            return $script:roomListMembers
        }
    }
}

Describe 'Get-Resources worker (T-0448)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-Resources -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-ResourcesJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads resources with Get- cmdlets only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-EXOMailbox'
            $source | Should -Match 'Get-DistributionGroup'
            $source | Should -Match 'Get-DistributionGroupMember'
            $source | Should -Not -Match 'Set-Mailbox'
            $source | Should -Not -Match 'New-Mailbox'
            $source | Should -Not -Match 'Remove-Mailbox'
            $source | Should -Not -Match 'New-DistributionGroup'
            $source | Should -Not -Match 'Set-DistributionGroup'
            $source | Should -Not -Match 'Remove-DistributionGroup'
            $source | Should -Not -Match 'Add-DistributionGroupMember'
            $source | Should -Not -Match 'Remove-DistributionGroupMember'
        }

        It 'never persists resource data to disk, logs, or artifacts' {
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
            $entrySource | Should -Match 'Get-Resources\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-ResourcesJob -Path'
            $entrySource | Should -Match 'Get-Resources -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'list mapping' {
        BeforeEach {
            script:New-ResourceListMock
        }

        It 'returns rooms with the section 3.3 columns and cursor paging metadata' {
            $result = Get-Resources -TenantId 'tenant-a' -Kind 'rooms'

            $result.tenantId | Should -Be 'tenant-a'
            $result.kind | Should -Be 'rooms'
            $result.items | Should -HaveCount 1
            $result.nextCursor | Should -Be ''
            $result.totalCount | Should -Be 1
            $result.retrievedAt | Should -Not -BeNullOrEmpty
            $row = @($result.items)[0]
            $row.id | Should -Be 'room-1'
            $row.name | Should -Be 'Board Room'
            $row.primarySmtpAddress | Should -Be 'board.room@example.invalid'
            $row.capacity | Should -Be 12
            $row.location | Should -Be 'Building A'
            $row.type | Should -Be 'room'
            $row.hidden | Should -BeFalse
            $row.members | Should -HaveCount 0
        }

        It 'returns equipment with null capacity and hidden flag' {
            $result = Get-Resources -TenantId 'tenant-a' -Kind 'equipment'

            $result.kind | Should -Be 'equipment'
            $result.items | Should -HaveCount 1
            $row = @($result.items)[0]
            $row.id | Should -Be 'equip-1'
            $row.name | Should -Be 'Projector Cart'
            $row.capacity | Should -BeNullOrEmpty
            $row.location | Should -BeNullOrEmpty
            $row.type | Should -Be 'equipment'
            $row.hidden | Should -BeTrue
        }

        It 'returns room lists with their membership' {
            $result = Get-Resources -TenantId 'tenant-a' -Kind 'roomlists'

            $result.kind | Should -Be 'roomlists'
            $result.items | Should -HaveCount 1
            $row = @($result.items)[0]
            $row.id | Should -Be 'rl-1'
            $row.name | Should -Be 'Building A Rooms'
            $row.type | Should -Be 'roomlist'
            $row.capacity | Should -BeNullOrEmpty
            $row.location | Should -BeNullOrEmpty
            $row.hidden | Should -BeFalse
            $row.members | Should -HaveCount 2
            $row.members[0].name | Should -Be 'Board Room'
            $row.members[0].primarySmtpAddress | Should -Be 'board.room@example.invalid'
            $row.members[1].name | Should -Be 'Focus Room'
        }

        It 'reads only RoomList distribution groups for the roomlists kind' {
            $result = Get-Resources -TenantId 'tenant-a' -Kind 'roomlists'

            $result.items | Should -HaveCount 1
            @($result.items)[0].type | Should -Be 'roomlist'
        }

        It 'requires the tenant identifier and a known kind' {
            { Get-Resources -TenantId '' -Kind 'rooms' } | Should -Throw
            { Get-Resources -TenantId 'tenant-a' -Kind 'mailboxes' } | Should -Throw
        }
    }

    Context 'membership resilience' {
        BeforeEach {
            script:New-ResourceListMock
        }

        It 'returns an empty member list when the membership read fails' {
            Mock Get-DistributionGroupMember { throw 'Group not found' }

            $result = Get-Resources -TenantId 'tenant-a' -Kind 'roomlists'

            $row = @($result.items)[0]
            $row.members | Should -HaveCount 0
            $row.name | Should -Be 'Building A Rooms'
        }
    }

    Context 'filters' {
        BeforeEach {
            script:New-ResourceListMock
        }

        It 'searches name and primary SMTP case-insensitively' {
            (Get-Resources -TenantId 'tenant-a' -Kind 'rooms' -Search 'BOARD').items | Should -HaveCount 1
            (Get-Resources -TenantId 'tenant-a' -Kind 'equipment' -Search 'projector.cart@').items | Should -HaveCount 1
            (Get-Resources -TenantId 'tenant-a' -Kind 'roomlists' -Search 'building a').items | Should -HaveCount 1
            (Get-Resources -TenantId 'tenant-a' -Kind 'rooms' -Search 'no-match').items | Should -HaveCount 0
        }
    }

    Context 'cursor pagination' {
        BeforeEach {
            script:New-ResourceListMock
            Mock Get-EXOMailbox {
                param($Identity, $Filter, $ResultSize, $Properties)
                if ($Filter -like "*RoomMailbox*") {
                    return @(
                        $script:roomMailbox,
                        @{ ExchangeObjectId = 'room-2'; DisplayName = 'Focus Room'; PrimarySmtpAddress = 'focus.room@example.invalid'; RecipientTypeDetails = 'RoomMailbox'; Capacity = '4'; CustomAttribute1 = 'Building B'; HiddenFromAddressListsEnabled = $false }
                    )
                }
                return @()
            }
        }

        It 'pages through the filtered set with an opaque cursor' {
            $first = Get-Resources -TenantId 'tenant-a' -Kind 'rooms' -Top 1

            $first.items | Should -HaveCount 1
            $first.totalCount | Should -Be 2
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-Resources -TenantId 'tenant-a' -Kind 'rooms' -Top 1 -Cursor $first.nextCursor
            $second.items | Should -HaveCount 1
            $second.nextCursor | Should -Be ''
            @(@($first.items) + @($second.items)).id | Should -Be @('room-1', 'room-2')
        }

        It 'restarts at the first page for a blank or invalid cursor' {
            (Get-Resources -TenantId 'tenant-a' -Kind 'rooms' -Top 1 -Cursor '').items | Should -HaveCount 1
            $result = Get-Resources -TenantId 'tenant-a' -Kind 'rooms' -Top 1 -Cursor 'not-a-cursor'
            @($result.items)[0].id | Should -Be 'room-1'
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id and payload filters' {
            $jobPath = Join-Path $TestDrive 'resources-job.json'
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
                    filters       = @{ kind = 'rooms'; search = 'board'; top = 25 }
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-ResourcesJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Kind'] | Should -Be 'rooms'
            $job['Search'] | Should -Be 'board'
            $job['Top'] | Should -Be 25
            $job['Cursor'] | Should -Be ''
        }

        It 'rejects envelopes with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'resources-job-bad.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-ResourcesJob -Path $jobPath } | Should -Throw '*schemaVersion*'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $jobPath = Join-Path $TestDrive 'resources-job-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-ResourcesJob -Path $jobPath } | Should -Throw '*tenantId*'
            { Read-ResourcesJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }
}
