# Get-OneDriveUsage.Tests.ps1 — Unit tests for Get-OneDriveUsage (T-0489).

BeforeAll {
    $script:workerPath = Join-Path -Path $PSScriptRoot -ChildPath '../../../portal/workers/M365Portal.Workers/Get-OneDriveUsage.ps1'
    $script:entrypoint = Join-Path -Path $PSScriptRoot -ChildPath '../../../portal/workers/get-onedrive-usage.ps1'

    function global:Invoke-MgGraphRequest {
        [CmdletBinding()]
        param($Method, $Uri, $Body, $Headers, $OutputType)
    }

    . $script:workerPath
}

Describe 'Get-OneDriveUsage worker (T-0489)' {
    Context 'Worker and entrypoint files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:workerPath | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            Get-Command Read-OneDriveUsageJob -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
            Get-Command Calculate-OneDriveUsage -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
            Get-Command Get-OneDriveUsage -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
        }
    }

    Context 'Read-OneDriveUsageJob' {
        It 'reads the tenant id from the envelope' {
            $temp = New-TemporaryFile
            try {
                '{"tenantId":"tenant-abc"}' | Set-Content -LiteralPath $temp.FullName
                $job = Read-OneDriveUsageJob -Path $temp.FullName
                $job['TenantId'] | Should -Be 'tenant-abc'
            }
            finally {
                Remove-Item -LiteralPath $temp.FullName -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects an envelope without a tenant id' {
            $temp = New-TemporaryFile
            try {
                '{"foo":"bar"}' | Set-Content -LiteralPath $temp.FullName
                { Read-OneDriveUsageJob -Path $temp.FullName } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $temp.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'Calculate-OneDriveUsage calculations' {
        It 'computes per-user usage, sharing state, and summary totals' {
            $refDate = [datetime]'2026-09-26T12:00:00Z'
            $users = @(
                [pscustomobject]@{
                    id                = 'user-1'
                    displayName       = 'Active User'
                    userPrincipalName = 'active@example.invalid'
                    driveId           = 'drive-1'
                    storageUsedBytes  = 5368709120
                    storageQuotaBytes = 1099511627776
                    lastActivityDate  = '2026-09-20T00:00:00Z'
                    sharingLinks      = @(
                        [pscustomobject]@{ linkId = 'perm-1a'; linkType = 'anonymous'; resourceName = 'root'; driveId = 'drive-1'; itemId = 'root' },
                        [pscustomobject]@{ linkId = 'perm-1b'; linkType = 'organization'; resourceName = 'root'; driveId = 'drive-1'; itemId = 'root' }
                    )
                },
                [pscustomobject]@{
                    id                = 'user-2'
                    displayName       = 'Over Quota User'
                    userPrincipalName = 'quota@example.invalid'
                    driveId           = 'drive-2'
                    storageUsedBytes  = 989560464998
                    storageQuotaBytes = 1099511627776
                    lastActivityDate  = '2026-08-01T00:00:00Z'
                    sharingLinks      = @(
                        [pscustomobject]@{ linkId = 'perm-2a'; linkType = 'anonymous'; resourceName = 'root'; driveId = 'drive-2'; itemId = 'root' }
                    )
                },
                [pscustomobject]@{
                    id                = 'user-3'
                    displayName       = 'No OneDrive User'
                    userPrincipalName = 'nodrive@example.invalid'
                    driveId           = $null
                    storageUsedBytes  = $null
                    storageQuotaBytes = $null
                    lastActivityDate  = $null
                    sharingLinks      = @()
                }
            )

            $report = Calculate-OneDriveUsage -TenantId 'tenant-test' -Users $users -ReferenceDate $refDate

            $report.tenantId | Should -Be 'tenant-test'
            $report.generatedAt | Should -Be $refDate.ToString('o')
            $report.summary.totalUsers | Should -Be 3
            $report.summary.usersWithOneDrive | Should -Be 2
            $report.summary.totalStorageUsedBytes | Should -Be (5368709120L + 989560464998L)
            $report.summary.totalStorageQuotaBytes | Should -Be (1099511627776L + 1099511627776L)
            $report.summary.usersOverQuotaWarning | Should -Be 1
            $report.summary.totalSharingLinks | Should -Be 3
            $report.summary.anonymousLinks | Should -Be 2
            $report.summary.organizationLinks | Should -Be 1
            $report.summary.userLinks | Should -Be 0

            $report.users.Count | Should -Be 3

            $row1 = $report.users[0]
            $row1.userId | Should -Be 'user-1'
            $row1.hasOneDrive | Should -BeTrue
            $row1.storageUsedBytes | Should -Be 5368709120L
            $row1.storageUsedPercent | Should -BeGreaterThan 0
            $row1.storageUsedPercent | Should -BeLessThan 90
            ([datetime]$row1.lastActivityDate).ToUniversalTime().ToString('o') | Should -Be '2026-09-20T00:00:00.0000000Z'
            $row1.sharing.total | Should -Be 2
            $row1.sharing.anonymous | Should -Be 1
            $row1.sharing.organization | Should -Be 1
            $row1.sharingLinks.Count | Should -Be 2
            $row1.sharingLinks[0].linkId | Should -Be 'perm-1a'
            $row1.sharingLinks[0].linkType | Should -Be 'anonymous'

            $row2 = $report.users[1]
            $row2.storageUsedPercent | Should -BeGreaterOrEqual 90
            $row2.sharing.total | Should -Be 1

            $row3 = $report.users[2]
            $row3.hasOneDrive | Should -BeFalse
            $row3.storageUsedBytes | Should -BeNullOrEmpty
            $row3.storageUsedPercent | Should -BeNullOrEmpty
            $row3.sharing.total | Should -Be 0
            $row3.sharingLinks.Count | Should -Be 0
        }

        It 'handles an empty user list' {
            $report = Calculate-OneDriveUsage -TenantId 'tenant-empty' -Users @()
            $report.summary.totalUsers | Should -Be 0
            $report.summary.usersWithOneDrive | Should -Be 0
            $report.summary.totalSharingLinks | Should -Be 0
            $report.users.Count | Should -Be 0
        }
    }

    Context 'Get-OneDriveUsage live Graph mapping' {
        It 'follows @odata.nextLink so users beyond the first page are included' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body, $Headers, $OutputType)
                if ($Uri -match '/v1\.0/users\?') {
                    if ($Uri -match 'skiptoken=page2') {
                        return @{
                            value = @([pscustomobject]@{
                                    id                = 'user-2'
                                    displayName       = 'User Two'
                                    userPrincipalName = 'two@example.invalid'
                                })
                        }
                    }
                    return @{
                        value             = @([pscustomobject]@{
                                id                = 'user-1'
                                displayName       = 'User One'
                                userPrincipalName = 'one@example.invalid'
                            })
                        '@odata.nextLink' = 'https://graph.microsoft.com/v1.0/users?$skiptoken=page2'
                    }
                }
                if ($Uri -like '*/drive') {
                    return @{
                        id                   = 'drive-1'
                        quota                = @{ used = 100; total = 1000 }
                        lastModifiedDateTime = '2026-09-01T00:00:00Z'
                    }
                }
                return @{ value = @() }
            }

            $report = Get-OneDriveUsage -TenantId 'tenant-test'

            $report.summary.totalUsers | Should -Be 2
            @($report.users.userId) | Should -Contain 'user-1'
            @($report.users.userId) | Should -Contain 'user-2'
            Should -Invoke Invoke-MgGraphRequest -Times 2 -Exactly -ParameterFilter {
                $Uri -match '/v1\.0/users\?'
            }
        }
    }
}
