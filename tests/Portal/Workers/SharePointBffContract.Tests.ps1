BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:workersDir = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers'
    $script:entrypoints = Join-Path $script:repoRoot 'portal/workers'

    . (Join-Path $script:workersDir 'Connect-WorkerTenant.ps1')

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    function script:New-GraphMock {
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body)
            $key = "$Method $Uri"
            if ($key -like 'GET /v1.0/sites/getAllSites*') {
                return @{
                    value = @(
                        @{
                            id                   = 'site-1'
                            displayName          = 'Team Alpha'
                            webUrl               = 'https://contoso.sharepoint.com/sites/alpha'
                            isPersonalSite       = $false
                            sharingCapability    = 'externalUserSharingOnly'
                            sensitivityLabel     = 'General'
                            lastModifiedDateTime = '2026-09-01T00:00:00Z'
                        }
                    )
                }
            }
            if ($key -like 'GET /v1.0/sites/site-1/drive/items/item-1/versions*') {
                # Graph lists versions newest first: the first entry is the protected current version.
                return @{ value = @(@{ id = 'v2'; size = 2048; lastModifiedDateTime = ((Get-Date).ToUniversalTime().AddDays(-1).ToString('o')) }, @{ id = 'v1'; size = 1024; lastModifiedDateTime = '2020-01-01T00:00:00Z' }) }
            }
            if ($key -like 'GET /v1.0/sites/site-1/drive/items*') {
                return @{ value = @(@{ id = 'item-1' }) }
            }
            if ($key -like 'GET /v1.0/sites/site-1/drives*') {
                return @{ value = @(@{ id = 'drive-lib-1'; name = 'Documents'; webUrl = 'https://contoso.sharepoint.com/sites/alpha/Shared Documents'; driveType = 'documentLibrary'; quota = @{ used = 1024; total = 2048 } }) }
            }
            if ($key -like 'GET /v1.0/sites/site-1/drive*') {
                return @{ quota = @{ used = 5368709120; total = 10737418240 }; owner = @{ user = @{ userPrincipalName = 'owner1@example.invalid' } } }
            }
            if ($key -like 'GET /v1.0/drives/drive-lib-1/root/children*') {
                return @{ value = @(@{ id = 'child-1'; name = 'Plan.docx'; size = 2048; file = @{}; lastModifiedDateTime = '2026-08-01T00:00:00Z' }) }
            }
            if ($key -like 'GET /v1.0/sites/site-1/permissions*') {
                return @{ value = @() }
            }
            # '?' is a -like wildcard, so the users list branch must follow the per-user branches.
            if ($key -like 'GET https://graph.microsoft.com/v1.0/users/user-1/drive') {
                return @{ id = 'drive-1'; quota = @{ used = 1024; total = 2048 }; lastModifiedDateTime = '2026-09-01T00:00:00Z' }
            }
            if ($key -like 'GET https://graph.microsoft.com/v1.0/drives/drive-1/root/permissions') {
                return @{ value = @(@{ id = 'perm-1'; link = @{ scope = 'organization' } }) }
            }
            if ($key -like 'GET https://graph.microsoft.com/v1.0/users?*') {
                return @{ value = @(@{ id = 'user-1'; displayName = 'Owner One'; userPrincipalName = 'owner1@example.invalid' }) }
            }
            if ($key -like 'POST /v1.0/groups') {
                return @{ id = 'group-new' }
            }
            if ($key -like 'GET /v1.0/sites/site-1*') {
                return @{ id = 'site-1'; webUrl = 'https://contoso.sharepoint.com/sites/alpha' }
            }
            if ($key -like 'GET /v1.0/groups/site-live*') {
                return @{ id = 'site-live'; displayName = 'Project Alpha'; mail = 'project-alpha.example.invalid'; visibility = 'Public' }
            }
            if ($key -like 'GET /v1.0/directory/deletedItems/site-deleted') {
                return @{ id = 'site-deleted'; displayName = 'Retired Site'; mail = 'retired.example.invalid'; deletedDateTime = ((Get-Date).ToUniversalTime().AddDays(-10)) }
            }
            if ($key -like 'GET /v1.0/directory/deletedItems/microsoft.graph.group') {
                return @(@{ id = 'recycled-1'; displayName = 'Recycled One'; mail = 'one.example.invalid'; deletedDateTime = ((Get-Date).ToUniversalTime().AddDays(-5)) })
            }
            return $null
        }
    }

    function script:New-CredentialBlock {
        return @{
            credentialRef = 'tenants/t-a/credential'
            record        = @{
                tenantId    = 't-a'
                authMethod  = 'certificate-thumbprint'
                clientId    = 'app-1'
                secretRef   = 'thumbprint://ABC'
                thumbprint  = 'ABC'
                environment = 'commercial'
            }
        }
    }

    function script:New-JobFile {
        param([hashtable]$Envelope)
        $script:jobFolder = Join-Path $TestDrive 'sp-job'
        New-Item -Path $script:jobFolder -ItemType Directory -Force | Out-Null
        $script:jobFile = Join-Path $script:jobFolder 'job.json'
        $Envelope['tenantId'] = 't-a'
        $Envelope['credential'] = script:New-CredentialBlock
        $Envelope | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $script:jobFile -Encoding UTF8
    }

    function script:Run-Entrypoint {
        param([string]$Name)
        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }
        $output = & (Join-Path $script:entrypoints $Name) -JobFile $script:jobFile
        return ($output | ConvertFrom-Json)
    }
}

