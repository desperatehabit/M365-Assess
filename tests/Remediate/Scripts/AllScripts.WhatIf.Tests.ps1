BeforeDiscovery {
    # Smoke test for every script, including templates with mandatory
    # parameters: run it under -WhatIf with every tenant command faked and
    # mandatory parameters filled from their declared type / validation. A
    # script error (bad variable, wrong splat, typo) shows up as a Failed step
    # or an exception; WhatIf must never write.
    $moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../src/M365-Assess')).Path
    $script:allCases = @(Get-ChildItem -Path (Join-Path $moduleRoot 'Remediate/Scripts') -Filter '*.ps1' -Recurse |
            Where-Object { $_.Directory.Name -ne 'Common' } |
            ForEach-Object { @{ Path = $_.FullName; CheckId = $_.BaseName } })
}

BeforeAll {
    $script:helperPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '../../../src/M365-Assess')).Path 'Remediate/Scripts/Common/RemediationScriptHelper.ps1'
    $FakeWrites = [System.Collections.Generic.List[string]]::new()

    function Get-FakeArgumentSet {
        param([System.Management.Automation.Language.ScriptBlockAst]$Ast)
        $splat = @{}
        $chosenSet = $null
        foreach ($p in @($Ast.ParamBlock.Parameters)) {
            $paramAttrs = @($p.Attributes | Where-Object { $_.TypeName.Name -eq 'Parameter' })
            $mandatory = $paramAttrs | Where-Object { $_.NamedArguments | Where-Object { $_.ArgumentName -eq 'Mandatory' } }
            if (-not $mandatory) { continue }
            $set = ($mandatory.NamedArguments | Where-Object { $_.ArgumentName -eq 'ParameterSetName' }).Argument.Value
            if ($set) {
                if ($null -eq $chosenSet) { $chosenSet = $set }
                if ($set -ne $chosenSet) { continue }
            }
            $name = $p.Name.VariablePath.UserPath
            $type = $p.StaticType
            $validateSet = $p.Attributes | Where-Object { $_.TypeName.Name -eq 'ValidateSet' }
            $validateRange = $p.Attributes | Where-Object { $_.TypeName.Name -eq 'ValidateRange' }
            $validateScript = $p.Attributes | Where-Object { $_.TypeName.Name -eq 'ValidateScript' }
            $value = if ($validateScript) { $f = Join-Path ([System.IO.Path]::GetTempPath()) 'remediation-test.pdf'; Set-Content -LiteralPath $f -Value 'x'; $f }
            elseif ($validateSet) { $validateSet.PositionalArguments[0].Value }
            elseif ($validateRange) { [int]$validateRange.PositionalArguments[0].Value }
            elseif ($type -eq [switch]) { $true }
            elseif ($type -eq [guid] -or $type -eq [guid[]]) { [guid]'11111111-2222-3333-4444-555555555555' }
            elseif ($type -eq [int]) { 1 }
            elseif ($name -match 'Id$') { '11111111-2222-3333-4444-555555555555' }
            elseif ($name -match 'Address|User|Reviewer|Group|Mailbox') { 'someone@contoso.example' }
            else { 'test-value' }
            if ($type.IsArray -and $value -isnot [array] -and $type -ne [switch]) { $value = @($value) }
            $splat[$name] = $value
        }
        $splat
    }
}

Describe 'Script <CheckId> under -WhatIf with faked tenant commands' -ForEach $script:allCases {
    BeforeAll {
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$null, [ref]$null)
        $helperAst = [System.Management.Automation.Language.Parser]::ParseFile($script:helperPath, [ref]$null, [ref]$null)
        $helperFunctions = @($helperAst.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) | ForEach-Object { $_.Name })
        $commands = @(@($ast, $helperAst) | ForEach-Object {
                $_.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)
            } | ForEach-Object { $_.GetCommandName() } | Where-Object { $_ } | Sort-Object -Unique |
                Where-Object { $helperFunctions -notcontains $_ -and -not (Get-Command -Name $_ -CommandType Cmdlet -ErrorAction SilentlyContinue) })
        foreach ($c in $commands) {
            if ($c -eq 'Invoke-AzRestMethod') {
                Set-Item -Path "function:script:$c" -Value {
                    param($Method, $Path, $Payload)
                    if ($Method -ne 'GET') { $FakeWrites.Add("$Method $Path") }
                    [PSCustomObject]@{ StatusCode = 404; Content = '{}' }
                }
            }
            elseif ($c -eq 'Invoke-MgGraphRequest') {
                Set-Item -Path "function:script:$c" -Value {
                    param($Method, $Uri, $Body, $ContentType, $OutputType)
                    if ($Method -ne 'GET') { $FakeWrites.Add("$Method $Uri") }
                    @{ value = @() }
                }
            }
            elseif ($c -eq 'Get-MgContext') {
                Set-Item -Path "function:script:$c" -Value { [PSCustomObject]@{ Scopes = @() } }
            }
            elseif ($c -eq 'Get-ConnectionInformation') {
                Set-Item -Path "function:script:$c" -Value { @([PSCustomObject]@{ State = 'Connected'; IsEopSession = $false }, [PSCustomObject]@{ State = 'Connected'; IsEopSession = $true }) }
            }
            elseif ($c -eq 'Invoke-PowerBIRestMethod') {
                Set-Item -Path "function:script:$c" -Value { param($Url, $Method, $Body, $ContentType) if ($Method -ne 'Get') { $FakeWrites.Add("$Method $Url") }; '{"tenantSettings":[]}' }
            }
            elseif ($c -match '^Get-') {
                Set-Item -Path "function:script:$c" -Value { [PSCustomObject]@{ Name = 'fake'; Identity = 'fake' } }
            }
            else {
                Set-Item -Path "function:script:$c" -Value ([scriptblock]::Create("`$FakeWrites.Add('$c')"))
            }
        }
        $script:splat = Get-FakeArgumentSet -Ast $ast
    }

    It 'runs without script errors and writes nothing' {
        $FakeWrites.Clear()
        $splat = $script:splat
        $results = @(& $Path @splat -WhatIf -WarningAction SilentlyContinue)
        $results | Should -Not -BeNullOrEmpty
        foreach ($r in $results) {
            # A read can legitimately fail against empty fake data (no such
            # Power BI setting, no PIM policy, preset not turned on). That is
            # a reported outcome; a script bug (unknown command, bad
            # parameter) is not.
            if ($r.Status -eq 'Failed') {
                $r.Message | Should -Match '^Could not read current state' -Because "$($r.Target): $($r.Message)"
                $r.Message | Should -Not -Match 'is not recognized|parameter cannot be found|positional parameter|Cannot bind|Cannot convert' -Because "$($r.Target): $($r.Message)"
            }
            else {
                $r.Status | Should -BeIn @('WhatIf', 'AlreadyCompliant') -Because "$($r.Target): $($r.Message)"
            }
        }
        $FakeWrites | Should -HaveCount 0 -Because "WhatIf wrote: $($FakeWrites -join ', ')"
    }

    It 'does not read $PSCmdlet inside step script blocks' {
        $text = Get-Content -Path $Path -Raw
        $uses = [regex]::Matches($text, '\$PSCmdlet[.\w]*').Count
        $allowed = [regex]::Matches($text, 'Invoke-RemediationStep -Cmdlet \$PSCmdlet|= \$PSCmdlet\.ParameterSetName').Count
        $uses | Should -Be $allowed
    }
}
