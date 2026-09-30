# Get-SiteBrowser.Tests.ps1 — Unit tests for the EPIC-025 site browser (T-0488).

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-SiteBrowser.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-site-browser.ps1'
    $script:siteId = 'contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body, $Headers, $OutputType)
    }

    . $script:worker
}

Describe 'Get-SiteBrowser worker (T-0488)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-SiteBrowser -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SiteBrowserJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-SiteBrowserAdminCenterUrl -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-SiteBrowserLibrary -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-SiteBrowserPermissionRows -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH/PUT' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'entrypoint delegates to the handler and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-SiteBrowser\.ps1'
            $entrySource | Should -Match 'Read-SiteBrowserJob -Path'
            $entrySource | Should -Match 'Get-SiteBrowser -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'Read-SiteBrowserJob' {
        It 'reads tenant and site ids from the envelope' {
            $temp = New-TemporaryFile
            try {
                '{"tenantId":"tenant-abc","siteId":"site-xyz"}' | Set-Content -LiteralPath $temp.FullName
                $job = Read-SiteBrowserJob -Path $temp.FullName
                $job['TenantId'] | Should -Be 'tenant-abc'
                $job['SiteId'] | Should -Be 'site-xyz'
            }
            finally {
                Remove-Item -LiteralPath $temp.FullName -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects an envelope without a site id' {
            $temp = New-TemporaryFile
            try {
                '{"tenantId":"tenant-abc"}' | Set-Content -LiteralPath $temp.FullName
                { Read-SiteBrowserJob -Path $temp.FullName } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $temp.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'Get-SiteBrowserAdminCenterUrl' {
        It 'extracts the site collection guid from a composite Graph site id' {
            $url = Get-SiteBrowserAdminCenterUrl -SiteId $script:siteId
            $url | Should -Match '^https://admin\.microsoft\.com/sharepoint\?'
            $url | Should -Match 'siteId=11111111-1111-1111-1111-111111111111'
        }

        It 'falls back to the raw id when it is not composite' {
            $url = Get-SiteBrowserAdminCenterUrl -SiteId 'simple-site'
            $url | Should -Match 'siteId=simple-site'
        }
    }

    Context 'permission mapping' {
        It 'flags a guest identity and an anonymous link as external' {
            $guest = [pscustomobject]@{
                id              = 'perm-guest'
                roles           = @('read')
                grantedToV2     = @{ siteUser = @{ displayName = 'Guest User'; email = 'guest@example.invalid'; loginName = 'guest_example.invalid#ext#@contoso.onmicrosoft.com' } }
            }
            $rows = @(ConvertTo-SiteBrowserPermissionRows -Permission $guest)
            $rows.Count | Should -Be 1
            $rows[0].principalType | Should -Be 'siteUser'
            $rows[0].external | Should -BeTrue

            $link = [pscustomobject]@{
                id    = 'perm-link'
                roles = @('read')
                link  = @{ scope = 'anonymous' }
            }
            $linkRows = @(ConvertTo-SiteBrowserPermissionRows -Permission $link)
            $linkRows.Count | Should -Be 1
            $linkRows[0].principalType | Should -Be 'link'
            $linkRows[0].external | Should -BeTrue
        }

        It 'does not flag an internal member as external' {
            $internal = [pscustomobject]@{
                id                = 'perm-internal'
                roles             = @('write')
                grantedToIdentitiesV2 = @(
                    @{ siteUser = @{ displayName = 'Internal User'; email = 'internal@example.invalid'; loginName = 'internal@example.invalid'; userType = 'Member' } }
                )
            }
            $rows = @(ConvertTo-SiteBrowserPermissionRows -Permission $internal)
            $rows.Count | Should -Be 1
            $rows[0].external | Should -BeFalse
        }
    }

    Context 'Get-SiteBrowser live Graph mapping' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body, $Headers, $OutputType)
                if ($Uri -match '/sites/[^/]+/drives') {
                    return @{
                        value = @(
                            @{
                                id        = 'drive-documents'
                                name      = 'Documents'
                                webUrl    = 'https://contoso.sharepoint.com/sites/alpha/Shared%20Documents'
                                driveType = 'documentLibrary'
                                quota     = @{ used = 5368709120; total = 10737418240 }
                            }
                            @{
                                id        = 'drive-siteassets'
                                name      = 'Site Assets'
                                webUrl    = 'https://contoso.sharepoint.com/sites/alpha/SiteAssets'
                                driveType = 'documentLibrary'
                                quota     = @{ used = 1024; total = $null }
                            }
                        )
                    }
                }
                if ($Uri -match '/drives/drive-documents/root/children') {
                    return @{
                        value = @(
                            @{
                                id                   = 'item-1'
                                name                 = 'Report.docx'
                                webUrl               = 'https://contoso.sharepoint.com/sites/alpha/Shared%20Documents/Report.docx'
                                size                 = 204800
                                folder               = $null
                                file                 = @{ mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
                                lastModifiedDateTime = '2026-09-01T00:00:00Z'
                            }
                        )
                    }
                }
                if ($Uri -match '/drives/[^/]+/root/children') {
                    return @{ value = @() }
                }
                if ($Uri -match '/sites/[^/]+/permissions') {
                    return @{
                        value = @(
                            @{
                                id                = 'perm-internal'
                                roles             = @('write')
                                grantedToIdentitiesV2 = @(
                                    @{ siteUser = @{ displayName = 'Internal User'; email = 'internal@example.invalid'; loginName = 'internal@example.invalid'; userType = 'Member' } }
                                )
                            }
                            @{
                                id            = 'perm-guest'
                                roles         = @('read')
                                grantedToV2   = @{ siteUser = @{ displayName = 'External Guest'; email = 'guest@example.invalid'; loginName = 'guest_example.invalid#ext#@contoso.onmicrosoft.com' } }
                            }
                            @{
                                id    = 'perm-link'
                                roles = @('read')
                                link  = @{ scope = 'anonymous' }
                            }
                        )
                    }
                }
                if ($Uri -match '/sites/[^/]+') {
                    return @{
                        id          = $script:siteId
                        displayName = 'Team Alpha'
                        webUrl      = 'https://contoso.sharepoint.com/sites/alpha'
                    }
                }
                return @{}
            }
        }

        It 'lists libraries, items, permissions, and external users' {
            $result = Get-SiteBrowser -TenantId 'tenant-test' -SiteId $script:siteId

            $result.tenantId | Should -Be 'tenant-test'
            $result.siteId | Should -Be $script:siteId
            $result.siteUrl | Should -Be 'https://contoso.sharepoint.com/sites/alpha'
            $result.adminCenterUrl | Should -Match 'siteId=11111111-1111-1111-1111-111111111111'

            $result.libraries.Count | Should -Be 2
            $documents = $result.libraries | Where-Object { $_.id -eq 'drive-documents' }
            $documents.name | Should -Be 'Documents'
            $documents.driveType | Should -Be 'documentLibrary'
            $documents.quotaUsedBytes | Should -Be 5368709120
            $documents.quotaTotalBytes | Should -Be 10737418240

            $result.items.Count | Should -Be 1
            $result.items[0].name | Should -Be 'Report.docx'
            $result.items[0].libraryId | Should -Be 'drive-documents'
            $result.items[0].libraryName | Should -Be 'Documents'
            $result.items[0].isFolder | Should -BeFalse
            $result.items[0].sizeBytes | Should -Be 204800

            $result.permissions.Count | Should -Be 3
            $internal = $result.permissions | Where-Object { $_.id -eq 'perm-internal' }
            $internal.external | Should -BeFalse
            $internal.roles | Should -Contain 'write'

            $result.externalUsers.Count | Should -Be 2
            @($result.externalUsers.email) | Should -Contain 'guest@example.invalid'

            $result.handoff.permissionEdits | Should -BeFalse
            $result.handoff.sharingPermissionsPath | Should -Be '/v1/tenants/tenant-test/sharing/permissions'
            $result.handoff.externalUsersPath | Should -Be '/v1/tenants/tenant-test/sharing/external-users'
        }
    }

    Context 'the entrypoint in direct mode' {
        It 'runs the handler and emits the browser as JSON' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body, $Headers, $OutputType)
                if ($Uri -match '/sites/[^/]+/drives') {
                    return @{
                        value = @(
                            @{
                                id        = 'drive-documents'
                                name      = 'Documents'
                                webUrl    = 'https://contoso.sharepoint.com/sites/alpha/Shared%20Documents'
                                driveType = 'documentLibrary'
                                quota     = @{ used = 1024; total = 2048 }
                            }
                        )
                    }
                }
                if ($Uri -match '/drives/[^/]+/root/children') {
                    return @{ value = @() }
                }
                if ($Uri -match '/sites/[^/]+/permissions') {
                    return @{ value = @() }
                }
                if ($Uri -match '/sites/[^/]+') {
                    return @{ id = $script:siteId; displayName = 'Team Alpha'; webUrl = 'https://contoso.sharepoint.com/sites/alpha' }
                }
                return @{}
            }

            $output = & $script:entrypoint -TenantId 'tenant-test' -SiteId $script:siteId
            $browser = $output | ConvertFrom-Json
            $browser.tenantId | Should -Be 'tenant-test'
            $browser.libraries.Count | Should -Be 1
            $browser.libraries[0].name | Should -Be 'Documents'
            $browser.handoff.permissionEdits | Should -BeFalse
        }
    }
}
