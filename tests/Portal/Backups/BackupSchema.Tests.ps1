<#
.SYNOPSIS
    Guard test for T-0681: the Backup/BackupConfig migration and repository
    surface exist, carry no secret columns, and keep their SQL in portal/db.
#>

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:dbSrc = Join-Path $script:repoRoot 'portal/db/src'
    $script:migration = Join-Path $script:repoRoot 'portal/db/migrations/0043_backups.sql'
    $script:contract = Join-Path $script:dbSrc 'repository.ts'
    $script:impl = Join-Path $script:dbSrc 'sqlite-repository.ts'
    $script:testFile = Join-Path $script:dbSrc 'backups.test.ts'
    $script:methods = @(
        'createBackup', 'getBackup', 'listBackups', 'deleteBackup',
        'getBackupConfig', 'upsertBackupConfig'
    )
    $script:migrationSource = Get-Content -LiteralPath $script:migration -Raw
}

Describe 'Backup schema and repository (T-0681)' {

    It 'ships migration 0043_backups.sql' {
        Test-Path -LiteralPath $script:migration | Should -BeTrue
    }

    It 'creates both SPEC section 5 tables idempotently' {
        $script:migrationSource | Should -Match 'CREATE TABLE IF NOT EXISTS backups'
        $script:migrationSource | Should -Match 'CREATE TABLE IF NOT EXISTS backup_config'
    }

    It 'registers schema version 43' {
        $script:migrationSource | Should -Match 'INSERT OR IGNORE INTO schema_versions[\s\S]*?VALUES \(43,'
    }

    It 'has no backup column that could store a secret value' {
        $names = [regex]::Matches(
            $script:migrationSource,
            '(?m)^\s+(\w+)\s+(TEXT|INTEGER|BLOB|REAL|NUMERIC)\b'
        ) | ForEach-Object { $_.Groups[1].Value }
        $names | Should -Not -BeNullOrEmpty
        foreach ($name in $names) {
            $name | Should -Not -Match '(?i)secret|token|password|passwd|credential|private|apikey|blob|bytes|content|value'
        }
    }

    It 'declares the repository methods on the contract' {
        $source = Get-Content -LiteralPath $script:contract -Raw
        foreach ($method in $script:methods) {
            $source | Should -Match "\b$method\s*\("
        }
    }

    It 'implements the repository methods in the SQLite layer' {
        $source = Get-Content -LiteralPath $script:impl -Raw
        foreach ($method in $script:methods) {
            $source | Should -Match "async $method\s*\("
        }
    }

    It 'proves create/delete audit and a secret-free schema in the co-located test' {
        Test-Path -LiteralPath $script:testFile | Should -BeTrue
        $source = Get-Content -LiteralPath $script:testFile -Raw
        $source | Should -Match 'backup\.create'
        $source | Should -Match 'backup\.delete'
        $source | Should -Match 'secret'
    }

    It 'keeps backup SQL inside portal/db' {
        $portal = Join-Path $script:repoRoot 'portal'
        $offenders = Get-ChildItem -LiteralPath $portal -Filter '*.ts' -File -Recurse |
            Where-Object {
                $normalized = $_.FullName -replace '\\', '/'
                $normalized -notmatch 'node_modules|/\.next/|/dist/|/portal/db/'
            } |
            Where-Object {
                (Get-Content -LiteralPath $_.FullName -Raw) -match
                    '(?i)\b(FROM|INTO|UPDATE|DELETE FROM)\s+(backups|backup_config)\b'
            }
        $offenders | Should -BeNullOrEmpty -Because 'the repository is the only DB-aware layer (ADR-0015)'
    }
}
