BeforeDiscovery {
    $moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../src/M365-Assess')).Path
    $scriptsRoot = Join-Path $moduleRoot 'Remediate/Scripts'
    $script:scriptCases = @(Get-ChildItem -Path $scriptsRoot -Filter '*.ps1' -Recurse |
            Where-Object { $_.Directory.Name -ne 'Common' } |
            ForEach-Object { @{ Path = $_.FullName; CheckId = $_.BaseName; Collector = $_.Directory.Name } })
}

BeforeAll {
    $script:moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../src/M365-Assess')).Path
    $script:scriptsRoot = Join-Path $script:moduleRoot 'Remediate/Scripts'
    $script:registry = (Get-Content -Path (Join-Path $script:moduleRoot 'controls/registry.json') -Raw | ConvertFrom-Json).checks
    $script:registryById = @{}
    foreach ($c in $script:registry) { $script:registryById[$c.checkId] = $c }
    $script:coverage = Get-Content -Path (Join-Path $script:scriptsRoot 'coverage.json') -Raw | ConvertFrom-Json
    $script:excluded = @($script:coverage.excluded.PSObject.Properties.Name)
}

Describe 'Remediation script coverage' {
    It 'every registry check in a scripted collector has a script or a coverage.json exclusion' {
        $files = @(Get-ChildItem -Path $script:scriptsRoot -Filter '*.ps1' -Recurse |
                Where-Object { $_.Directory.Name -ne 'Common' })
        $present = @($files | ForEach-Object { $_.BaseName })
        # Collectors are scripted one at a time; a collector counts once its folder exists.
        $collectors = @($files | ForEach-Object { $_.Directory.Name } | Sort-Object -Unique)
        $missing = @($script:registry | Where-Object {
                $collectors -contains $_.collector -and
                $present -notcontains $_.checkId -and $script:excluded -notcontains $_.checkId
            } | ForEach-Object { "$($_.collector)/$($_.checkId)" })
        $missing | Should -HaveCount 0 -Because "these checks have neither a script nor an exclusion: $($missing -join ', ')"
    }

    It 'coverage.json only excludes checks that exist and have no script' {
        foreach ($id in $script:excluded) {
            $script:registryById.ContainsKey($id) | Should -BeTrue -Because "$id is excluded but not in the registry"
            @(Get-ChildItem -Path $script:scriptsRoot -Filter "$id.ps1" -Recurse) | Should -HaveCount 0 -Because "$id is excluded but also has a script"
        }
    }
}

Describe 'Remediation script <CheckId>' -ForEach $script:scriptCases {
    BeforeAll {
        $tokens = $null
        $parseErrors = $null
        $script:ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$parseErrors)
        $script:parseErrors = $parseErrors
        $script:text = Get-Content -Path $Path -Raw
    }

    It 'parses without errors' {
        $script:parseErrors | Should -HaveCount 0
    }

    It 'is named for a registry check in the matching collector folder' {
        $script:registryById.ContainsKey($CheckId) | Should -BeTrue
        $script:registryById[$CheckId].collector | Should -Be $Collector
    }

    It 'declares SupportsShouldProcess with ConfirmImpact High' {
        $attr = $script:ast.ParamBlock.Attributes | Where-Object { $_.TypeName.Name -eq 'CmdletBinding' }
        $attr | Should -Not -BeNullOrEmpty
        ($attr.NamedArguments | Where-Object ArgumentName -eq 'SupportsShouldProcess') | Should -Not -BeNullOrEmpty
        ($attr.NamedArguments | Where-Object ArgumentName -eq 'ConfirmImpact').Argument.Value | Should -Be 'High'
    }

    It 'has comment-based help with a synopsis naming the check' {
        $help = $script:ast.GetHelpContent()
        $help | Should -Not -BeNullOrEmpty
        $help.Synopsis | Should -Match ([regex]::Escape($CheckId))
        $help.Examples.Count | Should -BeGreaterOrEqual 1
    }

    It 'uses the shared helper and only reports its own check id' {
        $script:text | Should -Match 'RemediationScriptHelper\.ps1'
        $script:text | Should -Match 'Assert-RemediationConnection'
        $script:text | Should -Match 'Invoke-RemediationStep -Cmdlet \$PSCmdlet'
        $ids = [regex]::Matches($script:text, "CheckId\s+=\s+'([^']+)'") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
        $ids | Should -Be @($CheckId)
    }

    It 'never uses Invoke-Expression' {
        $script:text | Should -Not -Match 'Invoke-Expression|\biex\b'
    }
}
