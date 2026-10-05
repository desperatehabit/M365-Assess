BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-MailboxPermissions.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-mailbox-permissions.ps1'

    function global:Get-EXOMailbox {
        param($Identity, $ResultSize, $Properties, $RecipientTypeDetails, $Filter)
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

    . $script:worker

    $script:supportMailbox = @{
        ExchangeObjectId            = 'mbx-1'
        DisplayName                 = 'Support Desk'
        PrimarySmtpAddress          = 'support@example.invalid'
        RecipientTypeDetails        = 'SharedMailbox'
        GrantSendOnBehalfTo         = @('cover@example.invalid')
    }
    $script:userMailbox = @{
        ExchangeObjectId            = 'mbx-2'
        DisplayName                 = 'Operator One'
        PrimarySmtpAddress          = 'operator.one@example.invalid'
        RecipientTypeDetails        = 'UserMailbox'
        GrantSendOnBehalfTo         = @()
    }

    function script:New-MailboxPermissionsMock {
        Mock Get-EXOMailbox {
            param($Identity, $ResultSize, $Properties, $RecipientTypeDetails, $Filter)
            return @($script:supportMailbox, $script:userMailbox)
        }
        Mock Get-MailboxPermission {
            param($Identity)
            return @(
                @{ User = 'operator.one@example.invalid'; AccessRights = @('FullAccess'); AutoMapping = $true; IsInherited = $false }
                @{ User = 'NT AUTHORITY\SELF'; AccessRights = @('FullAccess'); AutoMapping = $true; IsInherited = $false }
                @{ User = 'inherited@example.invalid'; AccessRights = @('FullAccess'); AutoMapping = $true; IsInherited = $true }
            )
        }
        Mock Get-RecipientPermission {
            param($Identity)
            return @(
                @{ Trustee = 'sender@example.invalid' }
                @{ Trustee = 'NT AUTHORITY\SELF' }
            )
        }
        Mock Get-EXOMailboxFolderPermission {
            param($Identity)
            return @(@{ User = 'Default'; AccessRights = @('AvailabilityOnly') })
        }
    }
}

