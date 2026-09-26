# Invoke-SandboxedScript runs operator-authored custom scripts inside a sandbox (EPIC-007
# SPEC.md section 4.3 step 4, section 8, and section 11 open question 2).
# The sandbox is a constrained pwsh child process: the script text is statically checked
# against a cmdlet/type allowlist and rejected before execution when it cannot be sandboxed,
# then runs in a ConstrainedLanguage runspace that only knows the allowlisted cmdlets, with
# no providers and no extra assemblies. The parent enforces wall-clock, CPU, and memory
# bounds and kills the child on violation. Script text travels via files and the child is
# spawned with ArgumentList, so untrusted input is never evaluated as code or passed to a
# shell. Writes performed by a script must route through the EPIC-006 remediation contract;
# this file provides the sandbox execution primitive only.

$script:SandboxAllowedCmdlets = @(
    'Clear-Variable',
    'Compare-Object',
    'ConvertFrom-Csv',
    'ConvertFrom-Json',
    'ConvertFrom-StringData',
    'ConvertTo-Csv',
    'ConvertTo-Html',
    'ConvertTo-Json',
    'ForEach-Object',
    'Format-List',
    'Format-Table',
    'Format-Wide',
    'Get-Date',
    'Get-Random',
    'Get-Variable',
    'Group-Object',
    'Join-String',
    'Measure-Object',
    'New-Guid',
    'New-TimeSpan',
    'New-Variable',
    'Out-Null',
    'Out-String',
    'Remove-Variable',
    'Select-Object',
    'Set-Variable',
    'Sort-Object',
    'Where-Object',
    'Write-Error',
    'Write-Information',
    'Write-Output',
    'Write-Progress',
    'Write-Verbose',
    'Write-Warning'
)

# pscustomobject/psobject are deliberately absent: a programmatic ConstrainedLanguage
# runspace cannot construct them via a cast, so admitting them would only fail later at
# runtime. Scripts shape structured output with hashtables or Select-Object instead.
$script:SandboxAllowedTypes = @(
    'array',
    'bool',
    'boolean',
    'byte',
    'char',
    'datetime',
    'decimal',
    'double',
    'guid',
    'hashtable',
    'int',
    'int16',
    'int32',
    'int64',
    'long',
    'object',
    'ordered',
    'ordereddictionary',
    'regex',
    'sbyte',
    'short',
    'single',
    'string',
    'switch',
    'switchparameter',
    'system.array',
    'system.boolean',
    'system.byte',
    'system.char',
    'system.collections.hashtable',
    'system.collections.specialized.ordereddictionary',
    'system.datetime',
    'system.decimal',
    'system.double',
    'system.guid',
    'system.int16',
    'system.int32',
    'system.int64',
    'system.management.automation.switchparameter',
    'system.object',
    'system.sbyte',
    'system.single',
    'system.string',
    'system.text.regularexpressions.regex',
    'system.timespan',
    'system.uint16',
    'system.uint32',
    'system.uint64',
    'system.version',
    'system.void',
    'timespan',
    'uint16',
    'uint32',
    'uint64',
    'version',
    'void'
)

$script:SandboxDeniedMembers = @(
    'activator',
    'createcomobject',
    'createinstance',
    'getassemblies',
    'getassembly',
    'getcurrentmethod',
    'getfield',
    'getfields',
    'getmethod',
    'getmethods',
    'getproperties',
    'getproperty',
    'gettype',
    'gettypefromclsid',
    'invoke',
    'invokemember',
    'load',
    'loadfile',
    'loadfrom'
)

$script:SandboxHarnessTemplate = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [string]$OutputPath,

    [Parameter()]
    [string]$AllowedCmdlets = '',

    [Parameter()]
    [string]$VariablesJson = ''
)

