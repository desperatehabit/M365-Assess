BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:page = Join-Path $script:repoRoot 'portal/web/src/app/security/defender/page.tsx'
    $script:component = Join-Path $script:repoRoot 'portal/web/src/components/defender/DefenderStatusCards.tsx'
    $script:componentTests = Join-Path $script:repoRoot 'portal/web/src/components/defender/DefenderStatusCards.test.tsx'
}

Describe 'Defender Status page and cards (T-0362)' {

    Context 'the status page' {
        It 'exists at the Security & Compliance Defender Status route' {
            Test-Path -LiteralPath $script:page | Should -BeTrue
        }

        It 'reads current vs recommended from the T-0361 status route' {
            $source = Get-Content -LiteralPath $script:page -Raw
            $source | Should -Match '/v1/tenants/.*/defender/status'
            $source | Should -Match 'DefenderStatusCards'
        }

        It 'stays read-only' {
            $source = Get-Content -LiteralPath $script:page -Raw
            $source | Should -Not -Match 'method:\s*"POST"'
            $source | Should -Not -Match 'method:\s*"PATCH"'
            $source | Should -Not -Match 'method:\s*"DELETE"'
        }
    }

    Context 'the status cards component' {
        It 'exists and renders one card per policy area' {
            Test-Path -LiteralPath $script:component | Should -BeTrue
            $source = Get-Content -LiteralPath $script:component -Raw
            $source | Should -Match 'DefenderStatusCards'
            $source | Should -Match 'defender-status-card-'
        }

        It 'marks unsupported areas as Unsupported instead of failing' {
            $source = Get-Content -LiteralPath $script:component -Raw
            $source | Should -Match 'Unsupported'
            $source | Should -Match 'supported'
        }

        It 'links supported cards to the related finding or standard' {
            $source = Get-Content -LiteralPath $script:component -Raw
            $source | Should -Match 'defenderAreaFindingHref'
            $source | Should -Match 'standards/alignment'
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
        It 'covers pass, fail, review, and unsupported rendering' {
            Test-Path -LiteralPath $script:componentTests | Should -BeTrue
            $source = Get-Content -LiteralPath $script:componentTests -Raw
            $source | Should -Match 'Pass'
            $source | Should -Match 'Fail'
            $source | Should -Match 'Review'
            $source | Should -Match 'Unsupported'
        }
    }
}
