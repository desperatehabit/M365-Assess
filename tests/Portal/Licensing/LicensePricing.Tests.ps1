BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:route = Join-Path $script:repoRoot 'portal/bff/src/routes/license-pricing.ts'
    $script:routeTest = Join-Path $script:repoRoot 'portal/bff/src/routes/license-pricing.test.ts'
    $script:seed = Join-Path $script:repoRoot 'portal/bff/src/domain/license-pricing-seed.ts'
    $script:seedTest = Join-Path $script:repoRoot 'portal/bff/src/domain/license-pricing-seed.test.ts'
}

Describe 'License pricing API and seed (T-0644)' {

    Context 'the pricing route' {
        It 'exists and serves GET and PUT /v1/license-pricing' {
            Test-Path -LiteralPath $script:route | Should -BeTrue
            $source = Get-Content -LiteralPath $script:route -Raw
            $source | Should -Match 'LICENSE_PRICING_PATH = "/v1/license-pricing"'
            $source | Should -Match 'method: "GET"'
            $source | Should -Match 'method: "PUT"'
        }

        It 'resolves effective pricing (tenant override else global)' {
            $source = Get-Content -LiteralPath $script:route -Raw
            $source | Should -Match 'listLicensePricing\(request\.tenantId\)'
            $source | Should -Match 'listLicensePricing\(\)'
        }

        It 'gates PUT on the CIPP.Admin.* scope and GET on the licensing read permission' {
            $source = Get-Content -LiteralPath $script:route -Raw
            $source | Should -Match 'CIPP\.Admin\.\*'
            $source | Should -Match 'Tenant\.Licensing\.Read'
        }

        It 'upserts through the audited repository surface so every edit writes an AuditEvent' {
            $source = Get-Content -LiteralPath $script:route -Raw
            $source | Should -Match 'upsertLicensePricing'
        }

        It 'publishes the OpenAPI fragment with both operations' {
            $source = Get-Content -LiteralPath $script:route -Raw
            $source | Should -Match 'LICENSE_PRICING_OPENAPI'
            $source | Should -Match 'getLicensePricing'
            $source | Should -Match 'putLicensePricing'
        }
    }

    Context 'the seed' {
        It 'exists and parses the committed CSV into global rows' {
            Test-Path -LiteralPath $script:seed | Should -BeTrue
            $source = Get-Content -LiteralPath $script:seed -Raw
            $source | Should -Match 'LICENSE_PRICING_SEED_CSV'
            $source | Should -Match 'parseLicensePricingSeedCsv'
        }

        It 'seeds insert-only so an operator edit survives a later bootstrap' {
            $source = Get-Content -LiteralPath $script:seed -Raw
            $source | Should -Match 'seedLicensePricing'
            $source | Should -Match 'skipped'
            $source | Should -Match 'tenantId: null'
        }
    }

    Context 'the tests' {
        It 'covers the route and the seed' {
            Test-Path -LiteralPath $script:routeTest | Should -BeTrue
            Test-Path -LiteralPath $script:seedTest | Should -BeTrue
            $routeTest = Get-Content -LiteralPath $script:routeTest -Raw
            $routeTest | Should -Match 'CIPP\.Admin\.\*'
            $routeTest | Should -Match 'writes an AuditEvent for every pricing edit'
            $seedTest = Get-Content -LiteralPath $script:seedTest -Raw
            $seedTest | Should -Match 'does not clobber an operator edit'
        }
    }
}