$scriptText = Get-Content -LiteralPath $ScriptPath -Raw -Encoding UTF8
$sessionState = [System.Management.Automation.Runspaces.InitialSessionState]::Create()
$sessionState.LanguageMode = [System.Management.Automation.PSLanguageMode]::ConstrainedLanguage
foreach ($name in ($AllowedCmdlets -split ',')) {
    $trimmed = $name.Trim()
    if (-not $trimmed) {
        continue
    }
    $cmdlet = Get-Command -Name $trimmed -CommandType Cmdlet -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $cmdlet) {
        $sessionState.Commands.Add([System.Management.Automation.Runspaces.SessionStateCmdletEntry]::new($cmdlet.Name, $cmdlet.ImplementingType, $null))
    }
}
$runspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace($sessionState)
$runspace.Open()
try {
    if ($VariablesJson.Trim()) {
        $variables = $VariablesJson | ConvertFrom-Json -AsHashtable
        foreach ($key in $variables.Keys) {
            $runspace.SessionStateProxy.SetVariable($key, $variables[$key])
        }
    }
    $engine = [System.Management.Automation.PowerShell]::Create()
    try {
        $engine.Runspace = $runspace
        $null = $engine.AddScript($scriptText)
        $results = $null
        $failed = $false
        $failure = ''
        try {
            $results = $engine.Invoke()
        }
        catch {
            $failed = $true
            $failure = $_.Exception.Message
        }
        $errorLines = @()
        foreach ($record in $engine.Streams.Error) {
            $errorLines += $record.ToString()
        }
        if ($engine.HadErrors -and -not $failed) {
            $failed = $true
            $failure = ($errorLines -join "`n")
        }
        $outputLines = @()
        foreach ($item in $results) {
            if ($null -ne $item) {
                $outputLines += "$item"
            }
        }
        $payload = [ordered]@{
            success = (-not $failed)
            output  = @($outputLines)
            error   = "$failure"
        }
        $payload | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
    }
    finally {
        $engine.Dispose()
    }
}
finally {
    $runspace.Close()
    $runspace.Dispose()
}
'@

function Test-SandboxTypeName {
    <#
    .SYNOPSIS
        Checks one parser-reported type name against the sandbox type allowlist.
    .DESCRIPTION
        Normalizes assembly-qualified, array, and System-prefixed spellings to a
        comparable form and matches case-insensitively against the allowlist. Anything
        not explicitly listed is denied so new framework types fail closed.
    .PARAMETER FullName
        The TypeName.FullName reported by the parser for one type literal.
    .PARAMETER AllowedTypes
        Type allowlist override. Defaults to the sandbox type allowlist.
    .EXAMPLE
        Test-SandboxTypeName -FullName 'System.IO.File'
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$FullName,

        [Parameter()]
        [string[]]$AllowedTypes = @()
    )

    if (-not $AllowedTypes -or $AllowedTypes.Count -eq 0) {
        $AllowedTypes = $script:SandboxAllowedTypes
    }
    $candidate = $FullName.Split(',')[0].Trim().ToLowerInvariant()
    if (-not $candidate) {
        return $false
    }
    if ($AllowedTypes -contains $candidate) {
        return $true
    }
    $element = $candidate
    if ($element.EndsWith('[]')) {
        $element = $element.Substring(0, ($element.Length - 2))
    }
    if ($AllowedTypes -contains $element) {
        return $true
    }
    $short = $element
    $dot = $short.LastIndexOf('.')
    if ($dot -ge 0) {
        $short = $short.Substring($dot + 1)
    }
    return ($AllowedTypes -contains $short)
}

