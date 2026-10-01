BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:settingsPage = Join-Path $script:repoRoot 'portal/web/src/app/settings/page.tsx'
    $script:featuresPage = Join-Path $script:repoRoot 'portal/web/src/app/settings/features/page.tsx'
    $script:preferencesPage = Join-Path $script:repoRoot 'portal/web/src/app/preferences/page.tsx'
    $script:tabs = Join-Path $script:repoRoot 'portal/web/src/components/settings/SettingsTabs.tsx'
    $script:flagsTable = Join-Path $script:repoRoot 'portal/web/src/components/settings/FeatureFlagsTable.tsx'
    $script:testFile = Join-Path $script:repoRoot 'portal/web/src/components/settings/Settings.test.tsx'
    $script:uiFiles = @(
        $script:settingsPage
        $script:featuresPage
        $script:preferencesPage
        $script:tabs
        $script:flagsTable
    )
}

Describe 'Application Settings UI (T-0728 section 3.1)' {

    Context 'the settings route' {
        It 'ships the settings, features, and preferences surfaces' {
            Test-Path -LiteralPath $script:settingsPage | Should -BeTrue
            Test-Path -LiteralPath $script:featuresPage | Should -BeTrue
            Test-Path -LiteralPath $script:preferencesPage | Should -BeTrue
            Test-Path -LiteralPath $script:tabs | Should -BeTrue
            Test-Path -LiteralPath $script:flagsTable | Should -BeTrue
        }

        It 'renders the trimmed CIPP tab pattern' {
            $source = Get-Content -LiteralPath $script:tabs -Raw
            foreach ($tab in @('general', 'branding', 'permissions', 'notifications', 'features', 'security', 'integrations')) {
                $source | Should -Match ([regex]::Escape("id: `"$tab`""))
            }
        }

        It 'persists settings through PUT /v1/settings and surfaces field errors' {
            $source = Get-Content -LiteralPath $script:settingsPage -Raw
            $source | Should -Match 'SETTINGS_API_PATH = "/v1/settings"'
            $source | Should -Match 'method: "PUT"'
            $source | Should -Match 'details'
            $source | Should -Match 'fieldErrors'
            $source | Should -Match 'SettingsTabs'
        }
    }

    Context 'feature flags and nav gating' {
        It 'reads the same flag source the API enforces' {
            $source = Get-Content -LiteralPath $script:flagsTable -Raw
            $source | Should -Match 'isFlagEnabled'
            $source | Should -Match 'gateNavGroups'
            $source | Should -Match 'missing or disabled'
            $source | Should -Match 'description'
            $source | Should -Match 'scope'
            $source | Should -Match 'effect'
        }

        It 'toggles flags through PUT /v1/feature-flags' {
            $source = Get-Content -LiteralPath $script:featuresPage -Raw
            $source | Should -Match 'FEATURE_FLAGS_API_PATH = "/v1/feature-flags"'
            $source | Should -Match 'method: "PUT"'
            $source | Should -Match 'gateNavGroups'
        }
    }

    Context 'preferences' {
        It 'persists per-user preferences and mirrors them to localStorage' {
            $source = Get-Content -LiteralPath $script:preferencesPage -Raw
            $source | Should -Match 'PREFERENCES_API_PATH = "/v1/preferences"'
            $source | Should -Match 'method: "PUT"'
            $source | Should -Match 'PREFERENCES_STORAGE_KEY'
            $source | Should -Match 'localStorage\.setItem'
            $source | Should -Match 'applyTheme'
            $source | Should -Match 'tablePageSize'
            $source | Should -Match 'compactNav'
            $source | Should -Match 'portalLinks'
        }
    }

    Context 'theme tokens and tests' {
        It 'styles only from theme tokens, with no colour literals' {
            foreach ($file in $script:uiFiles) {
                $source = Get-Content -LiteralPath $file -Raw
                $source | Should -Match 'var\(--'
                $source | Should -Not -Match '#[0-9a-fA-F]{3,8}\b'
                $source | Should -Not -Match '\brgba?\s*\('
                $source | Should -Not -Match '\bhsla?\s*\('
            }
        }

        It 'ships a regression test that drives the pages' {
            Test-Path -LiteralPath $script:testFile | Should -BeTrue
            $source = Get-Content -LiteralPath $script:testFile -Raw
            $source | Should -Match 'gateNavGroups'
            $source | Should -Match 'SettingsPage'
            $source | Should -Match 'PreferencesPage'
            $source | Should -Match 'localStorage'
        }
    }
}
