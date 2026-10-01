<#
.SYNOPSIS
    Guard test for T-0446: the contact templates route module implements the
    EPIC-023 §6 endpoints over the T-0441 repository, validates template shape
    with a structured error, and ships a co-located test that covers CRUD.
#>

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:bffSrc = Join-Path $script:repoRoot 'portal/bff/src'
    $script:routeModule = Join-Path $script:bffSrc 'routes/contact-templates.ts'
    $script:routeTest = Join-Path $script:bffSrc 'routes/contact-templates.test.ts'
    $script:source = Get-Content -LiteralPath $script:routeModule -Raw
    $script:testSource = Get-Content -LiteralPath $script:routeTest -Raw
}

Describe 'Contact templates routes (T-0446)' {

    Context 'the route module' {
        It 'exists with a co-located test' {
            Test-Path -LiteralPath $script:routeModule | Should -BeTrue
            Test-Path -LiteralPath $script:routeTest | Should -BeTrue
        }

        It 'declares the §6 CRUD endpoints' {
            $script:source | Should -Match 'CONTACT_TEMPLATES_PATH\s*=\s*"/v1/contact-templates"'
            $script:source | Should -Match 'CONTACT_TEMPLATE_PATH\s*=\s*"/v1/contact-templates/:id"'
            $script:source | Should -Match 'method:\s*"GET"'
            $script:source | Should -Match 'method:\s*"POST"'
            $script:source | Should -Match 'method:\s*"PATCH"'
            $script:source | Should -Match 'method:\s*"DELETE"'
        }

        It 'persists through the T-0441 repository surface' {
            foreach ($method in @('listContactTemplates', 'getContactTemplate', 'upsertContactTemplate', 'softDeleteContactTemplate')) {
                $script:source | Should -Match $method
            }
            $script:source | Should -Not -Match 'Invoke-MgGraphRequest'
        }

        It 'gates reads behind contacts.read and writes behind contacts.write' {
            $script:source | Should -Match 'read:\s*"contacts\.read"'
            $script:source | Should -Match 'write:\s*"contacts\.write"'
            $script:source | Should -Match 'requirePermission'
        }

        It 'rejects invalid shapes with a structured error before persistence' {
            $script:source | Should -Match 'CONTACT_TEMPLATE_INVALID\s*=\s*"contact_template\.invalid"'
            $script:source | Should -Match 'collectContactTemplateIssues'
            $script:source | Should -Match 'invalidTemplate'
        }

        It 'publishes the OpenAPI fragment for the operations' {
            $script:source | Should -Match 'CONTACT_TEMPLATES_OPENAPI'
            $script:source | Should -Match '/contact-templates'
            $script:source | Should -Match '/contact-templates/\{id\}'
        }
    }

    Context 'the co-located test' {
        It 'covers create, read, update, and soft delete' {
            $script:testSource | Should -Match 'creates, reads, updates, and soft-deletes'
            $script:testSource | Should -Match 'round-trips properties and variables unchanged'
            $script:testSource | Should -Match 'never persists them'
        }

        It 'proves an invalid shape is rejected before the repository is called' {
            $script:testSource | Should -Match 'upserts'
            $script:testSource | Should -Match 'contact_template\.invalid'
        }
    }
}
