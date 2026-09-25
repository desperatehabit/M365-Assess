BeforeDiscovery {
    # Nothing needed at discovery time
}

BeforeAll {
    $script:scriptPath = "$PSScriptRoot/../src/M365-Assess/Invoke-M365Assessment.ps1"
    # Normalize to absolute path
    $script:scriptPath = [System.IO.Path]::GetFullPath($script:scriptPath)
    $script:ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $script:scriptPath, [ref]$null, [ref]$null
    )
}

Describe 'Invoke-M365Assessment - syntax and structure' {
    It 'script file exists' {
        Test-Path -Path $script:scriptPath | Should -Be $true
    }

    It 'parses without syntax errors' {
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile(
            $script:scriptPath, [ref]$null, [ref]$errors
        ) | Out-Null
        $errors | Should -BeNullOrEmpty
    }

    It 'has comment-based help with .SYNOPSIS' {
        $scriptContent = Get-Content -Path $script:scriptPath -Raw
        $scriptContent | Should -Match '\.SYNOPSIS'
    }

    It 'has comment-based help with .DESCRIPTION' {
        $scriptContent = Get-Content -Path $script:scriptPath -Raw
        $scriptContent | Should -Match '\.DESCRIPTION'
    }

    It 'has a -DryRun switch parameter' {
        $paramBlock = $script:ast.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.ParameterAst] },
            $true
        )
        $dryRunParam = $paramBlock | Where-Object { $_.Name.VariablePath.UserPath -eq 'DryRun' }
        $dryRunParam | Should -Not -BeNullOrEmpty
    }

    It 'has a -SkipConnection switch parameter' {
        $paramBlock = $script:ast.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.ParameterAst] },
            $true
        )
        $param = $paramBlock | Where-Object { $_.Name.VariablePath.UserPath -eq 'SkipConnection' }
        $param | Should -Not -BeNullOrEmpty
    }

    It 'has a -HeadlineFramework parameter (#963)' {
        $paramBlock = $script:ast.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.ParameterAst] },
            $true
        )
        $param = $paramBlock | Where-Object { $_.Name.VariablePath.UserPath -eq 'HeadlineFramework' }
        $param | Should -Not -BeNullOrEmpty
    }

    It 'validates -HeadlineFramework ids via Import-FrameworkDefinitions (#963)' {
        $scriptContent = Get-Content -Path $script:scriptPath -Raw
        $scriptContent | Should -Match 'Unknown -HeadlineFramework'
        $scriptContent | Should -Match 'Import-FrameworkDefinitions'
    }

    It 'has a -TenantId parameter' {
        $paramBlock = $script:ast.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.ParameterAst] },
            $true
        )
        $param = $paramBlock | Where-Object { $_.Name.VariablePath.UserPath -eq 'TenantId' }
        $param | Should -Not -BeNullOrEmpty
    }

    It 'has a -Section parameter' {
        $paramBlock = $script:ast.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.ParameterAst] },
            $true
        )
        $param = $paramBlock | Where-Object { $_.Name.VariablePath.UserPath -eq 'Section' }
        $param | Should -Not -BeNullOrEmpty
    }

    It 'has a -OutputFolder parameter' {
        $paramBlock = $script:ast.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.ParameterAst] },
            $true
        )
        $param = $paramBlock | Where-Object { $_.Name.VariablePath.UserPath -eq 'OutputFolder' }
        $param | Should -Not -BeNullOrEmpty
    }

    It 'has a -NonInteractive switch parameter' {
        $paramBlock = $script:ast.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.ParameterAst] },
            $true
        )
        $param = $paramBlock | Where-Object { $_.Name.VariablePath.UserPath -eq 'NonInteractive' }
        $param | Should -Not -BeNullOrEmpty
    }

    # Issue #809: -SaveBaseline is a switch (was [string]). PowerShell parameter
    # binding does not allow a single non-switch param to accept both `-X` (no value)
    # and `-X 'foo'` (string value). The two-param shape is the cleanest fix:
    #   -SaveBaseline                       -> auto label 'manual-<timestamp>'
    #   -SaveBaseline -BaselineLabel 'foo'  -> custom label 'foo'
    It '-SaveBaseline is declared as [switch]' {
        $paramBlock = $script:ast.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.ParameterAst] },
            $true
        )
        $param = $paramBlock | Where-Object { $_.Name.VariablePath.UserPath -eq 'SaveBaseline' }
        $param | Should -Not -BeNullOrEmpty
        $typeAttr = $param.Attributes | Where-Object { $_ -is [System.Management.Automation.Language.TypeConstraintAst] }
        $typeAttr.TypeName.Name | Should -Be 'switch' -Because '-SaveBaseline must be a switch so it accepts the bare-flag form'
    }

    It '-BaselineLabel is declared as [string]' {
        $paramBlock = $script:ast.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.ParameterAst] },
            $true
        )
        $param = $paramBlock | Where-Object { $_.Name.VariablePath.UserPath -eq 'BaselineLabel' }
        $param | Should -Not -BeNullOrEmpty -Because 'a separate -BaselineLabel param carries the optional custom label'
        $typeAttr = $param.Attributes | Where-Object { $_ -is [System.Management.Automation.Language.TypeConstraintAst] }
        $typeAttr.TypeName.Name | Should -Be 'string'
    }

    It 'requires PowerShell 7.0 or higher' {
        $scriptContent = Get-Content -Path $script:scriptPath -Raw
        $scriptContent | Should -Match '#Requires -Version 7'
    }
}

