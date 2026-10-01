<#
.SYNOPSIS
    Guard test for T-0767: the opt-in Save-to-GitHub flow ships the gated
    save-to-github route, the adapter seam that fails closed without the
    EPIC-041 GitHub integration, and a dialog hidden until that integration is
    configured. Source-inspection only, matching tests/Portal/Settings.
#>

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:bffModule = Join-Path $script:repoRoot 'portal/bff/src/templates/save-to-github.ts'
    $script:bffTest = Join-Path $script:repoRoot 'portal/bff/src/templates/save-to-github.test.ts'
    $script:dialog = Join-Path $script:repoRoot 'portal/web/src/components/SaveToGitHubDialog.tsx'
}

Describe 'Save template to GitHub (T-0767)' {

    Context 'the BFF route and adapter seam' {
        It 'ships the module and its co-located test' {
            Test-Path -LiteralPath $script:bffModule | Should -BeTrue
            Test-Path -LiteralPath $script:bffTest | Should -BeTrue
        }

        It 'exposes the gated POST /v1/template-library/{id}/save-to-github route' {
            $source = Get-Content -LiteralPath $script:bffModule -Raw
            $source | Should -Match '"/v1/template-library/:id/save-to-github"'
            $source | Should -Match 'method: "POST"'
            $source | Should -Match 'SAVE_TO_GITHUB_PERMISSION = "templates.write"'
        }

        It 'reuses the EPIC-041 GitHub integration through an adapter seam' {
            $source = Get-Content -LiteralPath $script:bffModule -Raw
            $source | Should -Match 'GITHUB_INTEGRATION_KIND = "github"'
            $source | Should -Match 'interface GitHubCommitAdapter'
            $source | Should -Match 'getIntegrationConfig\(GITHUB_INTEGRATION_KIND\)'
        }

        It 'fails closed with a structured error when no integration is configured' {
            $source = Get-Content -LiteralPath $script:bffModule -Raw
            $source | Should -Match 'github_not_configured'
            $source | Should -Match 'notConfiguredError'
            $source | Should -Match 'GitHubAuthError'
            $source | Should -Match 'GitHubConflictError'
        }

        It 'audits a successful commit' {
            $source = Get-Content -LiteralPath $script:bffModule -Raw
            $source | Should -Match 'action: "template\.github\.commit"'
            $source | Should -Match 'this\.audit\('
        }
    }

    Context 'the dialog' {
        It 'hides the flow until the integration is enabled' {
            $source = Get-Content -LiteralPath $script:dialog -Raw
            $source | Should -Match 'if \(!enabled \|\| !isOpen \|\| !item\) return null'
            $source | Should -Match 'Save to GitHub'
        }

        It 'posts the repository and commit message to the save route' {
            $source = Get-Content -LiteralPath $script:dialog -Raw
            $source | Should -Match 'save-to-github'
            $source | Should -Match 'method: "POST"'
            $source | Should -Match 'message'
        }

        It 'styles only from theme tokens, with no colour literals' {
            $source = Get-Content -LiteralPath $script:dialog -Raw
            $source | Should -Match 'var\(--'
            $source | Should -Not -Match '#[0-9a-fA-F]{3,8}\b'
            $source | Should -Not -Match '\brgba?\s*\('
            $source | Should -Not -Match '\bhsla?\s*\('
        }
    }

    Context 'the regression test' {
        It 'covers fail-closed, the enabled commit + audit, and structured failures' {
            $source = Get-Content -LiteralPath $script:bffTest -Raw
            $source | Should -Match 'fails closed'
            $source | Should -Match 'audits the commit'
            $source | Should -Match 'auth failure'
            $source | Should -Match 'conflict'
        }
    }
}
