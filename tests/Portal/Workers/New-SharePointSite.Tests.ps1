BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/New-SharePointSite.ps1'
    $script:bulkWorker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/New-SharePointSiteBulk.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/new-sharepoint-site.ps1'
    $script:bulkEntrypoint = Join-Path $script:repoRoot 'portal/workers/new-sharepoint-site-bulk.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
    . $script:bulkWorker

    function script:New-Plan {
        param(
            [string]$Name = 'Alpha Site',
            [string]$Alias = 'alpha-site',
            [string]$Type = 'team',
            [string]$Owners = 'owner@example.invalid',
            [string]$Template = '',
            [string]$Sharing = 'disabled'
        )
        return [pscustomobject]@{
            name     = $Name
            alias    = $Alias
            type     = $Type
            owners   = $Owners
            template = $Template
            sharing  = $Sharing
        }
    }

    function script:New-CreateMock {
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body)
            if ($Uri -like '/v1.0/groups') {
                return @{ id = 'group-1' }
            }
            if ($Uri -like '/v1.0/users/*') {
                return @{ id = 'user-1' }
            }
            if ($Uri -like '/v1.0/sites') {
                return @{ id = 'site-1' }
            }
            return @{}
        }
    }

    $script:validCsv = @'
name,alias,type,owners,template,sharing
Alpha Site,alpha-site,team,owner@example.invalid,,disabled
Beta Site,beta-site,communication,owner@example.invalid;second.owner@example.invalid,Template One,externalUserSharingOnly
'@
}