Describe 'SharePoint BFF worker contract (T-0855)' {

    Context 'the job envelopes the TypeScript adapter writes' {

        It 'get-sharepoint-sites.ps1 reads the flat filter fields and answers the §3.1 page' {
            script:New-GraphMock
            script:New-JobFile @{
                Type           = 'team'
                Sharing        = 'externalUserSharingOnly'
                StoragePercent = '25'
                LastActivity   = '2026-07-01T00:00:00Z'
                Sensitivity    = 'General'
                Top            = 50
                Cursor         = 'cursor-1'
            }

            $result = script:Run-Entrypoint 'get-sharepoint-sites.ps1'

            $result.tenantId | Should -Be 't-a'
            $result.totalCount | Should -Be 1
            $result.items[0].id | Should -Be 'site-1'
            $result.items[0].type | Should -Be 'team'
            $result.items[0].storageUsedPercent | Should -BeGreaterThan 0
            $result.items[0].sensitivity | Should -Be 'General'
            $result.items[0].sharing | Should -Be 'externalUserSharingOnly'
            Assert-MockCalled Connect-WorkerTenant -ParameterFilter { $JobFile -eq $script:jobFile }
        }

        It 'get-site-browser.ps1 reads SiteId and answers the browser with hand-off paths' {
            script:New-GraphMock
            script:New-JobFile @{ SiteId = 'site-1' }

            $result = script:Run-Entrypoint 'get-site-browser.ps1'

            $result.siteId | Should -Be 'site-1'
            $result.siteUrl | Should -Be 'https://contoso.sharepoint.com/sites/alpha'
            $result.adminCenterUrl | Should -Not -BeNullOrEmpty
            $result.handoff.permissionEdits | Should -BeFalse
            $result.handoff.sharingPermissionsPath | Should -Be '/v1/tenants/t-a/sharing/permissions'
            $result.handoff.externalUsersPath | Should -Be '/v1/tenants/t-a/sharing/external-users'
            $result.handoff.sharingLinksRemovePath | Should -Be '/v1/tenants/t-a/sharing/links/remove'
        }

        It 'get-site-storage.ps1 reads SiteId and answers the storage composition' {
            script:New-GraphMock
            script:New-JobFile @{ SiteId = 'site-1' }

            $result = script:Run-Entrypoint 'get-site-storage.ps1'

            $result.siteId | Should -Be 'site-1'
            $result.documentsBytes | Should -Not -BeNullOrEmpty
            $result.reclaimableBytes | Should -Be ($result.versionsBytes + $result.recycleBinBytes)
            $result.totalBytes | Should -Be ($result.documentsBytes + $result.reclaimableBytes)
        }

        It 'get-onedrive-usage.ps1 answers the usage report' {
            script:New-GraphMock
            script:New-JobFile @{}

            $result = script:Run-Entrypoint 'get-onedrive-usage.ps1'

            $result.tenantId | Should -Be 't-a'
            $result.summary | Should -Not -BeNullOrEmpty
            $result.users | Should -Not -BeNullOrEmpty
            $result.users[0].hasOneDrive | Should -BeTrue
            $result.users[0].sharing.organization | Should -Be 1
        }

        It 'invoke-version-cleanup.ps1 reads the flat plan fields and answers the plan' {
            script:New-GraphMock
            script:New-JobFile @{
                SiteId           = 'site-1'
                AgeThresholdDays = 90
                Mode             = 'Plan'
                JobId            = 'job-1'
            }

            $result = script:Run-Entrypoint 'invoke-version-cleanup.ps1'

            $result.mode | Should -Be 'plan'
            $result.state | Should -Be 'planned'
            $result.jobId | Should -Be 'job-1'
            $result.ageThresholdDays | Should -Be 90
            $result.writes | Should -BeFalse
            $result.selectedCount | Should -Be 1
        }
    }

    Context 'the T-0007 envelopes the write adapter writes' {

        It 'new-sharepoint-site.ps1 reads payload.site and dryRun and answers the created row' {
            script:New-GraphMock
            script:New-JobFile @{
                schemaVersion = 'v1'
                payload       = @{
                    site = @{
                        name    = 'Team Alpha'
                        alias   = 'alpha'
                        type    = 'team'
                        owners  = @('owner1@example.invalid')
                        sharing = 'disabled'
                    }
                    dryRun = $false
                }
            }

            $result = script:Run-Entrypoint 'new-sharepoint-site.ps1'

            $result.status | Should -Be 'created'
            $result.id | Should -Not -BeNullOrEmpty
            $result.name | Should -Be 'Team Alpha'
            $result.error | Should -BeNullOrEmpty
            Assert-MockCalled Invoke-MgGraphRequest -ParameterFilter { $Method -eq 'POST' -and $Uri -like '/v1.0/groups' }
        }

        It 'new-sharepoint-site-bulk.ps1 reads payload.csv and answers one row per site' {
            script:New-GraphMock
            script:New-JobFile @{
                schemaVersion = 'v1'
                payload       = @{
                    csv    = "name,alias,type,owners,template,sharing`nTeam Alpha,alpha,team,owner1@example.invalid,,disabled"
                    dryRun = $false
                }
            }

            $result = script:Run-Entrypoint 'new-sharepoint-site-bulk.ps1'

            $result.total | Should -Be 1
            $result.created | Should -Be 1
            $result.failed | Should -Be 0
            $result.results[0].row | Should -Be 1
            $result.results[0].status | Should -Be 'created'
            $result.results[0].id | Should -Not -BeNullOrEmpty
        }

        It 'invoke-sharepoint-site-action.ps1 reads the delete action with confirmation and answers the applied result' {
            script:New-GraphMock
            script:New-JobFile @{
                schemaVersion   = 'v1'
                correlationId  = 'corr-1'
                action         = 'delete'
                actor          = ''
                payload        = @{
                    siteId  = 'site-live'
                    dryRun  = $false
                    confirm = $true
                }
            }

            $result = script:Run-Entrypoint 'invoke-sharepoint-site-action.ps1'

            $result.success | Should -BeTrue
            $result.state | Should -Be 'succeeded'
            $result.operation | Should -Be 'delete'
            $result.siteId | Should -Be 'site-live'
            $result.plan.before.state | Should -Be 'active'
            $result.plan.after.state | Should -Be 'softDeleted'
            $result.auditEvent.action | Should -Be 'sharepoint.site.delete'
            $result.auditEvent.result | Should -Be 'success'
            $result.auditEvent.actor | Should -Be ''
            Assert-MockCalled Invoke-MgGraphRequest -ParameterFilter { $Method -eq 'DELETE' -and $Uri -like '/v1.0/groups/site-live' }
        }

        It 'invoke-sharepoint-site-action.ps1 restores a soft-deleted site' {
            script:New-GraphMock
            script:New-JobFile @{
                schemaVersion  = 'v1'
                correlationId = 'corr-2'
                action        = 'restore'
                payload       = @{
                    siteId  = 'site-deleted'
                    dryRun  = $false
                    confirm = $false
                }
            }

            $result = script:Run-Entrypoint 'invoke-sharepoint-site-action.ps1'

            $result.success | Should -BeTrue
            $result.operation | Should -Be 'restore'
            $result.targetName | Should -Be 'Retired Site'
            $result.auditEvent.action | Should -Be 'sharepoint.site.restore'
            Assert-MockCalled Invoke-MgGraphRequest -ParameterFilter { $Method -eq 'POST' -and $Uri -like '/v1.0/directory/deletedItems/site-deleted/restore' }
        }

        It 'invoke-sharepoint-site-action.ps1 lists the recycle bin' {
            script:New-GraphMock
            script:New-JobFile @{
                schemaVersion  = 'v1'
                correlationId = 'corr-3'
                action        = 'recyclebin-list'
                payload       = @{
                    dryRun = $true
                }
            }

            $result = script:Run-Entrypoint 'invoke-sharepoint-site-action.ps1'

            $result.totalCount | Should -Be 1
            $result.items[0].id | Should -Be 'recycled-1'
            $result.items[0].displayName | Should -Be 'Recycled One'
            $result.items[0].daysUntilPurge | Should -Not -BeNullOrEmpty
        }

        It 'invoke-sharepoint-site-action.ps1 empties selected recycle-bin entries with confirmation' {
            script:New-GraphMock
            script:New-JobFile @{
                schemaVersion  = 'v1'
                correlationId = 'corr-4'
                action        = 'recyclebin-empty'
                payload       = @{
                    recycleBinIds = @('recycled-1')
                    dryRun       = $false
                    confirm      = $true
                }
            }

            $result = script:Run-Entrypoint 'invoke-sharepoint-site-action.ps1'

            $result.action | Should -Be 'empty'
            $result.mode | Should -Be 'apply'
            $result.summary.total | Should -Be 1
            $result.summary.succeeded | Should -Be 1
            $result.results[0].status | Should -Be 'emptied'
            $result.auditEvents[0].action | Should -Be 'sharepoint.recyclebin.empty'
            Assert-MockCalled Invoke-MgGraphRequest -ParameterFilter { $Method -eq 'DELETE' -and $Uri -like '/v1.0/directory/deletedItems/recycled-1' }
        }
    }
}
