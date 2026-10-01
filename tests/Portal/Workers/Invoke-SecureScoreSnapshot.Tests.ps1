# Invoke-SecureScoreSnapshot.Tests.ps1
# Pester tests for T-0604 — daily Secure Score snapshot job (EPIC-031 §4.2, §11.2).
# Asserts: the T-0602 read path is used, exactly one snapshot is recorded per
# tenant per UTC day, a second run in the same day is a no-op, retention is
# enforced through the T-0601 prune seam, and no tenant write is issued.

#Requires -Module Pester

Describe 'Invoke-SecureScoreSnapshot worker (T-0604)' {
    BeforeAll {
        $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
        $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-SecureScoreSnapshot.ps1'

        function global:Invoke-MgGraphRequest {
            param($Method, $Uri, $Body)
        }

        . $script:worker

        $script:readSeam = {
            param($tenantId)
            return [PSCustomObject]@{
                tenantId   = $tenantId
                current    = 42.5
                max        = 100
                percentage = 42.5
                categories = @(
                    [PSCustomObject]@{ category = 'Identity'; achieved = 20; available = 40; percentage = 50 }
                    [PSCustomObject]@{ category = 'Data'; achieved = 22.5; available = 60; percentage = 37.5 }
                )
            }
        }
        $script:listSeam = {
            param($tenantId, $from, $to)
            $script:listCalls.Add([PSCustomObject]@{ tenantId = $tenantId; from = $from; to = $to }) | Out-Null
            return @($script:snapshots | Where-Object { $_.tenantId -eq $tenantId })
        }
        $script:recordSeam = {
            param($snapshot)
            $script:recorded.Add($snapshot) | Out-Null
            $record = [PSCustomObject]@{
                id         = "snap-$($script:recorded.Count)"
                tenantId   = $snapshot.tenantId
                at         = $snapshot.at
                current    = $snapshot.current
                max        = $snapshot.max
                percentage = $snapshot.percentage
                categories = $snapshot.categories
            }
            $script:snapshots.Add($record) | Out-Null
            return $record
        }
        $script:pruneSeam = {
            param($retentionDays)
            $script:pruneCalls.Add([int]$retentionDays) | Out-Null
            return [PSCustomObject]@{ prunedSnapshotsCount = $script:pruneCount }
        }
    }

    BeforeEach {
        $script:snapshots = [System.Collections.Generic.List[object]]::new()
        $script:recorded = [System.Collections.Generic.List[object]]::new()
        $script:listCalls = [System.Collections.Generic.List[object]]::new()
        $script:pruneCalls = [System.Collections.Generic.List[int]]::new()
        $script:pruneCount = 0
    }

    Context 'the worker file' {
        It 'ships the snapshot handler' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            (Get-Command Invoke-SecureScoreSnapshot -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: no tenant write verbs and no Invoke-Expression' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match 'Invoke-Expression'
            # The T-0602 read path is dot-sourced, never reimplemented.
            $source | Should -Match 'Get-SecureScore\.ps1'
        }
    }

    Context 'Invoke-SecureScoreSnapshot recording' {
        It 'records one snapshot per tenant per day from the T-0602 read path' {
            $result = Invoke-SecureScoreSnapshot -TenantId 'tenant-test' -Now '2026-01-02T10:00:00Z' `
                -ReadScore $script:readSeam -ListSnapshots $script:listSeam `
                -RecordSnapshot $script:recordSeam -PruneSnapshots $script:pruneSeam

            $result.Recorded | Should -BeTrue
            $result.Reason | Should -Be 'recorded'
            $script:recorded.Count | Should -Be 1

            $snapshot = $script:recorded[0]
            $snapshot.tenantId | Should -Be 'tenant-test'
            $snapshot.current | Should -Be 42.5
            $snapshot.max | Should -Be 100
            $snapshot.percentage | Should -Be 42.5
            $snapshot.categories['Identity'].achieved | Should -Be 20
            $snapshot.categories['Data'].percentage | Should -Be 37.5
        }

        It 'passes the UTC day window to the T-0601 list seam' {
            $null = Invoke-SecureScoreSnapshot -TenantId 'tenant-test' -Now '2026-01-02T10:00:00Z' `
                -ReadScore $script:readSeam -ListSnapshots $script:listSeam `
                -RecordSnapshot $script:recordSeam -PruneSnapshots $script:pruneSeam

            $script:listCalls.Count | Should -Be 1
            $script:listCalls[0].tenantId | Should -Be 'tenant-test'
            ([datetimeoffset]::Parse($script:listCalls[0].from).UtcDateTime.Day) | Should -Be 2
            ([datetimeoffset]::Parse($script:listCalls[0].to).UtcDateTime.Day) | Should -Be 3
        }

        It 'is idempotent within a day: a second run does not record again' {
            $first = Invoke-SecureScoreSnapshot -TenantId 'tenant-test' -Now '2026-01-02T08:00:00Z' `
                -ReadScore $script:readSeam -ListSnapshots $script:listSeam `
                -RecordSnapshot $script:recordSeam -PruneSnapshots $script:pruneSeam
            $second = Invoke-SecureScoreSnapshot -TenantId 'tenant-test' -Now '2026-01-02T20:00:00Z' `
                -ReadScore $script:readSeam -ListSnapshots $script:listSeam `
                -RecordSnapshot $script:recordSeam -PruneSnapshots $script:pruneSeam

            $first.Recorded | Should -BeTrue
            $second.Recorded | Should -BeFalse
            $second.Reason | Should -Be 'already-recorded'
            $script:recorded.Count | Should -Be 1
        }

        It 'does not read the score when the day is already recorded' {
            $throwingRead = { param($tenantId) throw 'the read path must not be called' }
            $null = Invoke-SecureScoreSnapshot -TenantId 'tenant-test' -Now '2026-01-02T08:00:00Z' `
                -ReadScore $script:readSeam -ListSnapshots $script:listSeam `
                -RecordSnapshot $script:recordSeam -PruneSnapshots $script:pruneSeam

            $second = Invoke-SecureScoreSnapshot -TenantId 'tenant-test' -Now '2026-01-02T09:00:00Z' `
                -ReadScore $throwingRead -ListSnapshots $script:listSeam `
                -RecordSnapshot $script:recordSeam -PruneSnapshots $script:pruneSeam

            $second.Recorded | Should -BeFalse
            $script:recorded.Count | Should -Be 1
        }

        It 'records again on the next day' {
            $null = Invoke-SecureScoreSnapshot -TenantId 'tenant-test' -Now '2026-01-02T08:00:00Z' `
                -ReadScore $script:readSeam -ListSnapshots $script:listSeam `
                -RecordSnapshot $script:recordSeam -PruneSnapshots $script:pruneSeam
            $next = Invoke-SecureScoreSnapshot -TenantId 'tenant-test' -Now '2026-01-03T08:00:00Z' `
                -ReadScore $script:readSeam -ListSnapshots $script:listSeam `
                -RecordSnapshot $script:recordSeam -PruneSnapshots $script:pruneSeam

            $next.Recorded | Should -BeTrue
            $script:recorded.Count | Should -Be 2
        }
    }

    Context 'retention' {
        It 'prunes through the T-0601 seam with the configured window' {
            $script:pruneCount = 4
            $result = Invoke-SecureScoreSnapshot -TenantId 'tenant-test' -Now '2026-01-02T10:00:00Z' `
                -RetentionDays 30 -ReadScore $script:readSeam -ListSnapshots $script:listSeam `
                -RecordSnapshot $script:recordSeam -PruneSnapshots $script:pruneSeam

            $script:pruneCalls | Should -Be @(30)
            $result.PrunedCount | Should -Be 4
        }

        It 'uses the default retention window when none is given' {
            $result = Invoke-SecureScoreSnapshot -TenantId 'tenant-test' -Now '2026-01-02T10:00:00Z' `
                -ReadScore $script:readSeam -ListSnapshots $script:listSeam `
                -RecordSnapshot $script:recordSeam -PruneSnapshots $script:pruneSeam

            $script:pruneCalls | Should -Be @(90)
            $result.RetentionDays | Should -Be 90
        }

        It 'skips pruning when retention is disabled' {
            $result = Invoke-SecureScoreSnapshot -TenantId 'tenant-test' -Now '2026-01-02T10:00:00Z' `
                -RetentionDays 0 -ReadScore $script:readSeam -ListSnapshots $script:listSeam `
                -RecordSnapshot $script:recordSeam -PruneSnapshots $script:pruneSeam

            $script:pruneCalls.Count | Should -Be 0
            $result.PrunedCount | Should -Be 0
        }
    }

    Context 'the T-0602 read path default' {
        It 'reads the current score through Get-SecureScore when no seam is supplied' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Uri -like '*secureScoreControlProfiles*') {
                    return @{ value = @() }
                }
                return @{
                    value = @(
                        @{
                            currentScore    = 42.5
                            maxScore        = 100
                            createdDateTime = '2026-01-02T00:00:00.000Z'
                            controlScores   = @(
                                @{ controlName = 'MFARegistrationV2'; controlCategory = 'Identity'; score = 20; maxScore = 40 }
                            )
                        }
                    )
                }
            }

            $result = Invoke-SecureScoreSnapshot -TenantId 'tenant-test' -Now '2026-01-02T10:00:00Z' `
                -ListSnapshots $script:listSeam -RecordSnapshot $script:recordSeam `
                -PruneSnapshots $script:pruneSeam

            $result.Recorded | Should -BeTrue
            $script:recorded[0].current | Should -Be 42.5
            $script:recorded[0].categories['Identity'].achieved | Should -Be 20
        }
    }
}
