BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:page = Join-Path $script:repoRoot 'portal/web/src/app/reports/builder/page.tsx'
    $script:canvas = Join-Path $script:repoRoot 'portal/web/src/components/reports/BlockCanvas.tsx'
    $script:controls = Join-Path $script:repoRoot 'portal/web/src/components/reports/BlockControls.tsx'
    $script:rail = Join-Path $script:repoRoot 'portal/web/src/components/reports/ReportSettingsRail.tsx'
    $script:testFile = Join-Path $script:repoRoot 'portal/web/src/components/reports/ReportBuilder.test.tsx'
}

Describe 'Report Builder page (T-0088)' {

    Context 'the builder route' {
        It 'exists with a left canvas and a right settings rail' {
            Test-Path -LiteralPath $script:page | Should -BeTrue
            $source = Get-Content -LiteralPath $script:page -Raw
            $source | Should -Match 'BlockCanvas'
            $source | Should -Match 'ReportSettingsRail'
        }

        It 'offers Save template, Schedule, Download PDF, Preview PDF, and Add block' {
            $source = Get-Content -LiteralPath $script:page -Raw
            $source | Should -Match 'Save template'
            $source | Should -Match 'Schedule'
            $source | Should -Match 'Download PDF'
            $source | Should -Match 'Preview PDF'
            $source | Should -Match 'Add block'
        }

        It 'persists through the template API and reloads the canvas intact' {
            $source = Get-Content -LiteralPath $script:page -Raw
            $source | Should -Match '/v1/report-templates'
            $source | Should -Match 'parseBuilderBlocks'
            $source | Should -Match 'PATCH'
        }

        It 'previews and downloads through the server-side render path' {
            $source = Get-Content -LiteralPath $script:page -Raw
            $source | Should -Match '/v1/reports/render'
            $source | Should -Match 'role="dialog"'
            $source | Should -Match 'preview-download'
        }

        It 'hands scheduling off to the EPIC-007 scheduler surface' {
            $source = Get-Content -LiteralPath $script:page -Raw
            $source | Should -Match '/schedules'
            $source | Should -Match 'EPIC-007'
        }

        It 'styles from report tokens instead of hard-coded colours' {
            $source = Get-Content -LiteralPath $script:page -Raw
            $source | Should -Match 'var\(--'
            $source | Should -Not -Match '#[0-9a-fA-F]{6}\b'
        }
    }

    Context 'the block canvas' {
        It 'constrains the add-block picker to the v1 block set' {
            Test-Path -LiteralPath $script:canvas | Should -BeTrue
            $source = Get-Content -LiteralPath $script:canvas -Raw
            foreach ($type in @('chart', 'score-cards', 'progress-bars', 'section-divider', 'page-break', 'rich-text')) {
                $source | Should -Match ('"' + $type + '"')
            }
        }

        It 'renders all six block types' {
            $source = Get-Content -LiteralPath $script:canvas -Raw
            $source | Should -Match 'case "chart"'
            $source | Should -Match 'case "score-cards"'
            $source | Should -Match 'case "progress-bars"'
            $source | Should -Match 'case "section-divider"'
            $source | Should -Match 'case "page-break"'
            $source | Should -Match 'case "rich-text"'
        }

        It 'supports move, remove, refresh, and revert helpers' {
            $source = Get-Content -LiteralPath $script:canvas -Raw
            $source | Should -Match 'moveBlockInList'
            $source | Should -Match 'removeBlockFromList'
            $source | Should -Match 'refreshBlockInList'
            $source | Should -Match 'revertBlockInList'
            $source | Should -Match 'createBlock'
        }
    }

    Context 'the per-block controls' {
        It 'exposes move up, move down, remove, refresh, and revert actions' {
            Test-Path -LiteralPath $script:controls | Should -BeTrue
            $source = Get-Content -LiteralPath $script:controls -Raw
            $source | Should -Match 'Move up'
            $source | Should -Match 'Move down'
            $source | Should -Match 'Remove'
            $source | Should -Match 'Refresh data'
            $source | Should -Match 'Revert to live data'
        }
    }

    Context 'the settings rail' {
        It 'edits Report Settings and Page Setup and Branding' {
            Test-Path -LiteralPath $script:rail | Should -BeTrue
            $source = Get-Content -LiteralPath $script:rail -Raw
            $source | Should -Match 'Report Settings'
            $source | Should -Match 'Page Setup &amp; Branding|Page Setup & Branding'
            $source | Should -Match 'report-setting-title'
            $source | Should -Match 'report-page-size'
            $source | Should -Match 'report-brand-watermark'
        }
    }

    Context 'the component test' {
        It 'covers add, move, remove, settings edits, and the save round-trip' {
            Test-Path -LiteralPath $script:testFile | Should -BeTrue
            $source = Get-Content -LiteralPath $script:testFile -Raw
            $source | Should -Match 'adds every v1 block type'
            $source | Should -Match 'moves blocks up and down and removes them'
            $source | Should -Match 'edits report settings'
            $source | Should -Match 'saves through the template API'
            $source | Should -Match 'previews through the server render path'
        }
    }
}
