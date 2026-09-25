BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:migration = Join-Path $script:repoRoot 'portal/db/migrations/0056_licensing.sql'
    $script:repository = Join-Path $script:repoRoot 'portal/db/src/licensing-repository.ts'
    $script:contract = Join-Path $script:repoRoot 'portal/db/src/repository.ts'
    $script:index = Join-Path $script:repoRoot 'portal/db/src/index.ts'
}

Describe 'Licensing pricing and change entities (T-0641)' {

    Context 'the migration' {
        It 'exists and creates both entities with the SPEC section 5 columns' {
            Test-Path -LiteralPath $script:migration | Should -BeTrue
            $sql = Get-Content -LiteralPath $script:migration -Raw
            $sql | Should -Match 'CREATE TABLE IF NOT EXISTS license_pricing'
            $sql | Should -Match 'skuId'
            $sql | Should -Match 'skuPartNumber'
            $sql | Should -Match 'unitPrice'
            $sql | Should -Match 'currency'
            $sql | Should -Match 'CREATE TABLE IF NOT EXISTS license_changes'
            $sql | Should -Match 'userId'
            $sql | Should -Match '"by"'
            $sql | Should -Match '"at"'
        }

        It 'is forward-only and re-runnable' {
            $sql = Get-Content -LiteralPath $script:migration -Raw
            $sql | Should -Match 'CREATE TABLE IF NOT EXISTS'
            $sql | Should -Match 'CREATE (UNIQUE )?INDEX IF NOT EXISTS'
            $sql | Should -Match 'CREATE TRIGGER IF NOT EXISTS'
            $sql | Should -Match 'INSERT OR IGNORE INTO schema_versions'
            $sql | Should -Match '\(56,'
        }

        It 'keys pricing on (tenantId, skuId) with a nullable tenantId' {
            $sql = Get-Content -LiteralPath $script:migration -Raw
            $sql | Should -Match 'tenantId\s+TEXT REFERENCES tenants'
            $sql | Should -Match 'WHERE tenantId IS NULL'
            $sql | Should -Match 'WHERE tenantId IS NOT NULL'
        }

        It 'keeps license changes append-only' {
            $sql = Get-Content -LiteralPath $script:migration -Raw
            $sql | Should -Match 'license_changes_no_update'
            $sql | Should -Match 'license_changes_no_delete'
            $sql | Should -Match 'append-only'
        }
    }

    Context 'the repository' {
        It 'exposes pricing read/upsert with per-tenant resolution' {
            Test-Path -LiteralPath $script:repository | Should -BeTrue
            $source = Get-Content -LiteralPath $script:repository -Raw
            $source | Should -Match 'getLicensePricing'
            $source | Should -Match 'listLicensePricing'
            $source | Should -Match 'upsertLicensePricing'
            $source | Should -Match 'tenantId IS NULL'
        }

        It 'appends license changes with audit and no update/delete mutator' {
            $source = Get-Content -LiteralPath $script:repository -Raw
            $source | Should -Match 'appendLicenseChange'
            $source | Should -Match 'getLicenseChange'
            $source | Should -Match 'listLicenseChanges'
            $source | Should -Match 'licensing\.change\.append'
            $source | Should -Not -Match 'updateLicenseChange'
            $source | Should -Not -Match 'deleteLicenseChange'
        }

        It 'declares the SPEC section 5 shapes in the shared contract' {
            $source = Get-Content -LiteralPath $script:contract -Raw
            $source | Should -Match 'interface LicensePricing'
            $source | Should -Match 'interface LicenseChange'
        }

        It 'is exported from the repository index' {
            $source = Get-Content -LiteralPath $script:index -Raw
            $source | Should -Match 'licensing-repository\.js'
        }
    }
}
