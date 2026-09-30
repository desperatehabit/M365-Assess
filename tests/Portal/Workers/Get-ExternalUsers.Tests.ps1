BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-ExternalUsers.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-external-users.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker

    function script:New-ExternalUsersMock {
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body)
            if ($Uri -like '/v1.0/sites/getAllSites*') {
                return @{
                    value = @(
                        @{
                            id = 'site-1'
                            displayName = 'Team Alpha'
                            webUrl = 'https://contoso.sharepoint.com/sites/alpha'
                            createdDateTime = '2026-01-10T00:00:00Z'
                            lastModifiedDateTime = '2026-09-01T00:00:00Z'
                            isPersonalSite = $false
                            sharingCapability = 'externalUserSharingOnly'
                            sensitivityLabel = 'General'
                        }
                        @{
                            id = 'site-2'
                            displayName = 'Comm Beta'
                            webUrl = 'https://contoso.sharepoint.com/sites/beta'
                            createdDateTime = '2026-02-10T00:00:00Z'
                            lastModifiedDateTime = '2026-06-01T00:00:00Z'
                            isPersonalSite = $false
                            sharingCapability = 'externalUserAndGuestSharing'
                            sensitivityLabel = $null
                        }
                    )
                }
            }
            if ($Uri -like '/v1.0/domains*') {
                return @{ value = @(@{ id = 'contoso.invalid' }) }
            }
            if ($Uri -like '/v1.0/users*') {
                return @{
                    value = @(
                        @{
                            id = 'guest-1'
                            mail = 'jane@partner.invalid'
                            userPrincipalName = 'jane_partner.invalid#EXT#@contoso.invalid'
                            signInActivity = @{ lastSignInDateTime = '2026-09-20T00:00:00Z' }
                        }
                    )
                }
            }
            if ($Uri -like '/v1.0/sites/site-1/permissions*') {
                return @{
                    value = @(
                        @{
                            id = 'perm-1'
                            roles = @('write')
                            createdDateTime = '2026-03-01T00:00:00Z'
                            invitation = @{ invitedBy = @{ user = @{ displayName = 'Owner One' } } }
                            grantedToIdentitiesV2 = @(
                                @{ user = @{ displayName = 'Jane External'; email = 'jane@partner.invalid' } }
                            )
                        }
                        @{
                            id = 'perm-2'
                            roles = @('read')
                            createdDateTime = '2026-03-05T00:00:00Z'
                            invitation = @{ invitedBy = @{ user = @{ displayName = 'Owner One' } } }
                            grantedToIdentitiesV2 = @(
                                @{ user = @{ displayName = 'Staff Member'; email = 'staff@contoso.invalid' } }
                            )
                        }
                        @{
                            id = 'perm-3'
                            roles = @('read')
                            itemId = 'item-9'
                            itemName = 'Plan.docx'
                            createdDateTime = '2026-04-02T00:00:00Z'
                            invitation = @{ invitedBy = @{ user = @{ displayName = 'Owner One' } } }
                            grantedToIdentitiesV2 = @(
                                @{ user = @{ displayName = 'Jane External'; email = 'jane@partner.invalid' } }
                            )
                        }
                    )
                }
            }
            if ($Uri -like '/v1.0/sites/site-2/permissions*') {
                return @{
                    value = @(
                        @{
                            id = 'perm-4'
                            roles = @('read')
                            createdDateTime = '2026-05-01T00:00:00Z'
                            invitation = @{ invitedBy = @{ user = @{ displayName = 'Owner Two' } } }
                            grantedToIdentitiesV2 = @(
                                @{ user = @{ displayName = 'Sam Partner'; email = 'sam@fabrikam.invalid' } }
                            )
                        }
                        @{
                            id = 'perm-5'
                            roles = @('read')
                            link = @{ type = 'anonymous' }
                        }
                    )
                }
            }
            if ($Uri -like '/v1.0/sites/site-1/drive*') {
                return @{
                    quota = @{ used = 5368709120; total = 10737418240 }
                    owner = @{ user = @{ displayName = 'Owner One'; email = 'owner1@example.invalid' } }
                }
            }
            if ($Uri -like '/v1.0/sites/site-2/drive*') {
                return @{
                    quota = @{ used = 1073741824; total = 10737418240 }
                    owner = @{ user = @{ displayName = 'Owner Two'; email = 'owner2@example.invalid' } }
                }
            }
            if ($Uri -like '/v1.0/sites/site-1/team') {
                return @{ id = 'team-1' }
            }
            if ($Uri -like '/v1.0/sites/site-2/team') {
                throw '404 Not Found'
            }
            return @{}
        }
    }
}

