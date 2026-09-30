# Get-TeamsActivity.Tests.ps1 — Unit tests for Get-TeamsActivity (T-0507).

BeforeAll {
    $script:workerPath = Join-Path -Path $PSScriptRoot -ChildPath '../../../portal/workers/M365Portal.Workers/Get-TeamsActivity.ps1'
    $script:entrypoint = Join-Path -Path $PSScriptRoot -ChildPath '../../../portal/workers/get-teams-activity.ps1'
    . $script:workerPath
}

Describe 'Get-TeamsActivity worker (T-0507)' {
    Context 'Worker and entrypoint files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:workerPath | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            Get-Command Read-TeamsActivityJob -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
            Get-Command Get-GraphTeamsUsageReport -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
            Get-Command Get-TeamsAdminActivityReport -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
            Get-Command ConvertTo-TeamsActivityReport -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
            Get-Command Get-TeamsActivityReport -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
        }
    }

    Context 'Read-TeamsActivityJob' {
        It 'reads envelope and applies defaults' {
            $temp = New-TemporaryFile
            try {
                '{"tenantId":"tenant-abc"}' | Set-Content -LiteralPath $temp.FullName
                $job = Read-TeamsActivityJob -Path $temp.FullName
                $job['TenantId'] | Should -Be 'tenant-abc'
                $job['Period'] | Should -Be 'D7'
                $job['StartDate'] | Should -Be ([datetime]::MinValue)
                $job['EndDate'] | Should -Be ([datetime]::MinValue)
            }
            finally {
                Remove-Item -LiteralPath $temp.FullName -Force -ErrorAction SilentlyContinue
            }
        }

        It 'reads custom period and date window' {
            $temp = New-TemporaryFile
            try {
                '{"tenantId":"tenant-abc","period":"D30","startDate":"2026-09-01","endDate":"2026-09-30"}' | Set-Content -LiteralPath $temp.FullName
                $job = Read-TeamsActivityJob -Path $temp.FullName
                $job['Period'] | Should -Be 'D30'
                $job['StartDate'] | Should -Be ([datetime]'2026-09-01')
                $job['EndDate'] | Should -Be ([datetime]'2026-09-30')
            }
            finally {
                Remove-Item -LiteralPath $temp.FullName -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects an envelope without tenantId' {
            $temp = New-TemporaryFile
            try {
                '{"period":"D7"}' | Set-Content -LiteralPath $temp.FullName
                { Read-TeamsActivityJob -Path $temp.FullName } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $temp.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'ConvertTo-TeamsActivityReport mapping' {
        It 'maps Graph report rows to normalized per-team and per-user usage' {
            $teamRows = @(
                [pscustomobject]@{
                    'Team Name'             = 'Engineering'
                    'Active Users'          = '12'
                    'Team Chat Message Count' = '300'
                    'Private Chat Message Count' = '40'
                    'Meeting Count'         = '18'
                    'Call Count'            = '9'
                    'Report Refresh Date'   = '2026-09-25'
                }
            )
            $userRows = @(
                [pscustomobject]@{
                    'Display Name'          = 'Alice Admin'
                    'User Principal Name'   = 'alice@example.invalid'
                    'Last Activity Date'    = '2026-09-25'
                    'Team Chat Message Count' = '100'
                    'Private Chat Message Count' = '20'
                    'Meeting Count'         = '6'
                    'Call Count'            = '2'
                }
            )

            $report = ConvertTo-TeamsActivityReport -TenantId 'tenant-test' -Period 'D7' -TeamRows $teamRows -UserRows $userRows -TeamSource 'graph' -UserSource 'graph'

            $report.tenantId | Should -Be 'tenant-test'
            $report.period | Should -Be 'D7'
            $report.teams.Count | Should -Be 1
            $report.teams[0].displayName | Should -Be 'Engineering'
            $report.teams[0].activeUsers | Should -Be 12
            $report.teams[0].messages | Should -Be 340
            $report.teams[0].meetings | Should -Be 18
            $report.teams[0].calls | Should -Be 9
            $report.teams[0].source | Should -Be 'graph'

            $report.users.Count | Should -Be 1
            $report.users[0].displayName | Should -Be 'Alice Admin'
            $report.users[0].userPrincipalName | Should -Be 'alice@example.invalid'
            $report.users[0].active | Should -BeTrue
            $report.users[0].messages | Should -Be 120
            $report.users[0].meetings | Should -Be 6
            $report.users[0].source | Should -Be 'graph'

            $report.sources.teams | Should -Be 'graph'
            $report.sources.users | Should -Be 'graph'
        }

        It 'marks a user inactive when the period has no activity' {
            $userRows = @(
                [pscustomobject]@{
                    'User Principal Name' = 'bob@example.invalid'
                    'Last Activity Date'  = '2026-09-25'
                }
            )

            $report = ConvertTo-TeamsActivityReport -TenantId 'tenant-test' -UserRows $userRows

            $report.users[0].active | Should -BeFalse
            $report.users[0].messages | Should -Be 0
        }

        It 'applies the date window to rows carrying an activity date' {
            $userRows = @(
                [pscustomobject]@{
                    'User Principal Name' = 'alice@example.invalid'
                    'Last Activity Date'  = '2026-09-10'
                    'Meeting Count'       = '4'
                },
                [pscustomobject]@{
                    'User Principal Name' = 'bob@example.invalid'
                    'Last Activity Date'  = '2026-09-20'
                    'Meeting Count'       = '6'
                }
            )

            $report = ConvertTo-TeamsActivityReport -TenantId 'tenant-test' -UserRows $userRows -StartDate ([datetime]'2026-09-15') -EndDate ([datetime]'2026-09-30')

            $report.users.Count | Should -Be 1
            $report.users[0].userPrincipalName | Should -Be 'bob@example.invalid'
        }
    }

    Context 'Get-TeamsActivityReport fallback' {
        It 'uses the Graph usage report when it carries metrics' {
            $import = {
                param([string]$Uri)
                if ($Uri -like '/v1.0/*') {
                    return @(
                        [pscustomobject]@{ 'Team Name' = 'Engineering'; 'Active Users' = '12'; 'Meeting Count' = '18' }
                    )
                }
                throw "unexpected fallback call"
            }

            $report = Get-TeamsActivityReport -TenantId 'tenant-test' -Period 'D7' -Import $import

            $report.sources.teams | Should -Be 'graph'
            $report.sources.users | Should -Be 'graph'
            $report.teams[0].displayName | Should -Be 'Engineering'
        }

        It 'falls back to the Teams admin report when Graph is unavailable' {
            $import = {
                param([string]$Uri)
                if ($Uri -like '/v1.0/*') {
                    throw 'Graph usage report unavailable (403)'
                }
                if ($Uri -like '/beta/*') {
                    return @(
                        [pscustomobject]@{ 'Team Name' = 'Engineering'; 'Active Users' = '10'; 'Meeting Count' = '15' }
                    )
                }
                throw "unexpected uri $Uri"
            }

            $report = Get-TeamsActivityReport -TenantId 'tenant-test' -Period 'D7' -Import $import

            $report.sources.teams | Should -Be 'teams-admin'
            $report.sources.users | Should -Be 'teams-admin'
            $report.teams[0].displayName | Should -Be 'Engineering'
            $report.teams[0].activeUsers | Should -Be 10
            $report.teams[0].source | Should -Be 'teams-admin'
        }

        It 'falls back per section when Graph lacks that section''s metrics' {
            $import = {
                param([string]$Uri)
                if ($Uri -like '/v1.0/*getTeamsTeamActivityCounts*') {
                    return @()
                }
                if ($Uri -like '/v1.0/*getTeamsUserActivityUserDetail*') {
                    return @(
                        [pscustomobject]@{ 'User Principal Name' = 'alice@example.invalid'; 'Meeting Count' = '6' }
                    )
                }
                if ($Uri -like '/beta/*getTeamsTeamActivityCounts*') {
                    return @(
                        [pscustomobject]@{ 'Team Name' = 'Engineering'; 'Active Users' = '10'; 'Meeting Count' = '15' }
                    )
                }
                throw "unexpected uri $Uri"
            }

            $report = Get-TeamsActivityReport -TenantId 'tenant-test' -Period 'D7' -Import $import

            $report.sources.teams | Should -Be 'teams-admin'
            $report.sources.users | Should -Be 'graph'
            $report.teams[0].displayName | Should -Be 'Engineering'
            $report.users[0].userPrincipalName | Should -Be 'alice@example.invalid'
        }
    }
}
