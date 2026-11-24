#Requires -Modules Pester
<#
.SYNOPSIS
    Guards against `$x = if (...) { @(...) } else { @() }` in module code (T-0950).
.DESCRIPTION
    PowerShell unrolls the output of a statement used as an assignment's value, so a
    one-element array produced inside an `if` arrives as the element itself. A single
    Invoke-MgGraphRequest item is a hashtable, whose .Count is its key count and whose [0]
    is a key lookup. Wrap the whole statement instead: `$x = @(if (...) { ... })`.
#>

BeforeDiscovery {
    $script:moduleRoot = Join-Path -Path $PSScriptRoot -ChildPath '../../src/M365-Assess'
}

Describe 'if-assignment unroll guard (T-0950)' {
    BeforeAll {
        $script:moduleRoot = Join-Path -Path $PSScriptRoot -ChildPath '../../src/M365-Assess'

        function Find-IfAssignmentUnroll {
            param([Parameter(Mandatory)][string]$Path)
            foreach ($file in Get-ChildItem -Path $Path -Recurse -Include '*.ps1', '*.psm1') {
                $ast = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$null)
                $assignments = $ast.FindAll({
                        param($node)
                        $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
                        $node.Right -is [System.Management.Automation.Language.IfStatementAst]
                    }, $true)
                $text = $ast.Extent.Text
                foreach ($assignment in $assignments) {
                    # A clause whose body is a bare @(...) array is unrolled on assignment.
                    $bodies = @($assignment.Right.Clauses | ForEach-Object { $_.Item2 })
                    if ($assignment.Right.ElseClause) { $bodies += $assignment.Right.ElseClause }
                    $wrapsArray = $bodies | Where-Object { $_.Extent.Text -match '^\{\s*@\(' }
                    if (-not $wrapsArray) { continue }

                    # It returns wrong results when the variable is then counted or indexed.
                    $variable = [regex]::Escape(($assignment.Left.Extent.Text -replace '^\[[^\]]+\]', ''))
                    $after = $text.Substring($assignment.Extent.EndOffset - $ast.Extent.StartOffset)
                    if ($after -match "$variable(\.Count|\.Length|\[\d+\])") {
                        '{0}:{1}' -f $file.FullName, $assignment.Extent.StartLineNumber
                    }
                }
            }
        }
    }

    It 'finds the pattern in a sample so the guard is live' {
        $sample = Join-Path -Path $TestDrive -ChildPath 'sample.ps1'
        Set-Content -Path $sample -Value @(
            '$list = if ($resp -and $resp[''value'']) { @($resp[''value'']) } else { @() }'
            '"count: $($list.Count)"'
        )
        @(Find-IfAssignmentUnroll -Path $TestDrive).Count | Should -Be 1
    }

    It 'does not flag the wrapped form' {
        $sample = Join-Path -Path $TestDrive -ChildPath 'wrapped.ps1'
        Set-Content -Path $sample -Value '$list = @(if ($resp -and $resp[''value'']) { $resp[''value''] })'
        Remove-Item -Path (Join-Path -Path $TestDrive -ChildPath 'sample.ps1') -ErrorAction SilentlyContinue
        @(Find-IfAssignmentUnroll -Path $TestDrive).Count | Should -Be 0
    }

    It 'module code never counts or indexes a `$x = if (...) { @(...) }` assignment' {
        $hits = @(Find-IfAssignmentUnroll -Path $script:moduleRoot)
        $hits | Should -BeNullOrEmpty -Because "wrap the whole statement as `$x = @(if (...) { ... })`; found: $($hits -join '; ')"
    }

    It 'a wrapped single Graph item keeps array semantics' {
        $resp = @{ value = @(@{ id = 'a'; displayName = 'Only'; userPrincipalName = 'x'; onPremisesSyncEnabled = $null }) }
        $unrolled = if ($resp -and $resp['value']) { @($resp['value']) } else { @() }
        $wrapped = @(if ($resp -and $resp['value']) { $resp['value'] })

        $unrolled.Count | Should -Be 4 -Because 'this is the bug: the hashtable key count'
        $wrapped.Count | Should -Be 1
        $wrapped[0]['displayName'] | Should -Be 'Only'
    }
}
