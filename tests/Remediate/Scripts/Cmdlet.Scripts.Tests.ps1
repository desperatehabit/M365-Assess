BeforeDiscovery {
    # Scripts whose tenant calls are only Get-<Noun> / Set-<Noun> pairs (Teams,
    # Exchange Online, SharePoint, Security & Compliance) and that take no
    # mandatory parameters can be exercised generically against an in-memory
    # store keyed by noun.
    $moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../src/M365-Assess')).Path
    $helperAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $moduleRoot 'Remediate/Scripts/Common/RemediationScriptHelper.ps1'), [ref]$null, [ref]$null)
    $helperCommands = @($helperAst.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) | ForEach-Object { $_.Name })
    $builtIn = @('Join-Path', 'Write-Warning', 'ForEach-Object', 'Where-Object', 'Sort-Object', 'Select-Object')
    $script:cmdletCases = @(Get-ChildItem -Path (Join-Path $moduleRoot 'Remediate/Scripts') -Filter '*.ps1' -Recurse |
            Where-Object { $_.Directory.Name -ne 'Common' } |
            ForEach-Object {
                $ast = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$null)
                $mandatory = @($ast.ParamBlock.Parameters | Where-Object {
                        $_.Attributes.NamedArguments | Where-Object { $_.ArgumentName -eq 'Mandatory' }
                    })
                $commands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) |
                        ForEach-Object { $_.GetCommandName() } | Where-Object { $_ } | Sort-Object -Unique |
                        Where-Object { $helperCommands -notcontains $_ -and $builtIn -notcontains $_ })
                $tenant = @($commands | Where-Object { $_ -match '^(Get|Set)-' })
                $other = @($commands | Where-Object { $_ -notmatch '^(Get|Set)-' })
                $sets = @($tenant | Where-Object { $_ -like 'Set-*' })
                if ($mandatory.Count -eq 0 -and $other.Count -eq 0 -and $sets.Count -gt 0) {
                    @{
                        Path     = $_.FullName
                        CheckId  = $_.BaseName
                        Nouns    = @($tenant | ForEach-Object { $_ -replace '^(Get|Set)-', '' } | Sort-Object -Unique)
                        Services = @([regex]::Matches((Get-Content -Path $_.FullName -Raw), "Assert-RemediationConnection -Service ([^\r\n]+)") |
                                ForEach-Object { $_.Groups[1].Value })
                    }
                }
            })
}

BeforeAll {
    $FakeStore = @{}

    function Get-FakeObject {
        param([string]$Noun)
        if (-not $FakeStore.ContainsKey($Noun)) { $FakeStore[$Noun] = @{} }
        [PSCustomObject]$FakeStore[$Noun]
    }

    function Set-FakeObject {
        param([string]$Noun, [object[]]$Arguments)
        if (-not $FakeStore.ContainsKey($Noun)) { $FakeStore[$Noun] = @{} }
        for ($i = 0; $i -lt $Arguments.Count; $i++) {
            $token = $Arguments[$i]
            if ($token -is [string] -and $token -match '^-(\w+):?$') {
                $name = $Matches[1]
                $value = $true
                if ($i + 1 -lt $Arguments.Count -and -not ($Arguments[$i + 1] -is [string] -and $Arguments[$i + 1] -match '^-\w+:?$')) {
                    $value = $Arguments[$i + 1]
                    $i++
                }
                if ($name -notin @('Identity', 'Confirm', 'ErrorAction', 'WarningAction', 'Force')) {
                    $FakeStore[$Noun][$name] = $value
                }
            }
        }
    }

    # Service connection fakes.
    function Get-ConnectionInformation {
        @([PSCustomObject]@{ State = 'Connected'; IsEopSession = $false }, [PSCustomObject]@{ State = 'Connected'; IsEopSession = $true })
    }
    function Get-CsTenant { [PSCustomObject]@{ TenantId = 'fake' } }
    function Get-SPOTenant { [PSCustomObject]$FakeStore['SPOTenant'] }
    function Get-MgContext { [PSCustomObject]@{ Scopes = @() } }
}

Describe 'Cmdlet script <CheckId> against a simulated tenant' -ForEach $script:cmdletCases {
    BeforeAll {
        foreach ($noun in $Nouns) {
            $n = $noun
            Set-Item -Path "function:script:Get-$n" -Value ([scriptblock]::Create("Get-FakeObject -Noun '$n'"))
            Set-Item -Path "function:script:Set-$n" -Value ([scriptblock]::Create("Set-FakeObject -Noun '$n' -Arguments `$args"))
        }
    }

    BeforeEach {
        $FakeStore.Clear()
        $FakeStore['SPOTenant'] = @{}
    }

    It 'does not write under -WhatIf' {
        $results = @(& $Path -WhatIf)
        $results.Status | Should -Not -Contain 'Failed'
        $results.Status | Should -Not -Contain 'Applied'
        @($FakeStore.Keys | Where-Object { $_ -ne 'SPOTenant' -and $FakeStore[$_].Count -gt 0 }) | Should -HaveCount 0
    }

    It 'ends compliant after apply, with every step Applied or AlreadyCompliant' {
        $results = @(& $Path -Confirm:$false)
        $results | Should -Not -BeNullOrEmpty
        foreach ($r in $results) {
            $r.Status | Should -BeIn @('Applied', 'AlreadyCompliant') -Because "$($r.Target): $($r.Message)"
        }
        # Steps marked SkipVerify apply asynchronous changes that the fakes
        # cannot reflect; only check the re-read for the others.
        $asyncTargets = @($results | Where-Object { $_.Message -match 'verification skipped' } | ForEach-Object { $_.Target })
        foreach ($r in @(& $Path -WhatIf | Where-Object { $asyncTargets -notcontains $_.Target })) {
            $r.Status | Should -Be 'AlreadyCompliant' -Because "$($r.Target) should be compliant after apply"
        }
    }
}