Describe 'Get-MailboxPermissions worker (T-0529)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-MailboxPermissions -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-MailboxPermissionsJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads permissions with Get- cmdlets only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-EXOMailbox'
            $source | Should -Match 'Get-MailboxPermission'
            $source | Should -Match 'Get-RecipientPermission'
            $source | Should -Match 'Get-EXOMailboxFolderPermission'
            $source | Should -Not -Match 'Set-Mailbox'
            $source | Should -Not -Match 'New-Mailbox'
            $source | Should -Not -Match 'Remove-Mailbox'
            $source | Should -Not -Match 'Add-MailboxPermission'
            $source | Should -Not -Match 'Remove-MailboxPermission'
            $source | Should -Not -Match 'Set-MailboxPermission'
            $source | Should -Not -Match 'Set-EXOMailboxFolderPermission'
        }

        It 'never persists permission data to disk, logs, or artifacts' {
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
            $entrySource | Should -Match 'Get-MailboxPermissions\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-MailboxPermissionsJob -Path'
            $entrySource | Should -Match 'Get-MailboxPermissions -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'report rows' {
        BeforeEach {
            script:New-MailboxPermissionsMock
        }

        It 'flattens mailbox and calendar permissions into §3.3 rows' {
            $result = Get-MailboxPermissions -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.totalCount | Should -Be 7
            $result.nextCursor | Should -Be ''
            $result.retrievedAt | Should -Not -BeNullOrEmpty

            $fullAccess = @($result.items | Where-Object { $_.permissionType -eq 'FullAccess' })
            $fullAccess | Should -HaveCount 2
            $fullAccess[0].mailboxId | Should -Be 'mbx-1'
            $fullAccess[0].principal | Should -Be 'operator.one@example.invalid'
            $fullAccess[0].accessRights | Should -Be @('FullAccess')
            $fullAccess[0].automap | Should -BeTrue
            $fullAccess[0].inherited | Should -BeFalse
            $fullAccess[0].scope | Should -Be 'mailbox'

            $sendAs = @($result.items | Where-Object { $_.permissionType -eq 'SendAs' })
            $sendAs | Should -HaveCount 2
            $sendAs[0].principal | Should -Be 'sender@example.invalid'
            $sendAs[0].accessRights | Should -Be @('SendAs')
            $sendAs[0].automap | Should -BeFalse

            $onBehalf = @($result.items | Where-Object { $_.permissionType -eq 'SendOnBehalf' })
            $onBehalf | Should -HaveCount 1
            $onBehalf[0].principal | Should -Be 'cover@example.invalid'
            $onBehalf[0].accessRights | Should -Be @('SendOnBehalf')

            $calendar = @($result.items | Where-Object { $_.scope -eq 'calendar' })
            $calendar | Should -HaveCount 2
            $calendar[0].permissionType | Should -Be 'Calendar'
            $calendar[0].principal | Should -Be 'Default'
            $calendar[0].accessRights | Should -Be @('AvailabilityOnly')
            $calendar[0].automap | Should -BeFalse
            $calendar[0].inherited | Should -BeFalse
        }

        It 'excludes system and inherited permission grants' {
            $result = Get-MailboxPermissions -TenantId 'tenant-a'

            @($result.items).principal | Should -Not -Contain 'NT AUTHORITY\SELF'
            @($result.items).principal | Should -Not -Contain 'inherited@example.invalid'
        }

        It 'requires the tenant identifier' {
            { Get-MailboxPermissions -TenantId '' } | Should -Throw
        }
    }

    Context 'scope and search filters' {
        BeforeEach {
            script:New-MailboxPermissionsMock
        }

        It 'restricts the report to one permission family' {
            $mailboxOnly = Get-MailboxPermissions -TenantId 'tenant-a' -Scope 'mailbox'
            $mailboxOnly.totalCount | Should -Be 5
            @($mailboxOnly.items).scope | Should -Not -Contain 'calendar'

            $calendarOnly = Get-MailboxPermissions -TenantId 'tenant-a' -Scope 'calendar'
            $calendarOnly.totalCount | Should -Be 2
            @($calendarOnly.items).scope | Should -Not -Contain 'mailbox'
        }

        It 'searches mailbox and principal names case-insensitively' {
            $result = Get-MailboxPermissions -TenantId 'tenant-a' -Search 'SUPPORT'
            $result.totalCount | Should -Be 4
            $result = Get-MailboxPermissions -TenantId 'tenant-a' -Search 'sender@'
            $result.totalCount | Should -Be 2
        }
    }

    Context 'per-mailbox filter' {
        BeforeEach {
            script:New-MailboxPermissionsMock
            Mock Get-EXOMailbox {
                param($Identity, $ResultSize, $Properties, $RecipientTypeDetails, $Filter)
                if ($Identity) {
                    return @($script:supportMailbox, $script:userMailbox) | Where-Object {
                        $_.ExchangeObjectId -eq $Identity -or $_.PrimarySmtpAddress -eq $Identity
                    }
                }
                return @($script:supportMailbox, $script:userMailbox)
            }
        }

        It 'returns only the requested mailbox rows and looks up only that mailbox' {
            $result = Get-MailboxPermissions -TenantId 'tenant-a' -MailboxId 'mbx-1'

            $result.totalCount | Should -Be 4
            @($result.items).mailboxId | Select-Object -Unique | Should -Be 'mbx-1'
            Should -Invoke Get-MailboxPermission -Times 1 -Exactly
            Should -Invoke Get-EXOMailbox -Times 1 -Exactly -ParameterFilter { $Identity -eq 'mbx-1' }
        }

        It 'accepts the primary SMTP address as the mailbox identity' {
            $result = Get-MailboxPermissions -TenantId 'tenant-a' -MailboxId 'operator.one@example.invalid'

            @($result.items).mailboxId | Select-Object -Unique | Should -Be 'mbx-2'
        }

        It 'fails for an unknown mailbox instead of returning an empty report' {
            { Get-MailboxPermissions -TenantId 'tenant-a' -MailboxId 'missing-mailbox' } | Should -Throw '*not found*'
        }
    }

    Context 'cursor pagination' {
        BeforeEach {
            script:New-MailboxPermissionsMock
        }

        It 'pages through the permission set with an opaque cursor' {
            $first = Get-MailboxPermissions -TenantId 'tenant-a' -Top 4

            $first.items | Should -HaveCount 4
            $first.totalCount | Should -Be 7
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-MailboxPermissions -TenantId 'tenant-a' -Top 4 -Cursor $first.nextCursor
            $second.items | Should -HaveCount 3
            $second.nextCursor | Should -Be ''
            @(@($first.items) + @($second.items)).principal | Should -HaveCount 7
        }

        It 'restarts at the first page for a blank or invalid cursor' {
            (Get-MailboxPermissions -TenantId 'tenant-a' -Top 1 -Cursor '').items | Should -HaveCount 1
            $result = Get-MailboxPermissions -TenantId 'tenant-a' -Top 1 -Cursor 'not-a-cursor'
            $result.items | Should -HaveCount 1
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id and payload fields' {
            $jobPath = Join-Path $TestDrive 'mailbox-permissions-job.json'
            @{
                jobId         = 'job-1'
                tenantId     = 'tenant-a'
                scope         = 'calendar'
                mailboxId     = 'mbx-1'
                search        = 'delegate'
                top           = 25
                cursor        = 'MTAw'
                credential    = @{ credentialRef = 'tenants/tenant-a/credential'; record = @{} }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-MailboxPermissionsJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Scope'] | Should -Be 'calendar'
            $job['MailboxId'] | Should -Be 'mbx-1'
            $job['Search'] | Should -Be 'delegate'
            $job['Top'] | Should -Be 25
            $job['Cursor'] | Should -Be 'MTAw'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $jobPath = Join-Path $TestDrive 'mailbox-permissions-job-empty.json'
            @{ jobId = 'job-1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-MailboxPermissionsJob -Path $jobPath } | Should -Throw '*tenantId*'
            { Read-MailboxPermissionsJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }
}
