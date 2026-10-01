<#
.SYNOPSIS
    Guard test for T-0688: retention prunes expired backups and their artifacts
    (audited), replication copies the latest archive to a same-tier secondary
    target idempotently, and GET/PUT /v1/backup-settings persist and return the
    BackupConfig retention/replication settings.
#>

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:bffSrc = Join-Path $script:repoRoot 'portal/bff/src'
    $script:retentionModule = Join-Path $script:bffSrc 'backup/retention.ts'
    $script:retentionTest = Join-Path $script:bffSrc 'backup/retention.test.ts'
    $script:replicationModule = Join-Path $script:bffSrc 'backup/replication.ts'
    $script:replicationTest = Join-Path $script:bffSrc 'backup/replication.test.ts'
    $script:settingsModule = Join-Path $script:bffSrc 'routes/backup-settings.ts'
    $script:settingsTest = Join-Path $script:bffSrc 'routes/backup-settings.test.ts'

    $script:retentionSource = Get-Content -LiteralPath $script:retentionModule -Raw
    $script:retentionTestSource = Get-Content -LiteralPath $script:retentionTest -Raw
    $script:replicationSource = Get-Content -LiteralPath $script:replicationModule -Raw
    $script:replicationTestSource = Get-Content -LiteralPath $script:replicationTest -Raw
    $script:settingsSource = Get-Content -LiteralPath $script:settingsModule -Raw
    $script:settingsTestSource = Get-Content -LiteralPath $script:settingsTest -Raw
}

Describe 'Backup retention, replication, and settings (T-0688)' {

    Context 'the retention module' {
        It 'exists with a co-located test' {
            Test-Path -LiteralPath $script:retentionModule | Should -BeTrue
            Test-Path -LiteralPath $script:retentionTest | Should -BeTrue
        }

        It 'prunes backups older than the retention window and removes their artifacts' {
            $script:retentionSource | Should -Match 'pruneExpiredBackups'
            $script:retentionSource | Should -Match 'retentionCutoff'
            $script:retentionSource | Should -Match 'artifacts\.remove'
            $script:retentionSource | Should -Match 'store\.deleteBackup'
        }

        It 'audits each prune' {
            $script:retentionSource | Should -Match 'backup\.prune'
            $script:retentionSource | Should -Match 'RecordAudit'
        }

        It 'proves expiry in the co-located test' {
            $script:retentionTestSource | Should -Match 'prunes expired backups'
            $script:retentionTestSource | Should -Match 'retention boundary'
        }
    }

    Context 'the replication module' {
        It 'exists with a co-located test' {
            Test-Path -LiteralPath $script:replicationModule | Should -BeTrue
            Test-Path -LiteralPath $script:replicationTest | Should -BeTrue
        }

        It 'copies the latest archive to the secondary same-tier location' {
            $script:replicationSource | Should -Match 'replicateLatestBackup'
            $script:replicationSource | Should -Match 'latestBackup'
            $script:replicationSource | Should -Match 'replicationRef'
            $script:replicationSource | Should -Match 'artifacts\.write'
        }

        It 'is idempotent and audits a fresh copy' {
            $script:replicationSource | Should -Match 'alreadyReplicated'
            $script:replicationSource | Should -Match 'artifacts\.exists'
            $script:replicationSource | Should -Match 'backup\.replicate'
        }

        It 'proves idempotency in the co-located test' {
            $script:replicationTestSource | Should -Match 'idempotent'
            $script:replicationTestSource | Should -Match 'alreadyReplicated'
        }
    }

    Context 'the backup-settings route' {
        It 'exists with a co-located test' {
            Test-Path -LiteralPath $script:settingsModule | Should -BeTrue
            Test-Path -LiteralPath $script:settingsTest | Should -BeTrue
        }

        It 'declares GET and PUT on the backup-settings path' {
            $script:settingsSource | Should -Match 'BACKUP_SETTINGS_PATH\s*=\s*"/v1/backup-settings"'
            $script:settingsSource | Should -Match 'method:\s*"GET".*BACKUP_SETTINGS_PATH'
            $script:settingsSource | Should -Match 'method:\s*"PUT".*BACKUP_SETTINGS_PATH'
        }

        It 'persists and returns retentionDays and replicationTarget' {
            $script:settingsSource | Should -Match 'getBackupConfig'
            $script:settingsSource | Should -Match 'upsertBackupConfig'
            $script:settingsSource | Should -Match 'retentionDays'
            $script:settingsSource | Should -Match 'replicationTarget'
        }

        It 'enforces the backup.read and backup.write permission seam' {
            $script:settingsSource | Should -Match 'BACKUP_READ_PERMISSION'
            $script:settingsSource | Should -Match 'BACKUP_WRITE_PERMISSION'
        }

        It 'proves the round-trip in the co-located test' {
            $script:settingsTestSource | Should -Match 'persists and returns retentionDays and replicationTarget'
        }
    }
}
