BeforeDiscovery {
    # Scripts built on the single-resource Graph pattern (GET a resource,
    # compare $expected, PATCH $body) with no mandatory parameters can be
    # exercised generically against an in-memory Graph.
    $moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../src/M365-Assess')).Path
    $script:graphCases = @(Get-ChildItem -Path (Join-Path $moduleRoot 'Remediate/Scripts') -Filter '*.ps1' -Recurse |
            Where-Object { $_.Directory.Name -ne 'Common' } |
            Where-Object {
                $text = Get-Content -Path $_.FullName -Raw
                $ast = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$null)
                $mandatory = @($ast.ParamBlock.Parameters | Where-Object {
                        $_.Attributes.NamedArguments | Where-Object { $_.ArgumentName -eq 'Mandatory' }
                    })
                $text -match 'Test-RemediationProperty -State \$State -Expected \$expected' -and
                ([regex]::Matches($text, 'Get-RemediationGraphObject -Uri')).Count -eq 1 -and
                $text -notmatch 'Invoke-MgGraphRequest' -and
                $mandatory.Count -eq 0
            } |
            ForEach-Object { @{ Path = $_.FullName; CheckId = $_.BaseName } })
}

BeforeAll {
    $FakeGraph = @{}

    function Get-MgContext { [PSCustomObject]@{ Scopes = @() } }

    function Merge-FakeGraph {
        param([hashtable]$Target, [System.Collections.IDictionary]$Patch)
        foreach ($k in $Patch.Keys) {
            if ($Patch[$k] -is [System.Collections.IDictionary] -and $Target[$k] -is [System.Collections.IDictionary]) {
                Merge-FakeGraph -Target $Target[$k] -Patch $Patch[$k]
            }
            else {
                $Target[$k] = $Patch[$k]
            }
        }
    }

    function Invoke-MgGraphRequest {
        param($Method, $Uri, $Body, $ContentType, $OutputType)
        if (-not $FakeGraph.ContainsKey($Uri)) { $FakeGraph[$Uri] = @{} }
        if ($Method -eq 'GET') {
            return ($FakeGraph[$Uri] | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable)
        }
        Merge-FakeGraph -Target $FakeGraph[$Uri] -Patch ($Body | ConvertFrom-Json -AsHashtable)
    }
}

Describe 'Graph script <CheckId> against a simulated tenant' -ForEach $script:graphCases {
    BeforeEach { $FakeGraph.Clear() }

    It 'does not write under -WhatIf' {
        $result = & $Path -WhatIf
        $result.Status | Should -Be 'WhatIf'
        ($FakeGraph.Values | Where-Object { $_.Count -gt 0 }) | Should -BeNullOrEmpty
    }

    It 'applies the change, verifies it, and is then compliant' {
        $result = & $Path -Confirm:$false
        $result.Status | Should -Be 'Applied'
        (& $Path -WhatIf).Status | Should -Be 'AlreadyCompliant'
    }
}
