# Get-BrandingStyles.Tests.ps1
# Pester tests for T-0086 — branding injection at render time.
# Asserts: CSS variables set, logo/watermark fragments, footer/page-numbers,
# fallback to stock theme, and XSS/injection rejection.

#Requires -Module Pester
Set-StrictMode -Version Latest

Describe 'Get-BrandingStyles' {
    BeforeAll {
        . (Join-Path $PSScriptRoot '../../../portal/workers/M365Portal.Workers/Get-BrandingStyles.ps1')
    }

    Context 'Stock / no BrandingConfig' {
        It 'Returns all three fragment keys' {
            $result = Get-BrandingStyles
            $result.Keys | Should -Contain 'CssOverrides'
            $result.Keys | Should -Contain 'CoverFragment'
            $result.Keys | Should -Contain 'FooterFragment'
        }

        It 'Injects the default accent colour into CSS overrides' {
            $result = Get-BrandingStyles
            $result.CssOverrides | Should -Match '--accent:\s*#005a9e'
        }

        It 'Produces an empty cover fragment when no logo or watermark is supplied' {
            $result = Get-BrandingStyles
            $result.CoverFragment | Should -BeNullOrEmpty
        }

        It 'Includes the stock footer text' {
            $result = Get-BrandingStyles
            $result.FooterFragment | Should -Match 'M365-Assess'
        }

        It 'Includes page numbers when ShowPageNumbers defaults to true' {
            $result = Get-BrandingStyles
            $result.FooterFragment | Should -Match 'counter\(page\)'
        }
    }

    Context 'Custom BrandingConfig' {
        BeforeAll {
            $script:Cfg = [PSCustomObject]@{
                PrimaryColour   = '#c00000'
                SurfaceColour   = '#f5f5f5'
                TextColour      = '#111111'
                MutedColour     = '#888888'
                LogoUrl         = 'https://example.com/logo.png'
                WatermarkText   = 'Draft'
                FooterText      = 'Acme Corp – Confidential'
                ShowPageNumbers = $true
            }
        }

        It 'Uses the custom primary colour in CSS overrides' {
            $result = Get-BrandingStyles -BrandingConfig $script:Cfg
            $result.CssOverrides | Should -Match '--accent:\s*#c00000'
        }

        It 'Includes the logo img tag' {
            $result = Get-BrandingStyles -BrandingConfig $script:Cfg
            $result.CoverFragment | Should -Match '<img'
            $result.CoverFragment | Should -Match 'example.com/logo.png'
        }

        It 'Includes the watermark text' {
            $result = Get-BrandingStyles -BrandingConfig $script:Cfg
            $result.CoverFragment | Should -Match 'Draft'
        }

        It 'Uses the custom footer text' {
            $result = Get-BrandingStyles -BrandingConfig $script:Cfg
            $result.FooterFragment | Should -Match 'Acme Corp'
        }
    }

    Context 'Partial BrandingConfig — fallback fields' {
        It 'Falls back to the stock accent when PrimaryColour is missing' {
            $partial = [PSCustomObject]@{ LogoUrl = 'https://example.com/logo.png' }
            $result = Get-BrandingStyles -BrandingConfig $partial
            $result.CssOverrides | Should -Match '--accent:\s*#005a9e'
        }

        It 'Falls back to stock footer when FooterText is absent' {
            $partial = [PSCustomObject]@{ PrimaryColour = '#c00000' }
            $result = Get-BrandingStyles -BrandingConfig $partial
            $result.FooterFragment | Should -Match 'M365-Assess'
        }

        It 'Produces no cover fragment when both LogoUrl and WatermarkText are absent' {
            $partial = [PSCustomObject]@{ PrimaryColour = '#c00000' }
            $result = Get-BrandingStyles -BrandingConfig $partial
            $result.CoverFragment | Should -BeNullOrEmpty
        }
    }

    Context 'Security — tenant-supplied HTML/JS rejected' {
        It 'Rejects a LogoUrl that does not start with https://' {
            $bad = [PSCustomObject]@{ LogoUrl = 'javascript:alert(1)' }
            { Get-BrandingStyles -BrandingConfig $bad } | Should -Throw -ExceptionType ([System.ArgumentException])
        }

        It 'Rejects a non-https http:// LogoUrl' {
            $bad = [PSCustomObject]@{ LogoUrl = 'http://example.com/logo.png' }
            { Get-BrandingStyles -BrandingConfig $bad } | Should -Throw -ExceptionType ([System.ArgumentException])
        }

        It 'HTML-encodes the watermark text so tags cannot be injected' {
            $bad = [PSCustomObject]@{ WatermarkText = '<script>alert(1)</script>' }
            $result = Get-BrandingStyles -BrandingConfig $bad
            $result.CoverFragment | Should -Not -Match '<script>'
            $result.CoverFragment | Should -Match '&lt;script&gt;'
        }

        It 'Rejects a PrimaryColour with CSS-breaking characters' {
            $bad = [PSCustomObject]@{ PrimaryColour = 'red; color: blue' }
            { Get-BrandingStyles -BrandingConfig $bad } | Should -Throw -ExceptionType ([System.ArgumentException])
        }
    }

    Context 'Inject-BrandingIntoHtml' {
        BeforeAll {
            $script:MinimalHtml = @'
<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><div id="root"></div></body>
</html>
'@
        }

        It 'Injects the branding css style block after head' {
            $result = Inject-BrandingIntoHtml -HtmlContent $script:MinimalHtml
            $result | Should -Match '<style id="m365-branding-css">'
        }

        It 'Injects a cover fragment before <div id="root"> when logo is supplied' {
            $cfg = [PSCustomObject]@{ LogoUrl = 'https://example.com/logo.png' }
            $result = Inject-BrandingIntoHtml -HtmlContent $script:MinimalHtml -BrandingConfig $cfg
            # cover fragment must precede root div
            $coverIdx = $result.IndexOf('m365-branding-cover')
            $rootIdx  = $result.IndexOf('<div id="root">')
            $coverIdx | Should -BeLessThan $rootIdx
        }

        It 'Appends the footer style block before body' {
            $result = Inject-BrandingIntoHtml -HtmlContent $script:MinimalHtml
            $result | Should -Match '<style id="m365-branding-footer">'
            $footerIdx = $result.IndexOf('m365-branding-footer')
            $bodyIdx   = $result.IndexOf('</body>')
            $footerIdx | Should -BeLessThan $bodyIdx
        }

        It 'Is idempotent — a second call does not double-inject' {
            $once  = Inject-BrandingIntoHtml -HtmlContent $script:MinimalHtml
            $twice = Inject-BrandingIntoHtml -HtmlContent $once
            $count = ([regex]::Matches($twice, 'm365-branding-css')).Count
            $count | Should -Be 1
        }
    }
}
