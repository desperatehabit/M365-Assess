# Resolve-ReportBinding.Tests.ps1
# Pester tests for T-0087 — report block data binding resolver.
# Asserts: five entity resolutions, unknown binding rejection, missing field
# validation, static pass-through, and missing DataBinding error.

#Requires -Module Pester
Set-StrictMode -Version Latest

Describe 'Resolve-ReportBinding' {
    BeforeAll {
        . (Join-Path $PSScriptRoot '../../../portal/workers/M365Portal.Workers/Resolve-ReportBinding.ps1')

    #region ── Helper builders ──────────────────────────────────────────────────

    function New-Block {
        param(
            [string]$Id = 'blk-1',
            [string]$Type = 'score-cards',
            [bool]$IsStatic = $false,
            [string]$Entity = $null
        )
        $block = [PSCustomObject]@{
            Id       = $Id
            Type     = $Type
            IsStatic = $IsStatic
        }
        if ($Entity) {
            $block | Add-Member -NotePropertyName 'DataBinding' -NotePropertyValue ([PSCustomObject]@{ entity = $Entity })
        }
        return $block
    }

    function New-Source {
        return [PSCustomObject]@{
            'run-summary'  = [PSCustomObject]@{ totalControls = 120; passed = 97 }
            'findings'     = @([PSCustomObject]@{ id = 'f1'; status = 'failed'; severity = 'high' })
            'compliance'   = [PSCustomObject]@{ aligned = 80; accepted = 5; denied = 2 }
            'secure-score' = [PSCustomObject]@{ current = 72; max = 100 }
            'licenses'     = @([PSCustomObject]@{ sku = 'ENTERPRISEPREMIUM'; assigned = 50; purchased = 60 })
        }
    }

    #endregion
    }

    Context 'Static block' {
        It 'Returns IsStatic=true and no data without touching DataSource' {
            $block  = New-Block -IsStatic $true
            $result = Resolve-ReportBinding -Block $block
            $result.IsStatic | Should -BeTrue
            $result.Data     | Should -BeNullOrEmpty
            $result.ValidationResult.IsValid | Should -BeTrue
        }
    }

    Context 'Five adopted binding entities' {
        It 'Resolves run-summary' {
            $block  = New-Block -Entity 'run-summary'
            $result = Resolve-ReportBinding -Block $block -DataSource (New-Source)
            $result.ValidationResult.IsValid | Should -BeTrue
            $result.Entity | Should -Be 'run-summary'
            $result.Data.totalControls | Should -Be 120
        }

        It 'Resolves findings' {
            $block  = New-Block -Entity 'findings'
            $result = Resolve-ReportBinding -Block $block -DataSource (New-Source)
            $result.ValidationResult.IsValid | Should -BeTrue
            $result.Entity | Should -Be 'findings'
            $result.Data[0].status | Should -Be 'failed'
        }

        It 'Resolves compliance' {
            $block  = New-Block -Entity 'compliance'
            $result = Resolve-ReportBinding -Block $block -DataSource (New-Source)
            $result.ValidationResult.IsValid | Should -BeTrue
            $result.Data.aligned | Should -Be 80
        }

        It 'Resolves secure-score' {
            $block  = New-Block -Entity 'secure-score'
            $result = Resolve-ReportBinding -Block $block -DataSource (New-Source)
            $result.ValidationResult.IsValid | Should -BeTrue
            $result.Data.current | Should -Be 72
        }

        It 'Resolves licenses' {
            $block  = New-Block -Entity 'licenses'
            $result = Resolve-ReportBinding -Block $block -DataSource (New-Source)
            $result.ValidationResult.IsValid | Should -BeTrue
            $result.Data[0].sku | Should -Be 'ENTERPRISEPREMIUM'
        }
    }

    Context 'Unknown binding rejected' {
        It 'Returns IsValid=false for an unrecognised entity' {
            $block  = New-Block -Entity 'shadow-ai-usage'
            $result = Resolve-ReportBinding -Block $block -DataSource (New-Source)
            $result.ValidationResult.IsValid  | Should -BeFalse
            $result.ValidationResult.Errors   | Should -Not -BeNullOrEmpty
            $result.ValidationResult.Errors[0] | Should -Match 'unknown binding entity'
        }

        It 'Data is null for an unknown entity' {
            $block  = New-Block -Entity 'unknown'
            $result = Resolve-ReportBinding -Block $block -DataSource (New-Source)
            $result.Data | Should -BeNullOrEmpty
        }
    }

    Context 'Missing or null field produces a validation error' {
        It 'Reports an error when secure-score is absent from the data source' {
            $emptySource = [PSCustomObject]@{}
            $block  = New-Block -Entity 'secure-score'
            $result = Resolve-ReportBinding -Block $block -DataSource $emptySource
            $result.ValidationResult.IsValid  | Should -BeFalse
            $result.ValidationResult.Errors[0] | Should -Match "no data available"
        }

        It 'Reports an error when DataSource is null' {
            $block  = New-Block -Entity 'findings'
            $result = Resolve-ReportBinding -Block $block -DataSource $null
            $result.ValidationResult.IsValid | Should -BeFalse
        }
    }

    Context 'Missing DataBinding descriptor' {
        It 'Returns IsValid=false when DataBinding is absent on a live block' {
            $block = [PSCustomObject]@{ Id = 'blk-x'; Type = 'chart'; IsStatic = $false }
            $result = Resolve-ReportBinding -Block $block -DataSource (New-Source)
            $result.ValidationResult.IsValid | Should -BeFalse
            $result.ValidationResult.Errors[0] | Should -Match 'no DataBinding'
        }
    }
}

Describe 'Resolve-ReportDocument' {
    BeforeAll {
        . (Join-Path $PSScriptRoot '../../../portal/workers/M365Portal.Workers/Resolve-ReportBinding.ps1')

        function New-Source {
            return [PSCustomObject]@{
                'run-summary'  = [PSCustomObject]@{ totalControls = 120 }
                'secure-score' = [PSCustomObject]@{ current = 72 }
            }
        }
    }

    It 'Returns a resolved block per document block' {
        $doc = [PSCustomObject]@{
            blocks = @(
                [PSCustomObject]@{ Id = 'b1'; Type = 'score-cards'; IsStatic = $false; DataBinding = [PSCustomObject]@{ entity = 'run-summary' } },
                [PSCustomObject]@{ Id = 'b2'; Type = 'rich-text';   IsStatic = $true }
            )
        }
        $result = Resolve-ReportDocument -Document $doc -DataSource (New-Source)
        $result.ResolvedBlocks.Count | Should -Be 2
        $result.ValidationResult.IsValid | Should -BeTrue
    }

    It 'Marks document invalid when any block has an unknown entity' {
        $doc = [PSCustomObject]@{
            blocks = @(
                [PSCustomObject]@{ Id = 'b1'; Type = 'chart'; IsStatic = $false; DataBinding = [PSCustomObject]@{ entity = 'bad-entity' } }
            )
        }
        $result = Resolve-ReportDocument -Document $doc -DataSource (New-Source)
        $result.ValidationResult.IsValid | Should -BeFalse
        $result.ValidationResult.Errors.Count | Should -BeGreaterThan 0
    }

    It 'Returns empty resolved blocks for a document with no blocks' {
        $doc = [PSCustomObject]@{ blocks = @() }
        $result = Resolve-ReportDocument -Document $doc -DataSource (New-Source)
        $result.ResolvedBlocks.Count | Should -Be 0
        $result.ValidationResult.IsValid | Should -BeTrue
    }
}