function Test-SandboxedScript {
    <#
    .SYNOPSIS
        Checks a custom script against the sandbox admit/deny policy without running it.
    .DESCRIPTION
        Parses -ScriptContent with the PowerShell parser and fails closed: syntax errors,
        using statements, call/dot-source invocation, dynamically-named commands, commands
        outside the cmdlet allowlist, type literals outside the type allowlist, and
        reflection-style member access are all reported as violations. An empty result
        admits the script to the sandbox; any entry rejects it before execution.
    .PARAMETER ScriptContent
        The custom script text to check.
    .PARAMETER AllowedCmdlets
        Cmdlet allowlist override. Defaults to the sandbox cmdlet allowlist.
    .PARAMETER AllowedTypes
        Type allowlist override. Defaults to the sandbox type allowlist.
    .EXAMPLE
        Test-SandboxedScript -ScriptContent "Write-Output 'hi'"
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$ScriptContent,

        [Parameter()]
        [string[]]$AllowedCmdlets = @(),

        [Parameter()]
        [string[]]$AllowedTypes = @()
    )

    $violations = @()
    if ([string]::IsNullOrWhiteSpace($ScriptContent)) {
        $violations += 'sandbox.invalid_input: script content is empty.'
        return $violations
    }
    if (-not $AllowedCmdlets -or $AllowedCmdlets.Count -eq 0) {
        $AllowedCmdlets = $script:SandboxAllowedCmdlets
    }

    $parseErrors = $null
    $tokens = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($ScriptContent, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        $violations += ('sandbox.policy_violation: script has syntax errors and cannot be sandboxed: {0}' -f $parseErrors[0].Message)
        return $violations
    }
    if ($ast.UsingStatements.Count -gt 0) {
        $violations += 'sandbox.policy_violation: using statements cannot be sandboxed.'
        return $violations
    }

    $commands = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)
    foreach ($command in $commands) {
        if ($command.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown) {
            $violations += ('sandbox.policy_violation: call/dot-source invocation cannot be sandboxed: {0}' -f $command.Extent.Text)
            continue
        }
        $head = $command.CommandElements[0]
        if (-not ($head -is [System.Management.Automation.Language.StringConstantExpressionAst])) {
            $violations += 'sandbox.policy_violation: dynamically-named command invocation cannot be sandboxed.'
            continue
        }
        if ($AllowedCmdlets -notcontains $head.Value) {
            $violations += ('sandbox.policy_violation: disallowed command: {0}' -f $head.Value)
        }
    }

    $typeNodes = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.TypeExpressionAst] }, $true)
    foreach ($typeNode in $typeNodes) {
        if (-not (Test-SandboxTypeName -FullName $typeNode.TypeName.FullName -AllowedTypes $AllowedTypes)) {
            $violations += ('sandbox.policy_violation: disallowed type: {0}' -f $typeNode.TypeName.FullName)
        }
    }

    # Casts such as [pscustomobject]@{...} parse as ConvertExpressionAst carrying a
    # TypeConstraintAst rather than a TypeExpressionAst, so both shapes are checked.
    $constraintNodes = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.TypeConstraintAst] }, $true)
    foreach ($constraintNode in $constraintNodes) {
        if (-not (Test-SandboxTypeName -FullName $constraintNode.TypeName.FullName -AllowedTypes $AllowedTypes)) {
            $violations += ('sandbox.policy_violation: disallowed type: {0}' -f $constraintNode.TypeName.FullName)
        }
    }

    $memberNodes = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.MemberExpressionAst] }, $true)
    foreach ($memberNode in $memberNodes) {
        $memberName = $null
        if ($memberNode.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $memberName = $memberNode.Member.Value
        }
        if (-not $memberName) {
            $violations += 'sandbox.policy_violation: dynamically-named member access cannot be sandboxed.'
            continue
        }
        if ($script:SandboxDeniedMembers -contains $memberName.ToLowerInvariant()) {
            $violations += ('sandbox.policy_violation: disallowed member access: {0}' -f $memberName)
        }
    }

    return $violations
}

