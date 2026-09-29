BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-Mailboxes.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-mailboxes.ps1'

    function global:Get-EXOMailbox {
        param($Identity, $ResultSize, $Properties, $RecipientTypeDetails, $Filter)
    }
    function global:Get-EXOMailboxStatistics {
        param($Identity)
    }
    function global:Get-MailboxPermission {
        param($Identity)
    }
    function global:Get-RecipientPermission {
        param($Identity)
    }
    function global:Get-EXOMailboxFolderPermission {
        param($Identity)
    }
    function global:Get-InboxRule {
        param($Mailbox)
    }

    . $script:worker

    $script:recentActivity = (Get-Date).ToUniversalTime().AddDays(-2).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $script:olderActivity = (Get-Date).ToUniversalTime().AddDays(-100).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $script:sharedMailbox = @{
        ExchangeObjectId            = 'mbx-1'
        DisplayName                 = 'Support Desk'
        PrimarySmtpAddress          = 'support@example.invalid'
        RecipientTypeDetails        = 'SharedMailbox'
        LitigationHoldEnabled       = $false
        InPlaceHolds                = @()
        ArchiveStatus               = 'Active'
        ForwardingAddress           = $null
        ForwardingSmtpAddress       = 'smtp:cover@example.invalid'
        DeliverToMailboxAndForward  = $true
        ProhibitSendQuota           = '50 GB (53687091200 bytes)'
        HiddenFromAddressListsEnabled = $false
        GrantSendOnBehalfTo         = @()
    }
    $script:userMailbox = @{
        ExchangeObjectId            = 'mbx-2'
        DisplayName                 = 'Operator One'
        PrimarySmtpAddress          = 'operator.one@example.invalid'
        RecipientTypeDetails        = 'UserMailbox'
        LitigationHoldEnabled       = $true
        InPlaceHolds                = @()
        ArchiveStatus               = 'None'
        ForwardingAddress           = $null
        ForwardingSmtpAddress       = ''
        DeliverToMailboxAndForward  = $false
        ProhibitSendQuota           = '100 GB (107374182400 bytes)'
        HiddenFromAddressListsEnabled = $false
        GrantSendOnBehalfTo         = @('delegate@example.invalid')
    }
    $script:roomMailbox = @{
        ExchangeObjectId            = 'mbx-3'
        DisplayName                 = 'Board Room'
        PrimarySmtpAddress          = 'board.room@example.invalid'
        RecipientTypeDetails        = 'RoomMailbox'
        LitigationHoldEnabled       = $false
        InPlaceHolds                = @()
        ArchiveStatus               = 'None'
        ForwardingAddress           = $null
        ForwardingSmtpAddress       = ''
        DeliverToMailboxAndForward  = $false
        ProhibitSendQuota           = 'Unlimited'
        HiddenFromAddressListsEnabled = $true
        GrantSendOnBehalfTo         = @()
    }
    $script:equipmentMailbox = @{
        ExchangeObjectId            = 'mbx-4'
        DisplayName                 = 'Projector Cart'
        PrimarySmtpAddress          = 'projector.cart@example.invalid'
        RecipientTypeDetails        = 'EquipmentMailbox'
        LitigationHoldEnabled       = $false
        InPlaceHolds                = @('hold-1')
        ArchiveStatus               = 'None'
        ForwardingAddress           = $null
        ForwardingSmtpAddress       = ''
        DeliverToMailboxAndForward  = $false
        ProhibitSendQuota           = '50 GB (53687091200 bytes)'
        HiddenFromAddressListsEnabled = $false
        GrantSendOnBehalfTo         = @()
    }

    function script:New-MailboxListMock {
        Mock Get-EXOMailbox {
            param($Identity, $ResultSize, $Properties, $RecipientTypeDetails, $Filter)
            if ($PSBoundParameters.ContainsKey('Identity') -and -not [string]::IsNullOrWhiteSpace([string]$Identity)) {
                $found = @($script:sharedMailbox, $script:userMailbox, $script:roomMailbox, $script:equipmentMailbox) |
                    Where-Object { $_.ExchangeObjectId -eq $Identity -or $_.PrimarySmtpAddress -eq $Identity }
                return @($found)[0]
            }
            return @($script:sharedMailbox, $script:userMailbox, $script:roomMailbox, $script:equipmentMailbox)
        }
        Mock Get-EXOMailboxStatistics {
            param($Identity)
            switch ([string]$Identity) {
                'mbx-1' { return @{ TotalItemSize = '1.2 GB (1288490188 bytes)'; LastLogonTime = $script:recentActivity } }
                'support@example.invalid' { return @{ TotalItemSize = '1.2 GB (1288490188 bytes)'; LastLogonTime = $script:recentActivity } }
                'mbx-2' { return @{ TotalItemSize = '90 GB (96636764160 bytes)'; LastLogonTime = $script:olderActivity } }
                'operator.one@example.invalid' { return @{ TotalItemSize = '90 GB (96636764160 bytes)'; LastLogonTime = $script:olderActivity } }
                'mbx-4' { return @{ TotalItemSize = '512 MB (536870912 bytes)'; LastLogonTime = '' } }
                default { return $null }
            }
        }
        Mock Get-MailboxPermission {
            return @(
                @{ User = 'operator.one@example.invalid'; AccessRights = @('FullAccess'); AutoMapping = $true; IsInherited = $false }
                @{ User = 'NT AUTHORITY\SELF'; AccessRights = @('FullAccess'); AutoMapping = $true; IsInherited = $false }
                @{ User = 'inherited@example.invalid'; AccessRights = @('FullAccess'); AutoMapping = $true; IsInherited = $true }
            )
        }
        Mock Get-RecipientPermission {
            return @(
                @{ Trustee = 'sender@example.invalid' }
                @{ Trustee = 'NT AUTHORITY\SELF' }
            )
        }
        Mock Get-EXOMailboxFolderPermission {
            return @(@{ User = 'Default'; AccessRights = @('AvailabilityOnly') })
        }
        Mock Get-InboxRule {
            return @(@{
                Identity              = 'rule-1'
                Name                  = 'Forward cover'
                Enabled               = $true
                Priority              = 0
                ForwardTo             = 'smtp:cover@example.invalid'
                ForwardAsAttachmentTo = $null
                RedirectTo            = $null
                DeleteMessage         = $false
            })
        }
    }
}

