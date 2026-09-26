BeforeAll {
    $script:repoRoot = (Resolve-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
    $script:sandboxHandler = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/Invoke-SandboxedScript.ps1'
    $script:workerModule = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/M365Portal.Workers.psm1'

    Import-Module -Name $script:workerModule -Force
}

AfterAll {
    Remove-Module -Name 'M365Portal.Workers' -ErrorAction SilentlyContinue
}

Describe 'Invoke-SandboxedScript constrained child sandbox (T-0126)' {

    Context 'the worker layout' {
        It 'exists alongside the worker module' {
            Test-Path -LiteralPath $script:sandboxHandler | Should -BeTrue
            Test-Path -LiteralPath $script:workerModule | Should -BeTrue
        }

        It 'exports the sandbox handler and the policy check from the module' {
            $exported = (Get-Module -Name 'M365Portal.Workers').ExportedFunctions.Keys
            $exported | Should -Contain 'Invoke-SandboxedScript'
            $exported | Should -Contain 'Test-SandboxedScript'
        }

        It 'never evaluates untrusted input as code or through a shell' {
            $source = Get-Content -LiteralPath $script:sandboxHandler -Raw
            $source | Should -Not -Match 'Invoke-Expression'
            $source | Should -Match 'InitialSessionState'
            $source | Should -Match 'ConstrainedLanguage'
            $source | Should -Match 'ArgumentList'
        }
    }

    Context 'an allowed script' {
        It 'runs and returns its output' {
            $result = Invoke-SandboxedScript -ScriptContent "Write-Output 'hello-sandbox-42'"

            $result.Success | Should -BeTrue
            $result.Output | Should -Match 'hello-sandbox-42'
            $result.ExitCode | Should -Be 0
            $result.TimedOut | Should -BeFalse
        }

        It 'runs pure-compute scripts with common types and cmdlets' {
            $script = @'
$items = 1..5 | ForEach-Object { $_ * 2 }
$picked = $items | Where-Object { $_ -gt 4 } | Sort-Object
$record = @{ total = ($picked | Measure-Object -Sum).Sum }
$record | ConvertTo-Json -Compress
'@
            $result = Invoke-SandboxedScript -ScriptContent $script

            $result.Success | Should -BeTrue
            $result.Output | Should -Match '"total":24'
        }

        It 'passes arguments into the sandbox as variables' {
            $result = Invoke-SandboxedScript -ScriptContent 'Write-Output "hello $Name"' -Arguments @{ Name = 'sandbox-world' }

            $result.Success | Should -BeTrue
            $result.Output | Should -Match 'hello sandbox-world'
        }

        It 'admits a clean script through the policy check' {
            $violations = @(Test-SandboxedScript -ScriptContent "Write-Output 'hi'")

            $violations.Count | Should -Be 0
        }
    }

    Context 'fail-closed admission policy' {
        It 'rejects a disallowed filesystem cmdlet before execution' {
            { Invoke-SandboxedScript -ScriptContent "Get-Content -LiteralPath '/etc/hostname'" } | Should -Throw '*sandbox.policy_violation*'
        }

        It 'rejects expression evaluation on untrusted input' {
            { Invoke-SandboxedScript -ScriptContent "Invoke-Expression 'Write-Output 1'" } | Should -Throw '*sandbox.policy_violation*'
        }

        It 'rejects process and network cmdlets' {
            { Invoke-SandboxedScript -ScriptContent "Start-Process -FilePath 'pwsh'" } | Should -Throw '*sandbox.policy_violation*'
            { Invoke-SandboxedScript -ScriptContent "Invoke-WebRequest -Uri 'https://example.invalid'" } | Should -Throw '*sandbox.policy_violation*'
        }

        It 'rejects a disallowed .NET type' {
            { Invoke-SandboxedScript -ScriptContent "[System.IO.File]::ReadAllText('/etc/hostname')" } | Should -Throw '*sandbox.policy_violation*'
        }

        It 'rejects the pscustomobject cast up front because the constrained runspace cannot construct it' {
            { Invoke-SandboxedScript -ScriptContent '[pscustomobject]@{ total = 1 }' } | Should -Throw '*sandbox.policy_violation*disallowed type*'
        }

        It 'rejects reflection-style member access' {
            { Invoke-SandboxedScript -ScriptContent '$x.GetType().FullName' } | Should -Throw '*sandbox.policy_violation*'
        }

        It 'rejects call-operator invocation even for allowlisted names' {
            { Invoke-SandboxedScript -ScriptContent "& 'Write-Output' 'hi'" } | Should -Throw '*sandbox.policy_violation*'
        }

        It 'rejects scripts with syntax errors instead of running them' {
            { Invoke-SandboxedScript -ScriptContent "Write-Output 'unclosed" } | Should -Throw '*sandbox.policy_violation*'
        }

        It 'never runs a rejected script, so it has no side effects' {
            $sentinel = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ('m365-sandbox-sentinel-{0}.txt' -f [guid]::NewGuid().ToString('N'))
            $script = "[System.IO.File]::WriteAllText('$sentinel', 'pwned')"

            { Invoke-SandboxedScript -ScriptContent $script } | Should -Throw '*sandbox.policy_violation*'
            Test-Path -LiteralPath $sentinel | Should -BeFalse
        }

        It 'reports a script runtime error as failed' {
            { Invoke-SandboxedScript -ScriptContent "Write-Error 'boom-sandbox'" } | Should -Throw '*sandbox.failed*'
        }

        It 'rejects a missing script file without spawning a child' {
            { Invoke-SandboxedScript -ScriptPath '/definitely/not/here.ps1' } | Should -Throw '*sandbox.invalid_input*'
        }
    }

    Context 'resource limits' {
        It 'kills a runaway script at the timeout and leaves no child behind' {
            $started = [DateTime]::UtcNow

            { Invoke-SandboxedScript -ScriptContent 'while ($true) { }' -TimeoutSec 3 } | Should -Throw '*sandbox.timeout*'

            $elapsed = [DateTime]::UtcNow - $started
            $elapsed.TotalSeconds | Should -BeLessThan 60
            $lingering = @((& ps -eo args) | Where-Object { $_ -match 'm365-sandbox-.*harness' })
            $lingering.Count | Should -Be 0
        }
    }
}