function Invoke-SandboxedScript {
    <#
    .SYNOPSIS
        Runs a custom script inside a constrained pwsh child sandbox.
    .DESCRIPTION
        Admits the script through Test-SandboxedScript first and rejects it before
        execution when it cannot be sandboxed. Admitted scripts run in a child pwsh
        process inside a ConstrainedLanguage runspace that only knows the cmdlet
        allowlist, with no providers and no extra assemblies; this parent process
        enforces a wall-clock timeout, a CPU budget, and a memory bound, killing the
        child on violation. A script that errors inside the sandbox is reported failed.
    .PARAMETER ScriptContent
        The custom script text to run.
    .PARAMETER ScriptPath
        Path to a file holding the custom script text to run.
    .PARAMETER Arguments
        Named values injected as variables into the sandbox before the script runs.
        Names must be valid variable names; values must be JSON-serializable.
    .PARAMETER AllowedCmdlets
        Cmdlet allowlist override, applied to both the policy check and the child
        runspace. Defaults to the sandbox cmdlet allowlist.
    .PARAMETER TimeoutSec
        Wall-clock limit in seconds; an overrunning child is killed and reported with
        a TimeoutException carrying the sandbox.timeout code.
    .PARAMETER CpuLimitSec
        CPU-time budget in seconds; 0 disables the CPU bound. A child exceeding it is
        killed and reported with the sandbox.cpu_exceeded code.
    .PARAMETER MemoryLimitMB
        Memory bound in megabytes; a child exceeding it is killed and reported with
        the sandbox.memory_exceeded code.
    .PARAMETER PwshPath
        pwsh binary starting the sandbox child. Defaults to the current runtime.
    .EXAMPLE
        Invoke-SandboxedScript -ScriptContent "Write-Output 'hello-sandbox'"
    #>
    [CmdletBinding(DefaultParameterSetName = 'ByContent')]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory, ParameterSetName = 'ByContent')]
        [ValidateNotNullOrEmpty()]
        [string]$ScriptContent,

        [Parameter(Mandatory, ParameterSetName = 'ByPath')]
        [ValidateNotNullOrEmpty()]
        [string]$ScriptPath,

        [Parameter()]
        [hashtable]$Arguments = @{},

        [Parameter()]
        [string[]]$AllowedCmdlets = @(),

        [Parameter()]
        [ValidateRange(1, 3600)]
        [int]$TimeoutSec = 60,

        [Parameter()]
        [ValidateRange(0, 3600)]
        [int]$CpuLimitSec = 300,

        [Parameter()]
        [ValidateRange(64, 32768)]
        [int]$MemoryLimitMB = 512,

        [Parameter()]
        [string]$PwshPath = ''
    )

    $scriptText = $ScriptContent
    if ($PSCmdlet.ParameterSetName -eq 'ByPath') {
        if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
            throw [System.IO.FileNotFoundException]::new("sandbox.invalid_input: script file not found: $ScriptPath")
        }
        $scriptText = Get-Content -LiteralPath $ScriptPath -Raw -Encoding UTF8
    }
    if (-not $AllowedCmdlets -or $AllowedCmdlets.Count -eq 0) {
        $AllowedCmdlets = $script:SandboxAllowedCmdlets
    }
    $violations = Test-SandboxedScript -ScriptContent $scriptText -AllowedCmdlets $AllowedCmdlets
    if ($violations -and $violations.Count -gt 0) {
        throw [System.ArgumentException]::new(($violations -join ' '))
    }
    foreach ($key in $Arguments.Keys) {
        if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
            throw [System.ArgumentException]::new("sandbox.invalid_input: argument name is not a valid variable name: $key")
        }
    }

    if (-not $PwshPath) {
        $PwshPath = Join-Path -Path $PSHOME -ChildPath 'pwsh'
        if ($IsWindows) {
            $PwshPath = ('{0}.exe' -f $PwshPath)
        }
    }
    if (-not (Test-Path -LiteralPath $PwshPath)) {
        throw [System.IO.FileNotFoundException]::new("sandbox.unsupported: pwsh child host not found: $PwshPath")
    }

    $stageRoot = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ('m365-sandbox-{0}' -f [guid]::NewGuid().ToString('N'))
    New-Item -Path $stageRoot -ItemType Directory -Force | Out-Null
    try {
        $stagedScript = Join-Path -Path $stageRoot -ChildPath 'script.ps1'
        $harnessPath = Join-Path -Path $stageRoot -ChildPath 'harness.ps1'
        $outputPath = Join-Path -Path $stageRoot -ChildPath 'result.json'
        Set-Content -LiteralPath $stagedScript -Value $scriptText -Encoding UTF8
        Set-Content -LiteralPath $harnessPath -Value $script:SandboxHarnessTemplate -Encoding UTF8
        $variablesJson = ''
        if ($Arguments.Count -gt 0) {
            $variablesJson = $Arguments | ConvertTo-Json -Depth 10 -Compress
        }

        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $PwshPath
        # ArgumentList keeps untrusted script paths and values out of any shell, so
        # spaces or metacharacters in staged paths cannot break out of the invocation.
        $startInfo.ArgumentList.Add('-NoProfile')
        $startInfo.ArgumentList.Add('-NonInteractive')
        $startInfo.ArgumentList.Add('-ExecutionPolicy')
        $startInfo.ArgumentList.Add('Bypass')
        $startInfo.ArgumentList.Add('-File')
        $startInfo.ArgumentList.Add($harnessPath)
        $startInfo.ArgumentList.Add('-ScriptPath')
        $startInfo.ArgumentList.Add($stagedScript)
        $startInfo.ArgumentList.Add('-OutputPath')
        $startInfo.ArgumentList.Add($outputPath)
        $startInfo.ArgumentList.Add('-AllowedCmdlets')
        $startInfo.ArgumentList.Add(($AllowedCmdlets -join ','))
        $startInfo.ArgumentList.Add('-VariablesJson')
        $startInfo.ArgumentList.Add($variablesJson)
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true

        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        $null = $process.Start()

        try {
            $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
            $memoryLimitBytes = [long]$MemoryLimitMB * 1024L * 1024L
            while (-not $process.WaitForExit(250)) {
                # Refresh races the process exit; an exited child just falls through
                # to the exit-code check below.
                $overBudget = $false
                $cpuSeconds = 0.0
                try {
                    $process.Refresh()
                    $overBudget = $process.WorkingSet64 -gt $memoryLimitBytes
                    $cpuSeconds = $process.TotalProcessorTime.TotalSeconds
                }
                catch [System.InvalidOperationException] {
                    break
                }
                if ($overBudget) {
                    throw [System.OutOfMemoryException]::new("sandbox.memory_exceeded: script exceeded the ${MemoryLimitMB}MB bound.")
                }
                if ($CpuLimitSec -gt 0 -and $cpuSeconds -gt $CpuLimitSec) {
                    throw [System.InvalidOperationException]::new("sandbox.cpu_exceeded: script exceeded the ${CpuLimitSec}s CPU budget.")
                }
                if ([DateTime]::UtcNow -ge $deadline) {
                    throw [System.TimeoutException]::new("sandbox.timeout: script exceeded the ${TimeoutSec}s limit and was killed.")
                }
            }
            if ($process.ExitCode -ne 0) {
                throw [System.InvalidOperationException]::new("sandbox.failed: sandbox child exited with code $($process.ExitCode).")
            }
        }
        finally {
            if (-not $process.HasExited) {
                try {
                    $process.Kill($true)
                }
                catch {
                    Write-Verbose "sandbox: process-tree kill failed, retrying direct kill: $($_.Exception.Message)"
                    try {
                        $process.Kill()
                    }
                    catch {
                        Write-Verbose "sandbox: direct kill failed: $($_.Exception.Message)"
                    }
                }
                $process.WaitForExit(5000) | Out-Null
            }
            $process.Dispose()
        }

        if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
            throw [System.InvalidOperationException]::new('sandbox.failed: sandbox child wrote no result.')
        }
        $payload = Get-Content -LiteralPath $outputPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        if (-not $payload['success']) {
            throw [System.InvalidOperationException]::new(('sandbox.failed: script reported an error: {0}' -f $payload['error']))
        }
        $lines = @($payload['output'])
        return [pscustomobject]@{
            Success      = $true
            Output       = ($lines -join "`n")
            ExitCode     = 0
            ErrorCode    = ''
            ErrorMessage = ''
            TimedOut     = $false
        }
    }
    finally {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