Describe 'Get-Mailboxes worker (T-0381)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-Mailboxes -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-MailboxDetail -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-MailboxesJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads mailboxes with Get- cmdlets only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-EXOMailbox'
            $source | Should -Match 'Get-EXOMailboxStatistics'
            $source | Should -Not -Match 'Set-Mailbox'
            $source | Should -Not -Match 'New-Mailbox'
            $source | Should -Not -Match 'Remove-Mailbox'
            $source | Should -Not -Match 'Add-MailboxPermission'
            $source | Should -Not -Match 'Remove-MailboxPermission'
            $source | Should -Not -Match 'New-InboxRule'
            $source | Should -Not -Match 'Set-InboxRule'
            $source | Should -Not -Match 'Remove-InboxRule'
            $source | Should -Not -Match 'Enable-Mailbox'
            $source | Should -Not -Match 'Disable-Mailbox'
        }

        It 'never persists mailbox data to disk, logs, or artifacts' {
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
            $entrySource | Should -Match 'Get-Mailboxes\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-MailboxesJob -Path'
            $entrySource | Should -Match 'Get-Mailboxes @invokeParams'
            $entrySource | Should -Match 'Get-MailboxDetail -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'list mapping' {
        BeforeEach {
            script:New-MailboxListMock
        }

        It 'returns the section columns with cursor paging metadata' {
            $result = Get-Mailboxes -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.items | Should -HaveCount 4
            $result.nextCursor | Should -Be ''
            $result.totalCount | Should -Be 4
            $result.retrievedAt | Should -Not -BeNullOrEmpty
            $row = @($result.items | Where-Object { $_.id -eq 'mbx-1' })[0]
            $row.displayName | Should -Be 'Support Desk'
            $row.primarySmtpAddress | Should -Be 'support@example.invalid'
            $row.type | Should -Be 'shared'
            $row.quotaUsed | Should -Be '1.2 GB (1288490188 bytes)'
            $row.archive | Should -BeTrue
            $row.hold | Should -BeFalse
            $row.forwarding | Should -BeTrue
            $row.lastActivity | Should -Be $script:recentActivity
        }

        It 'maps user, room, and equipment types with hold and archive flags' {
            $result = Get-Mailboxes -TenantId 'tenant-a'

            $user = @($result.items | Where-Object { $_.id -eq 'mbx-2' })[0]
            $user.type | Should -Be 'user'
            $user.hold | Should -BeTrue
            $user.archive | Should -BeFalse
            $user.forwarding | Should -BeFalse
            $room = @($result.items | Where-Object { $_.id -eq 'mbx-3' })[0]
            $room.type | Should -Be 'room'
            $equipment = @($result.items | Where-Object { $_.id -eq 'mbx-4' })[0]
            $equipment.type | Should -Be 'equipment'
            $equipment.hold | Should -BeTrue
        }

        It 'derives quota percent from used bytes over ProhibitSendQuota' {
            $result = Get-Mailboxes -TenantId 'tenant-a'

            $user = @($result.items | Where-Object { $_.id -eq 'mbx-2' })[0]
            $user.quotaPercent | Should -Be 90.0
            $room = @($result.items | Where-Object { $_.id -eq 'mbx-3' })[0]
            $room.quotaPercent | Should -BeNullOrEmpty
        }

        It 'treats missing statistics as unknown quota and activity without failing' {
            $result = Get-Mailboxes -TenantId 'tenant-a'

            $room = @($result.items | Where-Object { $_.id -eq 'mbx-3' })[0]
            $room.quotaUsed | Should -BeNullOrEmpty
            $room.lastActivity | Should -BeNullOrEmpty
        }

        It 'requires the tenant identifier' {
            { Get-Mailboxes -TenantId '' } | Should -Throw
        }
    }

    Context 'filters' {
        BeforeEach {
            script:New-MailboxListMock
        }

        It 'searches display name and primary SMTP case-insensitively' {
            (Get-Mailboxes -TenantId 'tenant-a' -Search 'SUPPORT').items | Should -HaveCount 1
            $result = Get-Mailboxes -TenantId 'tenant-a' -Search 'operator.one@'
            $result.items | Should -HaveCount 1
            @($result.items)[0].id | Should -Be 'mbx-2'
        }

        It 'filters by mailbox type' {
            (Get-Mailboxes -TenantId 'tenant-a' -Type 'shared').items | Should -HaveCount 1
            (Get-Mailboxes -TenantId 'tenant-a' -Type 'room').items | Should -HaveCount 1
            (Get-Mailboxes -TenantId 'tenant-a' -Type 'equipment').items | Should -HaveCount 1
        }

        It 'filters by hold, forwarding, and archive' {
            @(Get-Mailboxes -TenantId 'tenant-a' -Hold 'true').items.id | Should -Be @('mbx-2', 'mbx-4')
            @(Get-Mailboxes -TenantId 'tenant-a' -Forwarding 'true').items.id | Should -Be @('mbx-1')
            @(Get-Mailboxes -TenantId 'tenant-a' -Archive 'true').items.id | Should -Be @('mbx-1')
            @(Get-Mailboxes -TenantId 'tenant-a' -Archive 'false').items.id | Should -Be @('mbx-2', 'mbx-3', 'mbx-4')
        }

        It 'filters by quota percent threshold' {
            $result = Get-Mailboxes -TenantId 'tenant-a' -QuotaPercent 50
            @($result.items).id | Should -Be @('mbx-2')
        }

        It 'filters by inactivity, counting never-active as inactive' {
            $result = Get-Mailboxes -TenantId 'tenant-a' -InactiveDays 30
            @($result.items).id | Should -Contain 'mbx-2'
            @($result.items).id | Should -Contain 'mbx-3'
            @($result.items).id | Should -Not -Contain 'mbx-1'
        }
    }

    Context 'cursor pagination' {
        BeforeEach {
            script:New-MailboxListMock
        }

        It 'pages through the filtered set with an opaque cursor' {
            $first = Get-Mailboxes -TenantId 'tenant-a' -Top 2

            $first.items | Should -HaveCount 2
            $first.totalCount | Should -Be 4
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-Mailboxes -TenantId 'tenant-a' -Top 2 -Cursor $first.nextCursor
            $second.items | Should -HaveCount 2
            $second.nextCursor | Should -Be ''
            @(@($first.items) + @($second.items)).id | Should -Be @('mbx-1', 'mbx-2', 'mbx-3', 'mbx-4')
        }

        It 'restarts at the first page for a blank or invalid cursor' {
            (Get-Mailboxes -TenantId 'tenant-a' -Top 1 -Cursor '').items | Should -HaveCount 1
            $result = Get-Mailboxes -TenantId 'tenant-a' -Top 1 -Cursor 'not-a-cursor'
            @($result.items)[0].id | Should -Be 'mbx-1'
        }
    }

    Context 'detail' {
        BeforeEach {
            script:New-MailboxListMock
        }

        It 'returns settings, permissions, calendar permissions, and rules' {
            $result = Get-MailboxDetail -TenantId 'tenant-a' -MailboxId 'mbx-1'

            $result.tenantId | Should -Be 'tenant-a'
            $result.mailboxId | Should -Be 'mbx-1'
            $result.settings.primarySmtpAddress | Should -Be 'support@example.invalid'
            $result.settings.type | Should -Be 'shared'
            $fullAccess = @($result.permissions | Where-Object { $_.permissionType -eq 'FullAccess' })
            $fullAccess | Should -HaveCount 1
            $fullAccess[0].grantedTo | Should -Be 'operator.one@example.invalid'
            $sendAs = @($result.permissions | Where-Object { $_.permissionType -eq 'SendAs' })
            $sendAs[0].grantedTo | Should -Be 'sender@example.invalid'
            $result.calendarPermissions | Should -HaveCount 1
            @($result.calendarPermissions)[0].user | Should -Be 'Default'
            $result.rules | Should -HaveCount 1
            @($result.rules)[0].name | Should -Be 'Forward cover'
            $result.retrievedAt | Should -Not -BeNullOrEmpty
        }

        It 'excludes system and inherited permission grants' {
            $result = Get-MailboxDetail -TenantId 'tenant-a' -MailboxId 'mbx-1'

            @($result.permissions).grantedTo | Should -Not -Contain 'NT AUTHORITY\SELF'
            @($result.permissions).grantedTo | Should -Not -Contain 'inherited@example.invalid'
        }

        It 'includes SendOnBehalf delegates from the mailbox record' {
            $result = Get-MailboxDetail -TenantId 'tenant-a' -MailboxId 'mbx-2'

            $onBehalf = @($result.permissions | Where-Object { $_.permissionType -eq 'SendOnBehalf' })
            $onBehalf | Should -HaveCount 1
            $onBehalf[0].grantedTo | Should -Be 'delegate@example.invalid'
        }

        It 'returns empty calendar and rules slices when those reads fail' {
            Mock Get-EXOMailboxFolderPermission { throw 'Calendar folder not found' }
            Mock Get-InboxRule { throw 'No rules' }

            $result = Get-MailboxDetail -TenantId 'tenant-a' -MailboxId 'mbx-1'

            @($result.calendarPermissions) | Should -HaveCount 0
            @($result.rules) | Should -HaveCount 0
            $result.settings.id | Should -Be 'mbx-1'
        }

        It 'requires the tenant and mailbox identifiers' {
            { Get-MailboxDetail -TenantId '' -MailboxId 'mbx-1' } | Should -Throw
            { Get-MailboxDetail -TenantId 'tenant-a' -MailboxId '' } | Should -Throw
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id and payload filters' {
            $jobPath = Join-Path $TestDrive 'mailboxes-job.json'
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
                    filters       = @{ type = 'shared'; top = 25 }
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-MailboxesJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Type'] | Should -Be 'shared'
            $job['Top'] | Should -Be 25
            $job['QuotaPercent'] | Should -Be 0
            $job['MailboxId'] | Should -Be ''
        }

        It 'rejects envelopes with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'mailboxes-job-bad.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-MailboxesJob -Path $jobPath } | Should -Throw '*schemaVersion*'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $jobPath = Join-Path $TestDrive 'mailboxes-job-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-MailboxesJob -Path $jobPath } | Should -Throw '*tenantId*'
            { Read-MailboxesJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }
}
