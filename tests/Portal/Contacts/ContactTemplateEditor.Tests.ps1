<#
.SYNOPSIS
    Guard test for T-0446: the contact template editor renders the template
    `properties` and `variables` maps and round-trips them unchanged, and the
    §3.2 page lists templates and opens the editor.
#>

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:webSrc = Join-Path $script:repoRoot 'portal/web/src'
    $script:editor = Join-Path $script:webSrc 'components/contacts/ContactTemplateEditor.tsx'
    $script:editorTest = Join-Path $script:webSrc 'components/contacts/ContactTemplateEditor.test.tsx'
    $script:page = Join-Path $script:webSrc 'app/email/contact-templates/page.tsx'
    $script:editorSource = Get-Content -LiteralPath $script:editor -Raw
    $script:testSource = Get-Content -LiteralPath $script:editorTest -Raw
    $script:pageSource = Get-Content -LiteralPath $script:page -Raw
}

Describe 'Contact template editor (T-0446)' {

    Context 'the editor component' {
        It 'exists with a co-located test and the §3.2 page' {
            Test-Path -LiteralPath $script:editor | Should -BeTrue
            Test-Path -LiteralPath $script:editorTest | Should -BeTrue
            Test-Path -LiteralPath $script:page | Should -BeTrue
        }

        It 'renders the properties and variables maps' {
            $script:editorSource | Should -Match 'contact-template-properties'
            $script:editorSource | Should -Match 'contact-template-variables'
            $script:editorSource | Should -Match 'parseObjectField'
        }

        It 'round-trips the maps without coercing them' {
            $script:editorSource | Should -Match 'properties:\s*properties\.value'
            $script:editorSource | Should -Match 'variables:\s*variables\.value'
        }

        It 'hands the validated template to the caller instead of persisting it' {
            $script:editorSource | Should -Match 'onSave'
            $script:editorSource | Should -Not -Match 'Invoke-MgGraphRequest'
        }
    }

    Context 'the page' {
        It 'lists templates and opens the editor for create and edit' {
            $script:pageSource | Should -Match 'listContactTemplates'
            $script:pageSource | Should -Match 'createContactTemplate'
            $script:pageSource | Should -Match 'updateContactTemplate'
            $script:pageSource | Should -Match 'deleteContactTemplate'
            $script:pageSource | Should -Match 'ContactTemplateEditor'
        }
    }

    Context 'the co-located test' {
        It 'proves the maps round-trip unchanged and invalid JSON is rejected' {
            $script:testSource | Should -Match 'round-trips properties and variables unchanged'
            $script:testSource | Should -Match 'rejects invalid JSON'
            $script:testSource | Should -Match 'never saves'
        }
    }
}
