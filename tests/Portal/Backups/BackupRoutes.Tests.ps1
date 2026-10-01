<#
.SYNOPSIS
    Guard test for T-0685: the backups route module implements the four EPIC-035
    endpoints, enforces the backup.read/backup.write permission seam and tenant
    scoping, streams downloads, and audits create and delete.
#>

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:bffSrc = Join-Path $script:repoRoot 'portal/bff/src'
    $script:routeModule = Join-Path $script:bffSrc 'routes/backups.ts'
    $script:routeTest = Join-Path $script:bffSrc 'routes/backups.test.ts'
    $script:source = Get-Content -LiteralPath $script:routeModule -Raw
    $script:testSource = Get-Content -LiteralPath $script:routeTest -Raw
}

Describe 'Backups routes (T-0685)' {

    Context 'the route module' {
        It 'exists with a co-located test' {
            Test-Path -LiteralPath $script:routeModule | Should -BeTrue
            Test-Path -LiteralPath $script:routeTest | Should -BeTrue
        }

        It 'declares the four EPIC-035 endpoints' {
            $script:source | Should -Match 'GET.*BACKUPS_PATH'
            $script:source | Should -Match 'POST.*BACKUPS_PATH'
            $script:source | Should -Match 'GET.*BACKUP_DOWNLOAD_PATH'
            $script:source | Should -Match 'DELETE.*BACKUP_PATH'
        }

        It 'enforces the backup.read and backup.write permission seam' {
            $script:source | Should -Match 'BACKUP_READ_PERMISSION\s*=\s*"backup\.read"'
            $script:source | Should -Match 'BACKUP_WRITE_PERMISSION\s*=\s*"backup\.write"'
            $script:source | Should -Match 'requireBackupPermission'
        }

        It 'scopes every read to the caller tenant scope' {
            $script:source | Should -Match 'requireTenantInScope'
            $script:source | Should -Match 'isBackupVisible'
            $script:source | Should -Match 'isTenantAllowed'
        }

        It 'streams the archive artifact instead of buffering it' {
            $script:source | Should -Match 'readStream'
            $script:source | Should -Match 'stream:\s*options\.artifacts\.readStream'
            $script:source | Should -Not -Match 'readFile'
        }

        It 'removes the artifact and the row on delete' {
            $script:source | Should -Match 'artifacts\.remove'
            $script:source | Should -Match 'store\.deleteBackup'
        }

        It 'audits create and delete' {
            $script:source | Should -Match 'backup\.create'
            $script:source | Should -Match 'backup\.delete'
            $script:source | Should -Match 'recordAudit'
        }

        It 'dispatches create to the instance and tenant collectors' {
            $script:source | Should -Match 'createInstanceBackup'
            $script:source | Should -Match 'createTenantBackup'
        }

        It 'cursor-paginates the listing' {
            $script:source | Should -Match 'parsePagination'
            $script:source | Should -Match 'paginate'
        }

        It 'publishes the OpenAPI fragment for all four endpoints' {
            $script:source | Should -Match 'BACKUPS_OPENAPI'
            $script:source | Should -Match '/backups'
            $script:source | Should -Match '/backups/\{id\}/download'
            $script:source | Should -Match '/backups/\{id\}'
        }
    }

    Context 'the co-located test' {
        It 'covers the four endpoints and the tenant-scope seam' {
            $script:testSource | Should -Match 'describe\("Backups routes'
            $script:testSource | Should -Match 'hides another tenant'
            $script:testSource | Should -Match 'streams the archive artifact'
            $script:testSource | Should -Match 'deletes the artifact and row'
        }

        It 'proves a caller cannot see another tenant''s backup' {
            $script:testSource | Should -Match 'bk-tenant-b'
            $script:testSource | Should -Match 'outside the caller scope'
        }
    }
}