Describe 'Invoke-M365Assessment - parameter validation' {
    It 'DryRun is a switch type parameter' {
        $paramBlock = $script:ast.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.ParameterAst] },
            $true
        )
        $dryRunParam = $paramBlock | Where-Object { $_.Name.VariablePath.UserPath -eq 'DryRun' }
        $dryRunParam | Should -Not -BeNullOrEmpty
        # Switch parameters have a [switch] type constraint or no type (defaults to object)
        $typeConstraints = $dryRunParam.Attributes | Where-Object { $_ -is [System.Management.Automation.Language.TypeConstraintAst] }
        if ($typeConstraints) {
            $typeNames = $typeConstraints | ForEach-Object { $_.TypeName.Name }
            $typeNames | Should -Contain 'switch'
        }
    }

    It 'NonInteractive is a switch type parameter' {
        $paramBlock = $script:ast.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.ParameterAst] },
            $true
        )
        $param = $paramBlock | Where-Object { $_.Name.VariablePath.UserPath -eq 'NonInteractive' }
        $param | Should -Not -BeNullOrEmpty
        $typeConstraints = $param.Attributes | Where-Object { $_ -is [System.Management.Automation.Language.TypeConstraintAst] }
        if ($typeConstraints) {
            $typeNames = $typeConstraints | ForEach-Object { $_.TypeName.Name }
            $typeNames | Should -Contain 'switch'
        }
    }
}

Describe 'Invoke-M365Assessment - RunContext (T-0003)' {
    BeforeAll {
        $script:functionAst = $script:ast.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                    $node.Name -eq 'Invoke-M365Assessment'
            },
            $true
        ) | Select-Object -First 1

        $script:ctxParamsAssign = $script:functionAst.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
                    $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
                    $node.Left.VariablePath.UserPath -eq 'ctxParams'
            },
            $true
        ) | Select-Object -First 1

        $script:content = Get-Content -Path $script:scriptPath -Raw

        . "$PSScriptRoot/../src/M365-Assess/Common/RunContext.ps1"
    }

    It 'builds exactly one RunContext per run' {
        $calls = $script:functionAst.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.CommandAst] -and
                    $node.GetCommandName() -eq 'New-RunContext'
            },
            $true
        )
        $calls.Count | Should -Be 1 -Because 'one context per invocation is the T-0003 contract'
    }

    It 'threads the context into Connect-RequiredService' {
        $calls = $script:functionAst.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.CommandAst] -and
                    $node.GetCommandName() -eq 'Connect-RequiredService'
            },
            $true
        )
        $calls.Count | Should -BeGreaterThan 0
        foreach ($call in $calls) {
            $paramNames = @($call.CommandElements |
                Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } |
                ForEach-Object { $_.ParameterName })
            $paramNames | Should -Contain 'Context'
        }
    }

    It 'builds the context from the CLI parameters' {
        $script:ctxParamsAssign | Should -Not -BeNullOrEmpty
        $hashtable = $script:ctxParamsAssign.Right.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.HashtableAst] },
            $true
        ) | Select-Object -First 1
        $keys = @($hashtable.KeyValuePairs | ForEach-Object { $_.Item1.Value })
        foreach ($key in @('TenantId', 'Auth', 'Sections', 'OutputFolder', 'Timestamp', 'GraphScopes', 'SectionScopeMap')) {
            $keys | Should -Contain $key
        }
    }

    It 'adopts the context assessment folder for CLI output layout' {
        $script:content | Should -Match '\$assessmentFolder\s*=\s*\$ctx\.Output\.AssessmentFolder'
        $script:content | Should -Match '\$ctx\.Output\.LogFilePath'
    }

    It 'derives the historical assessment folder and domain prefix' {
        $ctxParams = @{
            TenantId     = 'contoso.onmicrosoft.com'
            Timestamp    = '20260101_120000'
            OutputFolder = '.\M365-Assessment'
            Sections     = @('Tenant', 'Identity')
        }
        $ctx = New-RunContext @ctxParams
        $ctx.Output.DomainPrefix | Should -Be 'contoso'
        $ctx.Output.AssessmentFolder | Should -Match 'Assessment_20260101_120000_contoso$'
        $ctx.Output.LogFileName | Should -Be '_Assessment-Log_contoso.txt'
    }

    It 'routes service and issue state through the context' {
        $script:content | Should -Not -Match '\$connectedServices'
        $script:content | Should -Not -Match '\$failedServices'
        $script:content | Should -Not -Match '\$issues\.'
    }

    It 'preserves the default section set and dispatch order' {
        $sectionParam = $script:functionAst.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.ParameterAst] -and
                    $node.Name.VariablePath.UserPath -eq 'Section'
            },
            $true
        ) | Select-Object -First 1
        $defaultSections = @($sectionParam.DefaultValue.SafeGetValue())
        $defaultSections | Should -Be @('Tenant', 'Identity', 'Licensing', 'Email', 'Intune', 'Security', 'Collaboration', 'PowerBI', 'Hybrid')

        $orderAssign = $script:functionAst.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
                    $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
                    $node.Left.VariablePath.UserPath -eq 'sectionOrder'
            },
            $true
        ) | Select-Object -First 1
        $orderArray = $orderAssign.Right.FindAll(
            { param($node) $node -is [System.Management.Automation.Language.ArrayLiteralAst] },
            $true
        ) | Select-Object -First 1
        $dispatchOrder = @($orderArray.Elements | ForEach-Object { $_.Value })
        $dispatchOrder | Should -Be @('Tenant', 'Identity', 'Licensing', 'Email', 'Intune',
            'Inventory', 'Security', 'Collaboration', 'PowerBI', 'Hybrid',
            'ActiveDirectory', 'SOC2', 'ValueOpportunity')
    }
}