Describe 'Get-ExternalUsers worker (T-0525)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-ExternalUsers -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-ExternalUserAccess -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-ExternalUsersJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'entrypoint delegates to the handler and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-ExternalUsers\.ps1'
            $entrySource | Should -Match 'Read-ExternalUsersJob -Path'
            $entrySource | Should -Match 'Get-ExternalUsers -TenantId'
            $entrySource | Should -Match 'Get-ExternalUserAccess -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'aggregation' {
        BeforeEach {
            script:New-ExternalUsersMock
        }

        It 'returns the §3.3 columns for external users only' {
            $result = Get-ExternalUsers -TenantId 'tenant-test'

            $result.tenantId | Should -Be 'tenant-test'
            $result.totalCount | Should -Be 2
            $result.items.Count | Should -Be 2
            $result.nextCursor | Should -Be ''
            $result.retrievedAt | Should -Not -BeNullOrEmpty

            $jane = $result.items | Where-Object { $_.email -eq 'jane@partner.invalid' }
            $jane.externalUser | Should -Be 'Jane External'
            $jane.sites | Should -Contain 'Team Alpha'
            $jane.siteCount | Should -Be 1
            $jane.accessCount | Should -Be 2
            $jane.lastAccess | Should -Be '2026-09-20T00:00:00Z'
            $jane.invitedBy | Should -Be 'Owner One'

            $sam = $result.items | Where-Object { $_.email -eq 'sam@fabrikam.invalid' }
            $sam.externalUser | Should -Be 'Sam Partner'
            $sam.sites | Should -Contain 'Comm Beta'
            $sam.siteCount | Should -Be 1
            $sam.lastAccess | Should -BeNullOrEmpty
            $sam.invitedBy | Should -Be 'Owner Two'
        }

        It 'excludes internal grantees and anonymous links' {
            $result = Get-ExternalUsers -TenantId 'tenant-test'
            @($result.items).email | Should -Not -Contain 'staff@contoso.invalid'
            $result.totalCount | Should -Be 2
        }

        It 'searches display name and email case-insensitively' {
            (Get-ExternalUsers -TenantId 'tenant-test' -Search 'JANE').totalCount | Should -Be 1
            (Get-ExternalUsers -TenantId 'tenant-test' -Search 'fabrikam').totalCount | Should -Be 1
            (Get-ExternalUsers -TenantId 'tenant-test' -Search 'nobody').totalCount | Should -Be 0
        }

        It 'paginates with an opaque cursor' {
            $first = Get-ExternalUsers -TenantId 'tenant-test' -Top 1
            $first.items | Should -HaveCount 1
            $first.totalCount | Should -Be 2
            $first.nextCursor | Should -Not -BeNullOrEmpty

            $second = Get-ExternalUsers -TenantId 'tenant-test' -Top 1 -Cursor $first.nextCursor
            $second.items | Should -HaveCount 1
            $second.nextCursor | Should -Be ''
            @(@($first.items) + @($second.items)).email | Should -Contain 'jane@partner.invalid'
            @(@($first.items) + @($second.items)).email | Should -Contain 'sam@fabrikam.invalid'
        }

        It 'restarts at the first page for an invalid cursor' {
            $result = Get-ExternalUsers -TenantId 'tenant-test' -Top 1 -Cursor 'not-a-cursor'
            $result.items | Should -HaveCount 1
        }
    }

    Context 'drill-through' {
        BeforeEach {
            script:New-ExternalUsersMock
        }

        It 'lists the sites and items one external user can access' {
            $result = Get-ExternalUserAccess -TenantId 'tenant-test' -ExternalUserId 'jane@partner.invalid'

            $result.externalUserId | Should -Be 'jane@partner.invalid'
            $result.totalCount | Should -Be 2
            $result.items | Should -HaveCount 2
            @($result.items).siteName | Should -Contain 'Team Alpha'
            $item = $result.items | Where-Object { $_.itemName -eq 'Plan.docx' }
            $item.itemId | Should -Be 'item-9'
            $item.roles | Should -Contain 'read'
            $item.invitedBy | Should -Be 'Owner One'
        }

        It 'returns nothing for a user without external access' {
            $result = Get-ExternalUserAccess -TenantId 'tenant-test' -ExternalUserId 'nobody@example.invalid'
            $result.totalCount | Should -Be 0
            $result.items | Should -HaveCount 0
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id and payload fields' {
            $jobPath = Join-Path $TestDrive 'external-users-job.json'
            @{
                jobId   = 'job-1'
                tenantId = 'tenant-test'
                payload = @{
                    filters = @{
                        search         = 'jane'
                        externalUserId = 'jane@partner.invalid'
                        top            = 25
                        cursor         = 'MTAw'
                    }
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-ExternalUsersJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-test'
            $job['Search'] | Should -Be 'jane'
            $job['ExternalUserId'] | Should -Be 'jane@partner.invalid'
            $job['Top'] | Should -Be 25
            $job['Cursor'] | Should -Be 'MTAw'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $jobPath = Join-Path $TestDrive 'external-users-job-empty.json'
            @{ jobId = 'job-1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-ExternalUsersJob -Path $jobPath } | Should -Throw '*tenantId*'
            { Read-ExternalUsersJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }

    Context 'the entrypoint in direct mode' {
        It 'aggregates and emits the page as JSON' {
            script:New-ExternalUsersMock
            $output = & $script:entrypoint -TenantId 'tenant-test'
            $page = $output | ConvertFrom-Json
            $page.tenantId | Should -Be 'tenant-test'
            $page.totalCount | Should -Be 2
            $page.items[0].email | Should -Be 'jane@partner.invalid'
        }

        It 'drills through when ExternalUserId is supplied' {
            script:New-ExternalUsersMock
            $output = & $script:entrypoint -TenantId 'tenant-test' -ExternalUserId 'jane@partner.invalid'
            $page = $output | ConvertFrom-Json
            $page.externalUserId | Should -Be 'jane@partner.invalid'
            $page.totalCount | Should -Be 2
        }
    }
}
