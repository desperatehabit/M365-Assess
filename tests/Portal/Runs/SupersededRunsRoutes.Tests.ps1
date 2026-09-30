<#
.SYNOPSIS
    Guard test for T-0834: the superseded EPIC-001 routes/runs.ts module is gone
    and nothing mounted or tested depends on it.
#>

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:bffSrc = Join-Path $script:repoRoot 'portal/bff/src'
    $script:runsModule = Join-Path $script:bffSrc 'routes/runs.ts'
    $script:runsModuleTest = Join-Path $script:bffSrc 'routes/runs.test.ts'
    $script:app = Join-Path $script:bffSrc 'app.ts'
}

Describe 'Superseded EPIC-001 runs route module (T-0834)' {

    Context 'the deleted module' {
        It 'no longer exists on disk' {
            Test-Path -LiteralPath $script:runsModule | Should -BeFalse
        }

        It 'no longer has a co-located test file' {
            Test-Path -LiteralPath $script:runsModuleTest | Should -BeFalse
        }
    }

    Context 'the wiring' {
        BeforeAll {
            $script:appSource = Get-Content -LiteralPath $script:app -Raw
        }

        It 'does not import the deleted module' {
            $script:appSource | Should -Not -Match 'routes/runs\.js'
            $script:appSource | Should -Not -Match '\./runs\.js'
        }

        It 'still mounts the EPIC-003 run modules' {
            $script:appSource | Should -Match 'routes/runs-detail\.js'
            $script:appSource | Should -Match 'routes/runs-artifacts\.js'
            $script:appSource | Should -Match 'routes/runs-actions\.js'
        }
    }

    Context 'the rest of the BFF source tree' {
        It 'contains no import of the deleted module' {
            $routesDir = Join-Path $script:bffSrc 'routes'
            $importers = Get-ChildItem -LiteralPath $script:bffSrc -Filter '*.ts' -Recurse |
                Where-Object {
                    $source = Get-Content -LiteralPath $_.FullName -Raw
                    $importsRoutesRuns = $source -match 'from\s+["''][^"'']*/routes/runs\.js["'']'
                    $importsLocalRuns = $_.DirectoryName -eq $routesDir -and
                        $source -match 'from\s+["'']\./runs\.js["'']'
                    $importsRoutesRuns -or $importsLocalRuns
                }
            $importers | Should -BeNullOrEmpty -Because 'no source file may import the deleted EPIC-001 runs module'
        }
    }
}
