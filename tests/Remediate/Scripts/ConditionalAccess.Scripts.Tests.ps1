BeforeDiscovery {
    # Every Conditional Access template (scripts built on Set-RemediationCaPolicy)
    # is run against an in-memory CA policy store: it must create the policy in
    # report-only state by default, then report AlreadyCompliant on re-run, and
    # switch state when -PolicyState is changed.
    $moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../src/M365-Assess')).Path
    $script:caCases = @(Get-ChildItem -Path (Join-Path $moduleRoot 'Remediate/Scripts') -Filter '*.ps1' -Recurse |
            Where-Object { $_.Directory.Name -ne 'Common' -and (Get-Content -Path $_.FullName -Raw) -match 'Set-RemediationCaPolicy' } |
            ForEach-Object { @{ Path = $_.FullName; CheckId = $_.BaseName } })
}

BeforeAll {
    $FakeCa = [System.Collections.Generic.List[hashtable]]::new()

    function Get-MgContext { [PSCustomObject]@{ Scopes = @() } }

    function Invoke-MgGraphRequest {
        param($Method, $Uri, $Body, $ContentType, $OutputType)
        if ($Uri -like '/v1.0/identity/conditionalAccess/policies*') {
            switch ($Method) {
                'GET' {
                    $list = @($FakeCa | ForEach-Object { $_ | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable })
                    return @{ value = $list }
                }
                'POST' {
                    $p = $Body | ConvertFrom-Json -AsHashtable
                    $p['id'] = [guid]::NewGuid().ToString()
                    $FakeCa.Add($p)
                    return $p
                }
                'PATCH' {
                    $id = ($Uri -split '/')[-1]
                    $p = $FakeCa | Where-Object { $_['id'] -eq $id }
                    $patch = $Body | ConvertFrom-Json -AsHashtable
                    foreach ($k in $patch.Keys) { $p[$k] = $patch[$k] }
                    return
                }
            }
        }
        @{ value = @() }
    }

    function Get-MandatoryArgument {
        param([string]$Path)
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$null, [ref]$null)
        $splat = @{}
        foreach ($p in @($ast.ParamBlock.Parameters)) {
            $isMandatory = $p.Attributes | Where-Object { $_.TypeName.Name -eq 'Parameter' } |
                Where-Object { $_.NamedArguments | Where-Object { $_.ArgumentName -eq 'Mandatory' } }
            if ($isMandatory) { $splat[$p.Name.VariablePath.UserPath] = @('11111111-2222-3333-4444-555555555555') }
        }
        $splat
    }
}

Describe 'CA template <CheckId> against a simulated policy store' -ForEach $script:caCases {
    BeforeEach { $FakeCa.Clear() }

    It 'creates the policy report-only by default and is then compliant' {
        $splat = Get-MandatoryArgument -Path $Path
        $created = @(& $Path @splat -Confirm:$false)
        $created[-1].Status | Should -Be 'Applied' -Because $created[-1].Message
        $FakeCa | Should -HaveCount 1
        $FakeCa[0]['state'] | Should -Be 'enabledForReportingButNotEnforced'
        @(& $Path @splat -WhatIf)[-1].Status | Should -Be 'AlreadyCompliant'
    }

    It 'excludes the break-glass accounts when the template takes them' {
        $splat = Get-MandatoryArgument -Path $Path
        $null = & $Path @splat -Confirm:$false
        if ($splat.ContainsKey('BreakGlassAccountId')) {
            @($FakeCa[0]['conditions']['users']['excludeUsers']) | Should -Contain '11111111-2222-3333-4444-555555555555'
        }
    }

    It 'updates the existing policy in place when -PolicyState changes' {
        $splat = Get-MandatoryArgument -Path $Path
        $null = & $Path @splat -Confirm:$false
        $result = @(& $Path @splat -PolicyState enabled -Confirm:$false)
        $result[-1].Status | Should -Be 'Applied'
        $FakeCa | Should -HaveCount 1
        $FakeCa[0]['state'] | Should -Be 'enabled'
    }
}