Describe 'New-SharePointSite worker (T-0484)' {

    Context 'the worker files' {
        It 'ships the single and bulk handlers plus both entrypoints' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:bulkWorker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            Test-Path -LiteralPath $script:bulkEntrypoint | Should -BeTrue
            (Get-Command New-SharePointSite -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command New-SharePointSiteBulk -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SharePointSiteCsv -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-SharePointSiteInput -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SharePointSiteCreateJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SharePointSiteBulkJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'writes with GET/POST/PATCH only and never evaluates strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method POST'
            $source | Should -Match 'Invoke-MgGraphRequest -Method PATCH'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match 'Invoke-Expression'
            $bulkSource = Get-Content -LiteralPath $script:bulkWorker -Raw
            $bulkSource | Should -Not -Match 'Invoke-Expression'
        }

        It 'entrypoints delegate to the handlers and emit JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'New-SharePointSite\.ps1'
            $entrySource | Should -Match 'Read-SharePointSiteCreateJob -Path'
            $entrySource | Should -Match 'New-SharePointSite -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
            $bulkEntrySource = Get-Content -LiteralPath $script:bulkEntrypoint -Raw
            $bulkEntrySource | Should -Match 'New-SharePointSiteBulk\.ps1'
            $bulkEntrySource | Should -Match 'Read-SharePointSiteBulkJob -Path'
            $bulkEntrySource | Should -Match 'Read-SharePointSiteCsv -CsvText'
            $bulkEntrySource | Should -Match 'New-SharePointSiteBulk -TenantId'
            $bulkEntrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'single validation' {
        It 'requires the tenant identifier' {
            { New-SharePointSite -TenantId '' -Site (script:New-Plan) } | Should -Throw
            { New-SharePointSiteBulk -TenantId '' -Sites @((script:New-Plan)) } | Should -Throw
        }

        It 'rejects a missing name, alias, type, and owners per row' {
            $site = [pscustomobject]@{ name = ''; alias = ''; type = ''; owners = ''; template = ''; sharing = 'disabled' }
            $result = New-SharePointSite -TenantId 'tenant-a' -Site $site

            $result.status | Should -Be 'failed'
            $result.id | Should -BeNullOrEmpty
            $result.error | Should -Match 'name is required'
            $result.error | Should -Match 'alias is required'
            $result.error | Should -Match 'type is required'
            $result.error | Should -Match 'owners is required'
        }

        It 'rejects an unknown type and sharing value' {
            $badType = New-SharePointSite -TenantId 'tenant-a' -Site (script:New-Plan -Type 'portal')
            $badType.status | Should -Be 'failed'
            $badType.error | Should -Match 'team or communication'

            $badSharing = New-SharePointSite -TenantId 'tenant-a' -Site (script:New-Plan -Sharing 'everyone')
            $badSharing.status | Should -Be 'failed'
            $badSharing.error | Should -Match 'sharing'
        }

        It 'rejects a bad alias slug and a malformed owner UPN' {
            $badAlias = New-SharePointSite -TenantId 'tenant-a' -Site (script:New-Plan -Alias 'not a slug!')
            $badAlias.status | Should -Be 'failed'
            $badAlias.error | Should -Match 'alias'

            $badOwner = New-SharePointSite -TenantId 'tenant-a' -Site (script:New-Plan -Owners 'not-a-upn')
            $badOwner.status | Should -Be 'failed'
            $badOwner.error | Should -Match 'not-a-upn'
        }
    }

    Context 'single create' {
        It 'plans without writing on DryRun' {
            script:New-CreateMock
            $result = New-SharePointSite -TenantId 'tenant-a' -Site (script:New-Plan) -DryRun

            $result.status | Should -Be 'planned'
            $result.after.name | Should -Be 'Alpha Site'
            $result.after.type | Should -Be 'team'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'creates a team site live and audits with before/after' {
            script:New-CreateMock
            $events = [System.Collections.Generic.List[object]]::new()
            $result = New-SharePointSite -TenantId 'tenant-a' -Site (script:New-Plan) -WriteAudit { param($e) $events.Add($e) }

            $result.status | Should -Be 'created'
            $result.id | Should -Be 'group-1'
            $result.after.owners | Should -Contain 'owner@example.invalid'
            $events.Count | Should -Be 1
            $events[0].action | Should -Be 'sharepoint.site.create'
            $events[0].result | Should -Be 'success'
            $events[0].before | Should -BeNullOrEmpty
            $events[0].after.id | Should -Be 'group-1'
        }

        It 'creates a communication site through the sites endpoint' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'POST' -and $Uri -eq '/v1.0/sites') {
                    return @{ id = 'site-9' }
                }
                return @{}
            }
            $result = New-SharePointSite -TenantId 'tenant-a' -Site (script:New-Plan -Type 'communication' -Sharing 'externalUserSharingOnly')

            $result.status | Should -Be 'created'
            $result.id | Should -Be 'site-9'
            $result.after.sharing | Should -Be 'externalUserSharingOnly'
            Should -Invoke Invoke-MgGraphRequest -ParameterFilter { $Method -eq 'POST' -and $Uri -eq '/v1.0/sites' } -Times 1 -Exactly
        }
    }

    Context 'bulk CSV schema' {
        It 'parses the fixed schema and ignores unknown columns' {
            $csv = $script:validCsv -replace 'sharing', 'sharing,notes'
            $csv = $csv -replace 'disabled', 'disabled,extra'
            $csv = $csv -replace 'externalUserSharingOnly', 'externalUserSharingOnly,extra'
            $sites = Read-SharePointSiteCsv -CsvText $csv

            $sites.Count | Should -Be 2
            $sites[0].name | Should -Be 'Alpha Site'
            $sites[0].row | Should -Be 1
            $sites[1].owners | Should -Match 'second.owner@example.invalid'
        }

        It 'rejects a file missing required columns before any write' {
            script:New-CreateMock
            $csv = @'
name,alias,type,owners,template
Alpha Site,alpha-site,team,owner@example.invalid,
'@
            { Read-SharePointSiteCsv -CsvText $csv } | Should -Throw '*missing required column*sharing*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'rejects an empty file and a file with no rows before any write' {
            script:New-CreateMock
            { Read-SharePointSiteCsv -CsvText '' } | Should -Throw '*empty*'
            { Read-SharePointSiteCsv -CsvText 'name,alias,type,owners,template,sharing' } | Should -Throw '*no site rows*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'returns one result per row with mixed outcomes and no silent partial success' {
            script:New-CreateMock
            $csv = @'
name,alias,type,owners,template,sharing
Alpha Site,alpha-site,team,owner@example.invalid,,disabled
Bad Site,bad-site,portal,owner@example.invalid,,disabled
'@
            $sites = Read-SharePointSiteCsv -CsvText $csv
            $results = @(New-SharePointSiteBulk -TenantId 'tenant-a' -Sites $sites)

            $results.Count | Should -Be 2
            $results[0].row | Should -Be 1
            $results[0].status | Should -Be 'created'
            $results[1].row | Should -Be 2
            $results[1].status | Should -Be 'failed'
            $results[1].error | Should -Match 'team or communication'
        }
    }
}
