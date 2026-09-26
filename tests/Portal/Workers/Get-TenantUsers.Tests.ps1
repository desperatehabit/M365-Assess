BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-TenantUsers.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-tenant-users.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri)
    }

    . $script:worker

    $script:recentSignIn = (Get-Date).ToUniversalTime().AddDays(-2).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $script:olderSignIn = (Get-Date).ToUniversalTime().AddDays(-100).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $script:staleSignIn = (Get-Date).ToUniversalTime().AddDays(-400).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $script:memberRecent = @{
        id                 = 'user-1'
        displayName        = 'Member Recent'
        userPrincipalName  = 'member.recent@example.invalid'
        userType           = 'Member'
        assignedLicenses   = @(@{ skuId = 'sku-1' })
        accountEnabled     = $true
        department         = 'Engineering'
        signInActivity     = @{ lastSignInDateTime = $script:recentSignIn }
    }
    $script:memberStale = @{
        id                 = 'user-2'
        displayName        = 'Member Stale'
        userPrincipalName  = 'member.stale@example.invalid'
        userType           = 'Member'
        assignedLicenses   = @()
        accountEnabled     = $true
        department         = 'Finance'
        signInActivity     = @{ lastSignInDateTime = $script:staleSignIn }
    }
    $script:guestNever = @{
        id                 = 'user-3'
        displayName        = 'Guest Never'
        userPrincipalName  = 'guest.never@example.invalid'
        userType           = 'Guest'
        assignedLicenses   = @()
        accountEnabled     = $false
        department         = ''
    }
    $script:memberDisabled = @{
        id                 = 'user-4'
        displayName        = 'Member Disabled'
        userPrincipalName  = 'member.disabled@example.invalid'
        userType           = 'Member'
        assignedLicenses   = @(@{ skuId = 'sku-1' }, @{ skuId = 'sku-2' })
        accountEnabled     = $false
        department         = 'Engineering'
        signInActivity     = @{ lastSignInDateTime = $script:olderSignIn }
    }

    function script:New-UserListMock {
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri)
            if ($Uri -like '*userRegistrationDetails*') {
                return @{ value = @(
                    @{ userPrincipalName = 'member.recent@example.invalid'; isMfaRegistered = $true }
                    @{ userPrincipalName = 'member.stale@example.invalid'; isMfaRegistered = $false }
                    @{ userPrincipalName = 'member.disabled@example.invalid'; isMfaRegistered = $true }
                ) }
            }
            return @{ value = @($script:memberRecent, $script:memberStale, $script:guestNever, $script:memberDisabled) }
        }
    }
}

