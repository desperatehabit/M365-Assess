BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-SecureScore.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-secure-score.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Get-SecureScore worker (T-0602)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-SecureScore -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SecureScoreJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH/PUT' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match 'Invoke-Expression'
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Not -Match '-Method POST'
            $entrySource | Should -Not -Match '-Method DELETE'
            $entrySource | Should -Not -Match '-Method PATCH'
        }

        It 'reads Secure Score and control profiles from Graph' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'security/secureScores'
            $source | Should -Match 'security/secureScoreControlProfiles'
        }
    }

    Context 'Get-SecureScore reporting' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Uri -like '*secureScoreControlProfiles*') {
                    return @{
                        value = @(
                            @{ id = 'MFARegistrationV2'; title = 'Ensure multifactor authentication is enabled for all users'; controlCategory = 'Identity'; maxScore = 40; userImpact = 'High' }
                            @{ id = 'DataClassification'; title = 'Apply sensitivity labels'; controlCategory = 'Data'; maxScore = 60; userImpact = 'Medium' }
                        )
                    }
                }
                return @{
                    value = @(
                        @{
                            currentScore    = 42.5
                            maxScore        = 100
                            createdDateTime = '2026-01-02T00:00:00.000Z'
                            controlScores   = @(
                                @{ controlName = 'MFARegistrationV2'; controlCategory = 'Identity'; score = 20; maxScore = 40; userImpact = 'High'; implementationStatus = 'Implemented' }
                                @{ controlName = 'DataClassification'; controlCategory = 'Data'; score = 22.5; maxScore = 60; userImpact = 'Medium'; implementationStatus = 'NotImplemented' }
                            )
                        }
                    )
                }
            }
        }

        It 'returns current, max, percentage, and the category split' {
            $result = Get-SecureScore -TenantId 'tenant-test'
            $result.tenantId | Should -Be 'tenant-test'
            $result.current | Should -Be 42.5
            $result.max | Should -Be 100
            $result.percentage | Should -Be 42.5

            $identity = @($result.categories | Where-Object { $_.category -eq 'Identity' })[0]
            $identity | Should -Not -BeNullOrEmpty
            $identity.achieved | Should -Be 20
            $identity.available | Should -Be 40
            $identity.percentage | Should -Be 50

            $data = @($result.categories | Where-Object { $_.category -eq 'Data' })[0]
            $data.achieved | Should -Be 22.5
            $data.available | Should -Be 60
            $data.percentage | Should -Be 37.5
        }

        It 'returns improvement actions with points achieved/available and impact' {
            $result = Get-SecureScore -TenantId 'tenant-test'
            $result.actions.Count | Should -Be 2

            $action = @($result.actions | Where-Object { $_.id -eq 'MFARegistrationV2' })[0]
            $action | Should -Not -BeNullOrEmpty
            $action.title | Should -Be 'Ensure multifactor authentication is enabled for all users'
            $action.category | Should -Be 'Identity'
            $action.pointsAchieved | Should -Be 20
            $action.pointsAvailable | Should -Be 40
            $action.impact | Should -Be 'High'
            $action.implementationStatus | Should -Be 'Implemented'
        }

        It 'returns actions unmapped: no checkId or standardKey is fabricated' {
            $result = Get-SecureScore -TenantId 'tenant-test'
            foreach ($action in $result.actions) {
                $action.PSObject.Properties.Name | Should -Not -Contain 'checkId'
                $action.PSObject.Properties.Name | Should -Not -Contain 'standardKey'
            }
        }

        It 'reads the most recent snapshot regardless of Graph ordering' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Uri -like '*secureScoreControlProfiles*') {
                    return @{ value = @() }
                }
                return @{
                    value = @(
                        @{ currentScore = 10; maxScore = 100; createdDateTime = '2025-12-01T00:00:00.000Z'; controlScores = @() }
                        @{ currentScore = 80; maxScore = 100; createdDateTime = '2026-02-01T00:00:00.000Z'; controlScores = @() }
                    )
                }
            }

            $result = Get-SecureScore -TenantId 'tenant-test'
            $result.current | Should -Be 80
            $result.percentage | Should -Be 80
        }

        It 'falls back to AdditionalProperties for fields the SDK moves there' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Uri -like '*secureScoreControlProfiles*') {
                    return @{ value = @() }
                }
                return @{
                    value = @(
                        @{
                            currentScore    = 5
                            maxScore        = 10
                            createdDateTime = '2026-01-02T00:00:00.000Z'
                            controlScores   = @(
                                @{
                                    controlName          = 'LegacyControl'
                                    score                = 5
                                    AdditionalProperties = @{ controlCategory = 'Apps'; maxScore = 10; userImpact = 'Low' }
                                }
                            )
                        }
                    )
                }
            }

            $result = Get-SecureScore -TenantId 'tenant-test'
            $action = $result.actions[0]
            $action.category | Should -Be 'Apps'
            $action.pointsAvailable | Should -Be 10
            $action.impact | Should -Be 'Low'
        }

        It 'handles an empty Secure Score without querying profiles' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Uri -like '*secureScoreControlProfiles*') {
                    throw 'profiles must not be queried when there is no score'
                }
                return @{ value = @() }
            }

            $result = Get-SecureScore -TenantId 'tenant-test'
            $result.current | Should -Be 0
            $result.max | Should -Be 0
            $result.percentage | Should -Be 0
            $result.categories.Count | Should -Be 0
            $result.actions.Count | Should -Be 0
        }
    }

    Context 'Read-SecureScoreJob' {
        It 'parses tenantId from a job envelope' {
            $jobPath = Join-Path $TestDrive 'secure-score-job.json'
            @{ tenantId = 'tenant-test' } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            $job = Read-SecureScoreJob -Path $jobPath
            $job['TenantId'] | Should -Be 'tenant-test'
        }

        It 'throws when tenantId is missing' {
            $jobPath = Join-Path $TestDrive 'secure-score-job-bad.json'
            @{ foo = 'bar' } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            { Read-SecureScoreJob -Path $jobPath } | Should -Throw
        }

        It 'throws when the job envelope is absent' {
            { Read-SecureScoreJob -Path (Join-Path $TestDrive 'missing.json') } | Should -Throw
        }
    }
}
