<#
.SYNOPSIS
    Guard test for T-0868: the EPIC-038 RBAC, portal-user, API-client, and
    OpenAPI JSON routes are mounted in the composition root and persist through
    the SQLite rbac repository rather than the test-only in-memory stores.
#>

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:bffSrc = Join-Path $script:repoRoot 'portal/bff/src'
    $script:app = Join-Path $script:bffSrc 'app.ts'
    $script:adapter = Join-Path $script:bffSrc 'adapters/rbac.ts'
    $script:openapiRoute = Join-Path $script:bffSrc 'routes/openapi.ts'
    $script:appSource = Get-Content -LiteralPath $script:app -Raw
}

Describe 'EPIC-038 route mounting (T-0868)' {

    Context 'the composition root' {
        It 'imports every unmounted EPIC-038 route factory' {
            $script:appSource | Should -Match 'createPortalUsersRoute'
            $script:appSource | Should -Match 'createRolesRoutes'
            $script:appSource | Should -Match 'createApiClientRoutes'
            $script:appSource | Should -Match 'createOpenApiRoutes'
        }

        It 'mounts the portal users, roles, API clients, and OpenAPI routes' {
            $script:appSource | Should -Match '\.\.\.createPortalUsersRoute\(\{'
            $script:appSource | Should -Match '\.\.\.createRolesRoutes\(\{'
            $script:appSource | Should -Match '\.\.\.createApiClientRoutes\('
            $script:appSource | Should -Match '\.\.\.createOpenApiRoutes\(\)'
        }

        It 'binds the stores to the SQLite rbac repository' {
            $script:appSource | Should -Match 'new SqliteRbacRepository\(db, schemaVersion\)'
            $script:appSource | Should -Match 'createPortalUserStore\('
            $script:appSource | Should -Match 'createRolesStore\('
            $script:appSource | Should -Match 'createApiClientStore\('
        }

        It 'never wires the in-memory seed stores in production' {
            $script:appSource | Should -Not -Match 'createInMemoryPortalUserStore'
            $script:appSource | Should -Not -Match 'createInMemoryRolesStore'
            $script:appSource | Should -Not -Match 'createInMemoryApiClientStore'
        }
    }

    Context 'the SQLite adapter' {
        It 'exists' {
            Test-Path -LiteralPath $script:adapter | Should -BeTrue
        }

        It 'maps each route store onto the RbacRepository contract' {
            $adapterSource = Get-Content -LiteralPath $script:adapter -Raw
            $adapterSource | Should -Match 'RbacRepository'
            $adapterSource | Should -Match 'export function createPortalUserStore'
            $adapterSource | Should -Match 'export function createRolesStore'
            $adapterSource | Should -Match 'export function createApiClientStore'
            $adapterSource | Should -Match 'upsertUserScope'
            $adapterSource | Should -Match 'removePortalUser'
        }
    }

    Context 'the OpenAPI JSON route' {
        It 'serves both the root and versioned JSON paths' {
            $openapiSource = Get-Content -LiteralPath $script:openapiRoute -Raw
            $openapiSource | Should -Match 'OPENAPI_JSON_PATH = "/openapi\.json"'
            $openapiSource | Should -Match 'OPENAPI_VERSIONED_JSON_PATH = "/v1/openapi\.json"'
            $openapiSource | Should -Match 'method: "GET", path: OPENAPI_JSON_PATH'
            $openapiSource | Should -Match 'method: "GET", path: OPENAPI_VERSIONED_JSON_PATH'
        }
    }
}
