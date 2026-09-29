BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:component = Join-Path $script:repoRoot 'portal/web/src/components/defender/DefenderSetupWizard.tsx'
    $script:componentTests = Join-Path $script:repoRoot 'portal/web/src/components/defender/DefenderSetupWizard.test.tsx'
}

Describe 'Defender setup wizard (T-0365)' {

    Context 'the wizard component' {
        It 'exists with the area, scope, plan, and apply steps' {
            Test-Path -LiteralPath $script:component | Should -BeTrue
            $source = Get-Content -LiteralPath $script:component -Raw
            $source | Should -Match 'DefenderSetupWizard'
            $source | Should -Match 'Policy areas'
            $source | Should -Match 'Target scope'
            $source | Should -Match 'Plan preview'
        }

        It 'posts previews and applies to the T-0364 deploy route' {
            $source = Get-Content -LiteralPath $script:component -Raw
            $source | Should -Match '/v1/tenants/.*/defender/deploy'
            $source | Should -Match 'preview:\s*true'
        }

        It 'keeps the save-as-template toggle off by default and passes it through' {
            $source = Get-Content -LiteralPath $script:component -Raw
            $source | Should -Match 'useState\(false\)'
            $source | Should -Match 'saveAsTemplate'
            $source | Should -Match 'wizard-save-template-toggle'
        }

        It 'surfaces the overwrite option from conflicting plans' {
            $source = Get-Content -LiteralPath $script:component -Raw
            $source | Should -Match 'conflict'
            $source | Should -Match 'wizard-overwrite-toggle'
        }

        It 'renders per-area success and failure results' {
            $source = Get-Content -LiteralPath $script:component -Raw
            $source | Should -Match 'wizard-result-'
            $source | Should -Match 'succeeded'
            $source | Should -Match 'failed'
        }

        It 'uses kit tokens with zero colour literals' {
            $source = Get-Content -LiteralPath $script:component -Raw
            $source | Should -Match 'var\(--'
            $source | Should -Not -Match '#fff'
            $source | Should -Not -Match '#000'
            $source | Should -Not -Match 'rgba?\('
        }
    }

    Context 'the component tests' {
        It 'covers the stepper, toggle default, and result rendering' {
            Test-Path -LiteralPath $script:componentTests | Should -BeTrue
            $source = Get-Content -LiteralPath $script:componentTests -Raw
            $source | Should -Match 'wizard-next'
            $source | Should -Match 'save-as-template'
            $source | Should -Match 'wizard-result-av'
            $source | Should -Match 'wizard-conflict'
        }
    }
}