Describe 'Get-TenantUsers worker (T-0201)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-TenantUsers -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-InactiveTenantUsers -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-GuestTenantUsers -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-TenantUserSignInReport -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-TenantUsersJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads users with GET requests only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match '-Method DELETE'
        }

        It 'never persists user data to disk, logs, or artifacts' {
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

        It 'entrypoint reads the job envelope, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-TenantUsers.ps1'
            $entrySource | Should -Match 'Read-TenantUsersJob -Path'
            $entrySource | Should -Match 'Get-TenantUsers @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
        }

        It 'report views delegate to the shared read path' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'function Get-InactiveTenantUsers'
            $source | Should -Match 'Get-TenantUsers -TenantId \$TenantId -InactiveDays'
            $source | Should -Match 'Get-TenantUsers -TenantId \$TenantId -UserType ''guest'''
            $source | Should -Match 'Get-TenantUsers -TenantId \$TenantId -OrderByLastSignIn'
        }
    }

    Context 'directory mapping' {
        BeforeEach {
            script:New-UserListMock
        }

        It 'returns the section columns with cursor paging metadata' {
            $result = Get-TenantUsers -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.items | Should -HaveCount 4
            $result.nextCursor | Should -Be ''
            $result.totalCount | Should -Be 4
            $result.retrievedAt | Should -Not -BeNullOrEmpty
            $row = @($result.items | Where-Object { $_.id -eq 'user-1' })[0]
            $row.displayName | Should -Be 'Member Recent'
            $row.userPrincipalName | Should -Be 'member.recent@example.invalid'
            $row.userType | Should -Be 'member'
            @($row.licenses) | Should -Be @('sku-1')
            $row.mfaState | Should -Be 'registered'
            $row.lastSignInDateTime | Should -Be $script:recentSignIn
            $row.status | Should -Be 'enabled'
            $row.department | Should -Be 'Engineering'
        }

        It 'maps guest, disabled, unlicensed, and unknown MFA rows' {
            $result = Get-TenantUsers -TenantId 'tenant-a'

            $guest = @($result.items | Where-Object { $_.id -eq 'user-3' })[0]
            $guest.userType | Should -Be 'guest'
            $guest.status | Should -Be 'disabled'
            @($guest.licenses) | Should -HaveCount 0
            $guest.mfaState | Should -Be 'unknown'
            $guest.lastSignInDateTime | Should -BeNullOrEmpty
            $stale = @($result.items | Where-Object { $_.id -eq 'user-2' })[0]
            $stale.mfaState | Should -Be 'notRegistered'
        }

        It 'issues only GET requests against the users and registration endpoints' {
            $null = Get-TenantUsers -TenantId 'tenant-a'

            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -ne 'GET' }
            Should -Invoke Invoke-MgGraphRequest -ParameterFilter { $Uri -like '*/users*' }
            Should -Invoke Invoke-MgGraphRequest -ParameterFilter { $Uri -like '*userRegistrationDetails*' }
        }

        It 'retries without signInActivity when the tenant cannot return it' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                if ($Uri -like '*userRegistrationDetails*') {
                    return @{ value = @() }
                }
                if ($Uri -like '*signInActivity*') {
                    throw 'Authorization_RequestDenied: signInActivity requires AuditLog.Read.All'
                }
                $withoutActivity = @{
                    id                 = 'user-2'
                    displayName        = 'Member Stale'
                    userPrincipalName  = 'member.stale@example.invalid'
                    userType           = 'Member'
                    assignedLicenses   = @()
                    accountEnabled     = $true
                    department         = 'Finance'
                }
                return @{ value = @($withoutActivity) }
            }

            $result = Get-TenantUsers -TenantId 'tenant-a'

            $result.items | Should -HaveCount 1
            @($result.items)[0].lastSignInDateTime | Should -BeNullOrEmpty
            Should -Invoke Invoke-MgGraphRequest -ParameterFilter { $Uri -like '*signInActivity*' }
        }

        It 'reports MFA state as unknown when the registration endpoint is unavailable' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                if ($Uri -like '*userRegistrationDetails*') {
                    throw 'Authorization_RequestDenied'
                }
                return @{ value = @($script:memberRecent) }
            }

            $result = Get-TenantUsers -TenantId 'tenant-a'

            @($result.items)[0].mfaState | Should -Be 'unknown'
        }

        It 'requires the tenant identifier' {
            { Get-TenantUsers -TenantId '' } | Should -Throw
        }
    }

    Context 'filters' {
        BeforeEach {
            script:New-UserListMock
        }

        It 'searches display name and UPN case-insensitively' {
            (Get-TenantUsers -TenantId 'tenant-a' -Search 'MEMBER').items | Should -HaveCount 3
            $result = Get-TenantUsers -TenantId 'tenant-a' -Search 'guest.never@'
            $result.items | Should -HaveCount 1
            @($result.items)[0].id | Should -Be 'user-3'
        }

        It 'filters by enabled and disabled status' {
            $enabled = Get-TenantUsers -TenantId 'tenant-a' -Status 'enabled'
            @($enabled.items).id | Should -Be @('user-1', 'user-2')
            $disabled = Get-TenantUsers -TenantId 'tenant-a' -Status 'disabled'
            @($disabled.items).id | Should -Be @('user-3', 'user-4')
        }

        It 'filters by member and guest type' {
            (Get-TenantUsers -TenantId 'tenant-a' -UserType 'guest').items | Should -HaveCount 1
            (Get-TenantUsers -TenantId 'tenant-a' -UserType 'member').items | Should -HaveCount 3
        }

        It 'filters by licensed and unlicensed' {
            $licensed = Get-TenantUsers -TenantId 'tenant-a' -License 'licensed'
            @($licensed.items).id | Should -Be @('user-1', 'user-4')
            $unlicensed = Get-TenantUsers -TenantId 'tenant-a' -License 'unlicensed'
            @($unlicensed.items).id | Should -Be @('user-2', 'user-3')
        }

        It 'filters by MFA state' {
            (Get-TenantUsers -TenantId 'tenant-a' -MfaState 'registered').items | Should -HaveCount 2
            (Get-TenantUsers -TenantId 'tenant-a' -MfaState 'notRegistered').items | Should -HaveCount 1
            (Get-TenantUsers -TenantId 'tenant-a' -MfaState 'unknown').items | Should -HaveCount 1
        }

        It 'filters by department case-insensitively' {
            $result = Get-TenantUsers -TenantId 'tenant-a' -Department 'engineering'
            @($result.items).id | Should -Be @('user-1', 'user-4')
        }

        It 'filters by sign-in age, counting never-signed-in as inactive' {
            $result = Get-TenantUsers -TenantId 'tenant-a' -InactiveDays 30
            @($result.items).id | Should -Contain 'user-2'
            @($result.items).id | Should -Contain 'user-3'
            @($result.items).id | Should -Not -Contain 'user-1'
        }
    }

    Context 'cursor pagination' {
        BeforeEach {
            script:New-UserListMock
        }

        It 'pages through the filtered set with an opaque cursor' {
            $first = Get-TenantUsers -TenantId 'tenant-a' -Top 2

            $first.items | Should -HaveCount 2
            $first.totalCount | Should -Be 4
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-TenantUsers -TenantId 'tenant-a' -Top 2 -Cursor $first.nextCursor
            $second.items | Should -HaveCount 2
            $second.nextCursor | Should -Be ''
            @(@($first.items) + @($second.items)).id | Should -Be @('user-1', 'user-2', 'user-3', 'user-4')
        }

        It 'restarts at the first page for a blank or invalid cursor' {
            (Get-TenantUsers -TenantId 'tenant-a' -Top 1 -Cursor '').items | Should -HaveCount 1
            $result = Get-TenantUsers -TenantId 'tenant-a' -Top 1 -Cursor 'not-a-cursor'
            @($result.items)[0].id | Should -Be 'user-1'
        }
    }

    Context 'report views' {
        BeforeEach {
            script:New-UserListMock
        }

        It 'derives the inactive view from the shared read with a 90-day default' {
            $result = Get-InactiveTenantUsers -TenantId 'tenant-a'

            @($result.items).id | Should -Contain 'user-2'
            @($result.items).id | Should -Contain 'user-3'
            @($result.items).id | Should -Not -Contain 'user-1'
            $result.tenantId | Should -Be 'tenant-a'
        }

        It 'derives the guest view from the shared read' {
            $result = Get-GuestTenantUsers -TenantId 'tenant-a'

            $result.items | Should -HaveCount 1
            @($result.items)[0].id | Should -Be 'user-3'
        }

        It 'orders the sign-in view most-recent-first with never-signed-in last' {
            $result = Get-TenantUserSignInReport -TenantId 'tenant-a'

            @($result.items).id | Should -Be @('user-1', 'user-4', 'user-2', 'user-3')
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id and payload filters' {
            $jobPath = Join-Path $TestDrive 'users-job.json'
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
                    filters       = @{ type = 'guest'; top = 25 }
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-TenantUsersJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['UserType'] | Should -Be 'guest'
            $job['Top'] | Should -Be 25
            $job['InactiveDays'] | Should -Be 0
        }

        It 'rejects envelopes with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'users-job-bad.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-TenantUsersJob -Path $jobPath } | Should -Throw '*schemaVersion*'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $jobPath = Join-Path $TestDrive 'users-job-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-TenantUsersJob -Path $jobPath } | Should -Throw '*tenantId*'
            { Read-TenantUsersJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }
}