Describe 'Invoke-M365Assessment - PowerBI child process credential handling (T-0005)' {
    BeforeAll {
        $script:content = Get-Content -Path $script:scriptPath -Raw
        $script:functionAst = $script:ast.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                    $node.Name -eq 'Invoke-M365Assessment'
            },
            $true
        ) | Select-Object -First 1
    }

    It 'does not serialize a plaintext secret into the generated child script' {
        $script:content | Should -Not -Match "ConvertTo-SecureString\s+'\$" `
            -Because 'the secret must never be embedded as a literal in the temp script'
        $script:content | Should -Not -Match 'plainSecret'
    }

    It 'passes the secret to the child through an environment variable' {
        $script:content | Should -Match '\$env:M365ASSESS_PBI_SECRET\s*=\s*\$childSecretPlain'
        $script:content | Should -Match 'ConvertTo-SecureString `\$env:M365ASSESS_PBI_SECRET -AsPlainText'
    }

    It 'has no literal secret in the ClientSecret script line' {
        $secretLine = @($script:content -split "`n" |
            Where-Object { $_ -match 'connectParams\[.ClientSecret.\]' })
        $secretLine | Should -Not -BeNullOrEmpty
        foreach ($line in $secretLine) {
            $line | Should -Not -Match "ConvertTo-SecureString\s+'[^']" `
                -Because 'the ClientSecret script line must read from the environment, not a literal'
            $line | Should -Match '\$env:M365ASSESS_PBI_SECRET'
        }
    }

    It 'scrubs and removes temp artifacts in a finally block' {
        $finallyBlocks = $script:functionAst.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.TryStatementAst] -and
                    $null -ne $node.Finally
            },
            $true
        )
        $cleanup = @($finallyBlocks | ForEach-Object { $_.Finally.Extent.Text } |
            Where-Object { $_ -match 'childScriptFile' })
        $cleanup | Should -Not -BeNullOrEmpty -Because 'the temp script must be cleaned up on every exit path'
        foreach ($block in $cleanup) {
            $block | Should -Match 'Remove-Item'
        }
    }

    It 'redacts the secret from child stderr before logging' {
        $script:content | Should -Match 'Get-RedactedText -Text \$childStderrContent -Secret \$childSecretPlain'
        $script:content | Should -Match 'Get-RedactedText -Text \$errDetail -Secret \$childSecretPlain'
    }

    It 'defines Get-RedactedText helper that masks a supplied secret' {
        $script:content | Should -Match 'function Get-RedactedText'
        $helperAst = $script:ast.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                    $node.Name -eq 'Get-RedactedText'
            },
            $true
        ) | Select-Object -First 1
        $helperAst | Should -Not -BeNullOrEmpty
        $helperBlock = [scriptblock]::Create($helperAst.Extent.Text)
        . $helperBlock
        $redacted = Get-RedactedText -Text 'failed with abc-123-secret in message' -Secret 'abc-123-secret'
        $redacted | Should -Not -Match 'abc-123-secret'
        $redacted | Should -Match '<redacted>'
    }
}
