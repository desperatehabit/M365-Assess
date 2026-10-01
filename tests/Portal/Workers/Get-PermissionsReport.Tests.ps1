BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-PermissionsReport.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-permissions-report.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Get-PermissionsReport worker (T-0523)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-PermissionsReport -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-PermissionsReportJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-PermissionReportRow -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-PermissionReportFilter -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/PATCH/PUT/DELETE' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'entrypoint connects Graph in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-PermissionsReport\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service Graph'
            $entrySource | Should -Match 'Read-PermissionsReportJob -Path'
            $entrySource | Should -Match 'Get-PermissionsReport -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'Get-PermissionsReport live mapping and filters' {
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
                                isPersonalSite = $false
                                sharingCapability = 'externalUserSharingOnly'
                                sensitivityLabel = 'General'
                                lastModifiedDateTime = '2026-09-01T00:00:00Z'
                            }
                            @{
                                id = 'site-2'
                                displayName = 'Comm Beta'
                                webUrl = 'https://contoso.sharepoint.com/sites/beta'
                                isPersonalSite = $false
                                sharingCapability = 'disabled'
                                sensitivityLabel = $null
                                lastModifiedDateTime = '2026-08-01T00:00:00Z'
                            }
                            @{
                                id = 'site-3'
                                displayName = 'Personal Delta'
                                webUrl = 'https://contoso.sharepoint.com/personal/delta'
                                isPersonalSite = $true
                                sharingCapability = 'disabled'
                                sensitivityLabel = $null
                                lastModifiedDateTime = '2026-07-01T00:00:00Z'
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
                    if ($Uri -match '/v1\.0/sites/([^/]+)/team' -and $Matches[1] -eq 'site-2') {
                        throw '404 Not Found'
                    }
                    return @{ id = 'team-1' }
                }
                if ($Uri -like '/v1.0/sites/site-1/permissions*') {
                    return @{
                        value = @(
                            @{
                                id = 'perm-1'
                                roles = @('owner')
                                grantedToV2 = @{ user = @{ id = 'user-1'; displayName = 'Owner One'; userPrincipalName = 'owner1@example.invalid' } }
                                inheritedFrom = $null
                                link = $null
                            }
                            @{
                                id = 'perm-2'
                                roles = @('read')
                                grantedToV2 = @{ group = @{ id = 'group-1'; displayName = 'Engineering' } }
                                inheritedFrom = @{ id = 'parent' }
                                link = $null
                            }
                            @{
                                id = 'perm-3'
                                roles = @('write')
                                grantedToV2 = @{ application = @{ id = 'app-1'; displayName = 'Reporting App' } }
                                inheritedFrom = $null
                                link = @{ scope = 'organization' }
                            }
                        )
                    }
                }
                if ($Uri -like '/v1.0/sites/site-2/permissions*') {
                    return @{
                        value = @(
                            @{
                                id = 'perm-4'
                                roles = @('owner')
                                grantedToIdentitiesV2 = @(@{ user = @{ id = 'user-2'; displayName = 'Owner Two' } })
                                inheritedFrom = $null
                                link = @{ scope = 'anonymous' }
                            }
                        )
                    }
                }
                return @{}
            }
        }

        It 'returns the §3.2 columns and excludes personal sites' {
            $result = Get-PermissionsReport -TenantId 'tenant-test'

            $result.tenantId | Should -Be 'tenant-test'
            $result.totalCount | Should -Be 4
            $result.items.Count | Should -Be 4
            $result.nextCursor | Should -BeNullOrEmpty
            $result.retrievedAt | Should -Not -BeNullOrEmpty

            $owner = $result.items | Where-Object { $_.principalId -eq 'user-1' }
            $owner.site | Should -Be 'Team Alpha'
            $owner.principal | Should -Be 'Owner One'
            $owner.principalType | Should -Be 'user'
            $owner.role | Should -Be 'owner'
            $owner.inherited | Should -BeFalse
            $owner.scope | Should -Be 'site'

            $group = $result.items | Where-Object { $_.principalId -eq 'group-1' }
            $group.principal | Should -Be 'Engineering'
            $group.principalType | Should -Be 'group'
            $group.role | Should -Be 'read'
            $group.inherited | Should -BeTrue

            $app = $result.items | Where-Object { $_.principalId -eq 'app-1' }
            $app.principalType | Should -Be 'servicePrincipal'
            $app.scope | Should -Be 'organization'

            $linkOwner = $result.items | Where-Object { $_.principalId -eq 'user-2' }
            $linkOwner.site | Should -Be 'Comm Beta'
            $linkOwner.scope | Should -Be 'anonymous'

            @($result.items).site | Should -Not -Contain 'Personal Delta'
        }

        It 'filters by role' {
            $owners = Get-PermissionsReport -TenantId 'tenant-test' -Role 'owner'
            $owners.totalCount | Should -Be 2
            @($owners.items).role | Should -Not -Contain 'read'

            $readers = Get-PermissionsReport -TenantId 'tenant-test' -Role 'read'
            $readers.totalCount | Should -Be 1
            $readers.items[0].principal | Should -Be 'Engineering'
        }

        It 'filters by principal type' {
            $groups = Get-PermissionsReport -TenantId 'tenant-test' -PrincipalType 'group'
            $groups.totalCount | Should -Be 1
            $groups.items[0].principal | Should -Be 'Engineering'

            $apps = Get-PermissionsReport -TenantId 'tenant-test' -PrincipalType 'servicePrincipal'
            $apps.totalCount | Should -Be 1
            $apps.items[0].principal | Should -Be 'Reporting App'

            $users = Get-PermissionsReport -TenantId 'tenant-test' -PrincipalType 'user'
            $users.totalCount | Should -Be 2
        }

        It 'combines the role and principal-type filters' {
            $result = Get-PermissionsReport -TenantId 'tenant-test' -Role 'owner' -PrincipalType 'user'
            $result.totalCount | Should -Be 2

            $none = Get-PermissionsReport -TenantId 'tenant-test' -Role 'read' -PrincipalType 'group'
            $none.totalCount | Should -Be 1

            $empty = Get-PermissionsReport -TenantId 'tenant-test' -Role 'owner' -PrincipalType 'servicePrincipal'
            $empty.totalCount | Should -Be 0
            $empty.items.Count | Should -Be 0
        }

        It 'paginates with the cursor' {
            $page1 = Get-PermissionsReport -TenantId 'tenant-test' -Top 2
            $page1.totalCount | Should -Be 4
            $page1.items.Count | Should -Be 2
            $page1.nextCursor | Should -Not -BeNullOrEmpty

            $page2 = Get-PermissionsReport -TenantId 'tenant-test' -Top 2 -Cursor $page1.nextCursor
            $page2.items.Count | Should -Be 2
            $page2.nextCursor | Should -BeNullOrEmpty
        }

        It 'restarts at the first page for a blank or invalid cursor' {
            (Get-PermissionsReport -TenantId 'tenant-test' -Top 1 -Cursor '').items.Count | Should -Be 1
            (Get-PermissionsReport -TenantId 'tenant-test' -Top 1 -Cursor 'not-a-cursor').items.Count | Should -Be 1
        }

        It 'requires the tenant identifier' {
            { Get-PermissionsReport -TenantId '' } | Should -Throw
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id and payload fields' {
            $jobPath = Join-Path $TestDrive 'permissions-report-job.json'
            @{
                jobId         = 'job-1'
                tenantId      = 'tenant-a'
                role          = 'owner'
                principalType = 'group'
                top           = 25
                cursor        = 'b2Zmc2V0OjI1'
                credential    = @{ credentialRef = 'tenants/tenant-a/credential'; record = @{} }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-PermissionsReportJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Role'] | Should -Be 'owner'
            $job['PrincipalType'] | Should -Be 'group'
            $job['Top'] | Should -Be 25
            $job['Cursor'] | Should -Be 'b2Zmc2V0OjI1'
        }

        It 'rejects envelopes without a tenant id and missing files' {
            $jobPath = Join-Path $TestDrive 'permissions-report-job-empty.json'
            @{ jobId = 'job-1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-PermissionsReportJob -Path $jobPath } | Should -Throw '*tenantId*'
            { Read-PermissionsReportJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }

    Context 'the entrypoint in direct mode' {
        It 'runs the handler and emits the filtered page as JSON' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Uri -like '/v1.0/sites/getAllSites*') {
                    return @{
                        value = @(
                            @{
                                id = 'site-1'
                                displayName = 'Team Alpha'
                                webUrl = 'https://contoso.sharepoint.com/sites/alpha'
                                isPersonalSite = $false
                                sharingCapability = 'externalUserSharingOnly'
                                sensitivityLabel = 'General'
                                lastModifiedDateTime = '2026-09-01T00:00:00Z'
                            }
                        )
                    }
                }
                if ($Uri -like '/v1.0/sites/*/drive*') {
                    return @{ quota = @{ used = 1; total = 2 }; owner = @{ user = @{ displayName = 'Owner One' } } }
                }
                if ($Uri -like '/v1.0/sites/*/team*') {
                    return @{ id = 'team-1' }
                }
                if ($Uri -like '/v1.0/sites/site-1/permissions*') {
                    return @{
                        value = @(
                            @{
                                id = 'perm-1'
                                roles = @('owner')
                                grantedToV2 = @{ user = @{ id = 'user-1'; displayName = 'Owner One' } }
                                inheritedFrom = $null
                                link = $null
                            }
                            @{
                                id = 'perm-2'
                                roles = @('read')
                                grantedToV2 = @{ user = @{ id = 'user-2'; displayName = 'Reader Two' } }
                                inheritedFrom = $null
                                link = $null
                            }
                        )
                    }
                }
                return @{}
            }

            $output = & $script:entrypoint -TenantId 'tenant-test' -Role 'owner'
            $page = $output | ConvertFrom-Json
            $page.tenantId | Should -Be 'tenant-test'
            $page.totalCount | Should -Be 1
            $page.items[0].principal | Should -Be 'Owner One'
            $page.items[0].role | Should -Be 'owner'
        }
    }
}
