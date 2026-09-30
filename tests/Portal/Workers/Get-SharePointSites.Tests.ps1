BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-SharePointSites.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-sharepoint-sites.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Get-SharePointSites worker (T-0482)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-SharePointSites -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SharePointSitesJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-SharePointSiteRow -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-SharePointSiteFilter -CommandType Function) | Should -Not -BeNullOrEmpty
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
            $entrySource | Should -Match 'Get-SharePointSites\.ps1'
            $entrySource | Should -Match 'Read-SharePointSitesJob -Path'
            $entrySource | Should -Match 'Get-SharePointSites @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'Get-SharePointSites live mapping and filters' {
        BeforeEach {
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
                                sharingCapability = 'disabled'
                                sensitivityLabel = $null
                            }
                            @{
                                id = 'site-3'
                                displayName = 'Team Gamma'
                                webUrl = 'https://contoso.sharepoint.com/sites/gamma'
                                createdDateTime = '2026-03-10T00:00:00Z'
                                lastModifiedDateTime = '2026-01-15T00:00:00Z'
                                isPersonalSite = $false
                                sharingCapability = 'externalUserAndGuestSharing'
                                sensitivityLabel = 'Confidential'
                            }
                            @{
                                id = 'site-4'
                                displayName = 'Personal Delta'
                                webUrl = 'https://contoso.sharepoint.com/personal/delta'
                                createdDateTime = '2026-04-10T00:00:00Z'
                                lastModifiedDateTime = '2026-05-01T00:00:00Z'
                                isPersonalSite = $true
                                sharingCapability = 'disabled'
                                sensitivityLabel = $null
                            }
                        )
                    }
                }
                if ($Uri -like '/v1.0/sites/*/drive*') {
                    $driveSiteId = ''
                    if ($Uri -match '/v1\.0/sites/([^/]+)/drive') { $driveSiteId = $Matches[1] }
                    switch ($driveSiteId) {
                        'site-1' {
                            return @{
                                quota = @{ used = 5368709120; total = 10737418240 }
                                owner = @{ user = @{ displayName = 'Owner One'; email = 'owner1@example.invalid' } }
                            }
                        }
                        'site-2' {
                            return @{
                                quota = @{ used = 1073741824; total = 10737418240 }
                                owner = @{ user = @{ displayName = 'Owner Two'; email = 'owner2@example.invalid' } }
                            }
                        }
                        default {
                            return @{
                                quota = @{ used = 9663676416; total = 10737418240 }
                                owner = @{ user = @{ displayName = 'Owner Three'; email = 'owner3@example.invalid' } }
                            }
                        }
                    }
                }
                if ($Uri -like '/v1.0/sites/*/team*') {
                    $teamSiteId = ''
                    if ($Uri -match '/v1\.0/sites/([^/]+)/team') { $teamSiteId = $Matches[1] }
                    if ($teamSiteId -eq 'site-2') {
                        throw '404 Not Found'
                    }
                    return @{ id = 'team-1' }
                }
                return @{}
            }
        }

        It 'returns the §3.1 columns and excludes personal sites' {
            $result = Get-SharePointSites -TenantId 'tenant-test'
            $result.tenantId | Should -Be 'tenant-test'
            $result.totalCount | Should -Be 3
            $result.items.Count | Should -Be 3
            $result.nextCursor | Should -BeNullOrEmpty

            $alpha = $result.items | Where-Object { $_.id -eq 'site-1' }
            $alpha.name | Should -Be 'Team Alpha'
            $alpha.url | Should -Be 'https://contoso.sharepoint.com/sites/alpha'
            $alpha.type | Should -Be 'team'
            $alpha.owners | Should -Contain 'owner1@example.invalid'
            $alpha.storageUsedMB | Should -Be 5120
            $alpha.storageAllocatedMB | Should -Be 10240
            $alpha.storageUsedPercent | Should -Be 50
            $alpha.lastActivity | Should -Be '2026-09-01T00:00:00Z'
            $alpha.sensitivity | Should -Be 'General'
            $alpha.sharing | Should -Be 'externalUserSharingOnly'

            $beta = $result.items | Where-Object { $_.id -eq 'site-2' }
            $beta.type | Should -Be 'communication'
            $beta.sharing | Should -Be 'disabled'
            $beta.sensitivity | Should -Be ''
            $beta.storageUsedPercent | Should -Be 10

            $gamma = $result.items | Where-Object { $_.id -eq 'site-3' }
            $gamma.type | Should -Be 'team'
            $gamma.storageUsedMB | Should -Be 9216
            $gamma.storageUsedPercent | Should -Be 90
            $gamma.sensitivity | Should -Be 'Confidential'
            $gamma.sharing | Should -Be 'externalUserAndGuestSharing'
        }

        It 'filters by type' {
            $team = Get-SharePointSites -TenantId 'tenant-test' -Type 'team'
            $team.totalCount | Should -Be 2
            $team.items.id | Should -Contain 'site-1'
            $team.items.id | Should -Contain 'site-3'

            $comm = Get-SharePointSites -TenantId 'tenant-test' -Type 'communication'
            $comm.totalCount | Should -Be 1
            $comm.items[0].id | Should -Be 'site-2'
        }

        It 'filters by sharing' {
            $disabled = Get-SharePointSites -TenantId 'tenant-test' -Sharing 'disabled'
            $disabled.totalCount | Should -Be 1
            $disabled.items[0].id | Should -Be 'site-2'

            $guests = Get-SharePointSites -TenantId 'tenant-test' -Sharing 'externalUserAndGuestSharing'
            $guests.totalCount | Should -Be 1
            $guests.items[0].id | Should -Be 'site-3'
        }

        It 'filters by storage percent' {
            $result = Get-SharePointSites -TenantId 'tenant-test' -StoragePercent '50'
            $result.totalCount | Should -Be 2
            $result.items.id | Should -Contain 'site-1'
            $result.items.id | Should -Contain 'site-3'
        }

        It 'filters by last activity' {
            $result = Get-SharePointSites -TenantId 'tenant-test' -LastActivity '2026-07-01T00:00:00Z'
            $result.totalCount | Should -Be 1
            $result.items[0].id | Should -Be 'site-1'
        }

        It 'filters by sensitivity label and by unlabeled' {
            $general = Get-SharePointSites -TenantId 'tenant-test' -Sensitivity 'General'
            $general.totalCount | Should -Be 1
            $general.items[0].id | Should -Be 'site-1'

            $unlabeled = Get-SharePointSites -TenantId 'tenant-test' -Sensitivity 'none'
            $unlabeled.totalCount | Should -Be 1
            $unlabeled.items[0].id | Should -Be 'site-2'
        }

        It 'paginates with the cursor' {
            $page1 = Get-SharePointSites -TenantId 'tenant-test' -Top 2
            $page1.totalCount | Should -Be 3
            $page1.items.Count | Should -Be 2
            $page1.nextCursor | Should -Not -BeNullOrEmpty

            $page2 = Get-SharePointSites -TenantId 'tenant-test' -Top 2 -Cursor $page1.nextCursor
            $page2.items.Count | Should -Be 1
            $page2.items[0].id | Should -Be 'site-3'
            $page2.nextCursor | Should -BeNullOrEmpty
        }
    }

    Context 'the entrypoint in direct mode' {
        It 'runs the handler and emits the page as JSON' {
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
                        )
                    }
                }
                if ($Uri -like '/v1.0/sites/*/drive*') {
                    return @{
                        quota = @{ used = 5368709120; total = 10737418240 }
                        owner = @{ user = @{ displayName = 'Owner One'; email = 'owner1@example.invalid' } }
                    }
                }
                if ($Uri -like '/v1.0/sites/*/team*') {
                    return @{ id = 'team-1' }
                }
                return @{}
            }

            $output = & $script:entrypoint -TenantId 'tenant-test' -Type 'team'
            $page = $output | ConvertFrom-Json
            $page.tenantId | Should -Be 'tenant-test'
            $page.totalCount | Should -Be 1
            $page.items[0].type | Should -Be 'team'
            $page.items[0].name | Should -Be 'Team Alpha'
        }
    }
}
