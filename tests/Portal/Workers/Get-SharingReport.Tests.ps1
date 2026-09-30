BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-SharingReport.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-sharing-report.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker

    $script:sites = @(
        [pscustomobject]@{ id = 'site-1'; name = 'Team Alpha'; url = 'https://contoso.sharepoint.com/sites/alpha' }
        [pscustomobject]@{ id = 'site-2'; name = 'Comm Beta'; url = 'https://contoso.sharepoint.com/sites/beta' }
    )
}

Describe 'Get-SharingReport worker (T-0521)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-SharingReport -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SharingReportJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-SharingReportRow -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-SharingReportFilter -CommandType Function) | Should -Not -BeNullOrEmpty
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
            $entrySource | Should -Match 'Get-SharingReport\.ps1'
            $entrySource | Should -Match 'Read-SharingReportJob -Path'
            $entrySource | Should -Match 'Get-SharingReport @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'Get-SharingReport live mapping and filters' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)

                if ($Uri -like '*/sites/site-1/drive*') { return @{ id = 'drive-1' } }
                if ($Uri -like '*/sites/site-2/drive*') { return @{ id = 'drive-2' } }

                if ($Uri -like '*/drives/drive-1/root*') {
                    return @{ id = 'root'; name = 'root'; webUrl = 'https://contoso.sharepoint.com/sites/alpha'; folder = @{ childCount = 2 } }
                }
                if ($Uri -like '*/drives/drive-2/root*') {
                    return @{ id = 'root'; name = 'root'; webUrl = 'https://contoso.sharepoint.com/sites/beta'; folder = @{ childCount = 0 } }
                }

                if ($Uri -like '*/drives/drive-1/items/root/children*') {
                    return @{ value = @(
                            @{ id = 'item-1'; name = 'Budget.xlsx'; webUrl = 'https://contoso.sharepoint.com/sites/alpha/Budget.xlsx'; file = @{ mimeType = 'application/vnd.ms-excel' } }
                            @{ id = 'item-2'; name = 'Plan.docx'; webUrl = 'https://contoso.sharepoint.com/sites/alpha/Plan.docx'; file = @{ mimeType = 'application/msword' } }
                            @{ id = 'folder-1'; name = 'Reports'; webUrl = 'https://contoso.sharepoint.com/sites/alpha/Reports'; folder = @{ childCount = 1 } }
                        ) }
                }
                if ($Uri -like '*/drives/drive-1/items/folder-1/children*') {
                    return @{ value = @(
                            @{ id = 'item-3'; name = 'Q3.xlsx'; webUrl = 'https://contoso.sharepoint.com/sites/alpha/Q3.xlsx'; file = @{ mimeType = 'application/vnd.ms-excel' } }
                        ) }
                }
                if ($Uri -like '*/drives/drive-2/items/root/children*') {
                    return @{ value = @() }
                }

                if ($Uri -like '*/drives/drive-1/items/item-1/permissions*') {
                    return @{ value = @(
                            @{ id = 'perm-anon'; link = @{ scope = 'anonymous'; type = 'view' }; createdBy = @{ user = @{ userPrincipalName = 'owner1@example.invalid' } }; createdDateTime = '2026-09-01T00:00:00Z'; expirationDateTime = '2026-10-01T00:00:00Z' }
                            @{ id = 'perm-org'; link = @{ scope = 'organization'; type = 'edit' }; createdBy = @{ user = @{ userPrincipalName = 'owner1@example.invalid' } }; createdDateTime = '2026-08-01T00:00:00Z' }
                        ) }
                }
                if ($Uri -like '*/drives/drive-1/items/item-2/permissions*') {
                    return @{ value = @(
                            @{ id = 'perm-people'; link = @{ scope = 'users'; type = 'view' }; createdBy = @{ user = @{ userPrincipalName = 'owner2@example.invalid' } }; createdDateTime = '2026-07-01T00:00:00Z' }
                        ) }
                }
                if ($Uri -like '*/drives/drive-2/items/root/permissions*') {
                    return @{ value = @(
                            @{ id = 'perm-org-2'; link = @{ scope = 'organization'; type = 'edit' }; createdBy = @{ user = @{ userPrincipalName = 'owner3@example.invalid' } }; createdDateTime = '2026-06-01T00:00:00Z' }
                        ) }
                }
                return @{ value = @() }
            }
        }

        It 'lists the §3.1 columns across sites and item hierarchy' {
            $result = Get-SharingReport -TenantId 'tenant-test' -Sites $script:sites
            $result.tenantId | Should -Be 'tenant-test'
            $result.totalCount | Should -Be 4
            $result.items.Count | Should -Be 4
            $result.nextCursor | Should -BeNullOrEmpty

            $anon = $result.items | Where-Object { $_.linkId -eq 'perm-anon' }
            $anon.siteName | Should -Be 'Team Alpha'
            $anon.siteUrl | Should -Be 'https://contoso.sharepoint.com/sites/alpha'
            $anon.itemName | Should -Be 'Budget.xlsx'
            $anon.linkType | Should -Be 'anonymous'
            $anon.permissions | Should -Be 'view'
            $anon.createdBy | Should -Be 'owner1@example.invalid'
            $anon.created | Should -Be '2026-09-01T00:00:00Z'
            $anon.expires | Should -Be '2026-10-01T00:00:00Z'
            $anon.driveId | Should -Be 'drive-1'

            $people = $result.items | Where-Object { $_.linkId -eq 'perm-people' }
            $people.linkType | Should -Be 'people'
        }

        It 'honors the anonymous-only filter' {
            $result = Get-SharingReport -TenantId 'tenant-test' -Sites $script:sites -AnonymousOnly $true
            $result.totalCount | Should -Be 1
            $result.items.Count | Should -Be 1
            $result.items[0].linkType | Should -Be 'anonymous'
            $result.items[0].linkId | Should -Be 'perm-anon'
        }

        It 'filters by link type' {
            $organization = Get-SharingReport -TenantId 'tenant-test' -Sites $script:sites -LinkType 'organization'
            $organization.totalCount | Should -Be 2
            @($organization.items.linkId) | Should -Contain 'perm-org'
            @($organization.items.linkId) | Should -Contain 'perm-org-2'
        }

        It 'filters by permissions' {
            $edit = Get-SharingReport -TenantId 'tenant-test' -Sites $script:sites -Permissions 'edit'
            $edit.totalCount | Should -Be 2
            @($edit.items.permissions) | Should -Not -Contain 'view'
        }

        It 'filters by site' {
            $beta = Get-SharingReport -TenantId 'tenant-test' -Sites $script:sites -Site 'beta'
            $beta.totalCount | Should -Be 1
            $beta.items[0].siteName | Should -Be 'Comm Beta'
        }

        It 'filters by created date' {
            $recent = Get-SharingReport -TenantId 'tenant-test' -Sites $script:sites -CreatedAfter '2026-08-15T00:00:00Z'
            $recent.totalCount | Should -Be 1
            $recent.items[0].linkId | Should -Be 'perm-anon'
        }

        It 'paginates with the cursor' {
            $page1 = Get-SharingReport -TenantId 'tenant-test' -Sites $script:sites -Top 2
            $page1.totalCount | Should -Be 4
            $page1.items.Count | Should -Be 2
            $page1.nextCursor | Should -Not -BeNullOrEmpty

            $page2 = Get-SharingReport -TenantId 'tenant-test' -Sites $script:sites -Top 2 -Cursor $page1.nextCursor
            $page2.items.Count | Should -Be 2
            $page2.nextCursor | Should -BeNullOrEmpty
        }
    }

    Context 'the entrypoint in direct mode' {
        It 'runs the handler and emits the page as JSON' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Uri -like '/v1.0/sites/getAllSites*') {
                    return @{ value = @(
                            @{
                                id = 'site-1'; displayName = 'Team Alpha'; webUrl = 'https://contoso.sharepoint.com/sites/alpha'
                                createdDateTime = '2026-01-10T00:00:00Z'; lastModifiedDateTime = '2026-09-01T00:00:00Z'
                                isPersonalSite = $false; sharingCapability = 'externalUserSharingOnly'; sensitivityLabel = 'General'
                            }
                        ) }
                }
                if ($Uri -like '*/sites/site-1/drive*') {
                    return @{ id = 'drive-1'; quota = @{ used = 5368709120; total = 10737418240 }; owner = @{ user = @{ displayName = 'Owner One'; email = 'owner1@example.invalid' } } }
                }
                if ($Uri -like '*/sites/site-1/team*') { return @{ id = 'team-1' } }
                if ($Uri -like '*/drives/drive-1/root*') {
                    return @{ id = 'root'; name = 'root'; webUrl = 'https://contoso.sharepoint.com/sites/alpha'; folder = @{ childCount = 0 } }
                }
                if ($Uri -like '*/drives/drive-1/items/root/children*') { return @{ value = @() } }
                if ($Uri -like '*/drives/drive-1/items/root/permissions*') {
                    return @{ value = @(
                            @{ id = 'perm-anon'; link = @{ scope = 'anonymous'; type = 'view' }; createdBy = @{ user = @{ userPrincipalName = 'owner1@example.invalid' } }; createdDateTime = '2026-09-01T00:00:00Z'; expirationDateTime = '2026-10-01T00:00:00Z' }
                            @{ id = 'perm-org'; link = @{ scope = 'organization'; type = 'edit' }; createdBy = @{ user = @{ userPrincipalName = 'owner1@example.invalid' } }; createdDateTime = '2026-08-01T00:00:00Z' }
                        ) }
                }
                return @{ value = @() }
            }

            $output = & $script:entrypoint -TenantId 'tenant-test' -AnonymousOnly
            $page = $output | ConvertFrom-Json
            $page.tenantId | Should -Be 'tenant-test'
            $page.totalCount | Should -Be 1
            $page.items[0].linkType | Should -Be 'anonymous'
            $page.items[0].siteName | Should -Be 'Team Alpha'
        }
    }
}
