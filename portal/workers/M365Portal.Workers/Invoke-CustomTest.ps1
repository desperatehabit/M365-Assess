<#
.SYNOPSIS
    Worker and cmdlet for executing custom compliance tests in the sandbox (EPIC-036, T-0707).

.DESCRIPTION
    Executes a custom test's ScriptContent inside the T-0126 sandbox (Invoke-SandboxedScript)
    and renders its output through the version's MarkdownTemplate (Format-ScriptOutput, T-0128).
    Supports dry runs (returns rendered output without persisting state) and live runs.
    Enforces the EPIC-006 remediation gate on writes and refuses any unsandboxed write attempt.
#>
[CmdletBinding()]
param(
    [Parameter()]
    [string]$JobFile,

    [Parameter()]
    [string]$ScriptContent,

    [Parameter()]
    [string]$MarkdownTemplate = '',

    [Parameter()]
    [object]$Parameters = $null,

    [Parameter()]
    [string]$TenantId = '',

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$Writes,

    [Parameter()]
    [switch]$Confirmed,

    [Parameter()]
    [switch]$Unsandboxed,

    [Parameter()]
    [scriptblock]$SandboxExecutor,

    [Parameter()]
    [scriptblock]$OutputFormatter
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:WorkerRoot = $PSScriptRoot
if (-not $script:WorkerRoot) {
    $script:WorkerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

function Invoke-CustomTest {
    <#
    .SYNOPSIS
        Executes a custom test script inside the sandbox and renders its markdown output.
    .DESCRIPTION
        Implements EPIC-036 §4.2 and §8: runs sandboxed per EPIC-007 (T-0126) and renders
        output via MarkdownTemplate (T-0128). Enforces EPIC-006 write gate.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$ScriptContent,

        [Parameter()]
        [string]$MarkdownTemplate = '',

        [Parameter()]
        [object]$Parameters = $null,

        [Parameter()]
        [string]$TenantId = '',

        [Parameter()]
        [switch]$DryRun,

        [Parameter()]
        [switch]$Writes,

        [Parameter()]
        [switch]$Confirmed,

        [Parameter()]
        [switch]$Unsandboxed,

        [Parameter()]
        [scriptblock]$SandboxExecutor = $null,

        [Parameter()]
        [scriptblock]$OutputFormatter = $null
    )

    if ($Unsandboxed) {
        throw [System.InvalidOperationException]::new('custom_test.unsandboxed_write_refused: unsandboxed writes are refused')
    }

    if ([string]::IsNullOrWhiteSpace($ScriptContent)) {
        throw [System.ArgumentException]::new('custom_test.invalid_input: script content is required')
    }

    # EPIC-006 remediation gate for writes
    $hasWrites = [bool]$Writes
    if ($null -ne $Parameters) {
        if ($Parameters -is [System.Collections.IDictionary] -and $Parameters.Contains('writes')) {
            if ($Parameters['writes'] -eq $true -or $Parameters['writes'] -eq 'true') {
                $hasWrites = $true
            }
        }
        elseif ($Parameters.PSObject -and $Parameters.PSObject.Properties['writes']) {
            if ($Parameters.writes -eq $true -or $Parameters.writes -eq 'true') {
                $hasWrites = $true
            }
        }
    }

    if ($hasWrites) {
        if (-not $DryRun -and -not $Confirmed) {
            throw [System.InvalidOperationException]::new('remediation.gate_required: custom test writes require explicit confirmation under EPIC-006 gate')
        }
    }

    # Ensure dependencies are loaded
    if (-not $SandboxExecutor -and -not (Get-Command -Name 'Invoke-SandboxedScript' -ErrorAction SilentlyContinue)) {
        $sandboxScript = Join-Path -Path $script:WorkerRoot -ChildPath 'Invoke-SandboxedScript.ps1'
        if (Test-Path -LiteralPath $sandboxScript) {
            . $sandboxScript
        }
    }
    if (-not $OutputFormatter -and -not (Get-Command -Name 'Format-ScriptOutput' -ErrorAction SilentlyContinue)) {
        $formatScript = Join-Path -Path $script:WorkerRoot -ChildPath 'Format-ScriptOutput.ps1'
        if (Test-Path -LiteralPath $formatScript) {
            . $formatScript
        }
    }

    $arguments = @{}
    if ($null -ne $Parameters) {
        if ($Parameters -is [System.Collections.IDictionary]) {
            foreach ($key in $Parameters.Keys) {
                $arguments[[string]$key] = $Parameters[$key]
            }
        }
        elseif ($Parameters.PSObject) {
            foreach ($prop in $Parameters.PSObject.Properties) {
                $arguments[$prop.Name] = $prop.Value
            }
        }
    }
    $arguments['dryRun'] = [bool]$DryRun
    if ($TenantId) {
        $arguments['tenantId'] = [string]$TenantId
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $rawOutput = ''
    $exitCode = 0
    $errorMsg = $null
    $success = $true

    try {
        $sandboxResult = if ($SandboxExecutor) {
            & $SandboxExecutor -ScriptContent $ScriptContent -Arguments $arguments
        }
        else {
            Invoke-SandboxedScript -ScriptContent $ScriptContent -Arguments $arguments
        }

        if ($null -ne $sandboxResult) {
            if ($sandboxResult.PSObject.Properties['Output']) {
                $rawOutput = [string]$sandboxResult.Output
            }
            elseif ($sandboxResult -is [string]) {
                $rawOutput = $sandboxResult
            }
            if ($sandboxResult.PSObject.Properties['ExitCode']) {
                $exitCode = [int]$sandboxResult.ExitCode
            }
        }
        if ($exitCode -ne 0) {
            $success = $false
        }
    }
    catch {
        $success = $false
        $exitCode = 1
        $errorMsg = $_.Exception.Message
        $rawOutput = ''
    }
    finally {
        $sw.Stop()
    }

    $renderedMarkdown = $rawOutput
    if (-not [string]::IsNullOrWhiteSpace($MarkdownTemplate)) {
        $outputObj = $null
        if (-not [string]::IsNullOrWhiteSpace($rawOutput)) {
            try {
                $outputObj = $rawOutput | ConvertFrom-Json -ErrorAction Stop
            }
            catch {
                $outputObj = [pscustomobject]@{
                    output = $rawOutput
                    text   = $rawOutput
                }
            }
        }
        else {
            $outputObj = [pscustomobject]@{
                output = ''
                text   = ''
            }
        }

        if ($OutputFormatter) {
            $renderedMarkdown = & $OutputFormatter -OutputObject $outputObj -MarkdownTemplate $MarkdownTemplate
        }
        elseif (Get-Command -Name 'Format-ScriptOutput' -ErrorAction SilentlyContinue) {
            $renderedMarkdown = Format-ScriptOutput -OutputObject $outputObj -MarkdownTemplate $MarkdownTemplate
        }
    }

    $status = 'Pass'
    if (-not $success) {
        $status = 'Fail'
    }
    elseif (-not [string]::IsNullOrWhiteSpace($rawOutput)) {
        try {
            $parsed = $rawOutput | ConvertFrom-Json -ErrorAction Stop
            if ($parsed -is [System.Collections.IDictionary]) {
                if ($parsed.Contains('status')) {
                    $status = [string]$parsed['status']
                }
                elseif ($parsed.Contains('passed') -and -not [bool]$parsed['passed']) {
                    $status = 'Fail'
                }
            }
            elseif ($parsed.PSObject) {
                if ($parsed.PSObject.Properties['status']) {
                    $status = [string]$parsed.status
                }
                elseif ($parsed.PSObject.Properties['passed'] -and -not [bool]$parsed.passed) {
                    $status = 'Fail'
                }
            }
        }
        catch {
            # Non-json output treated as success if exit code is 0
        }
    }

    $finalSuccess = ($status -ne 'Fail' -and $status -ne 'Error' -and $exitCode -eq 0)

    return [pscustomobject]@{
        Success          = $finalSuccess
        Status           = $status
        Output           = $rawOutput
        RenderedMarkdown = $renderedMarkdown
        DryRun           = [bool]$DryRun
        ExitCode         = $exitCode
        Error            = $errorMsg
        DurationMs       = [int]$sw.ElapsedMilliseconds
    }
}

if ($JobFile) {
    if (-not (Test-Path -LiteralPath $JobFile)) {
        throw "job envelope not found at '$JobFile' (code: worker.job_missing)"
    }
    $job = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
    $script = ''
    if ($job.PSObject.Properties['scriptContent']) {
        $script = [string]$job.scriptContent
    }
    elseif ($job.PSObject.Properties['content']) {
        $script = [string]$job.content
    }

    $template = ''
    if ($job.PSObject.Properties['markdownTemplate']) {
        $template = [string]$job.markdownTemplate
    }

    $tId = ''
    if ($job.PSObject.Properties['tenantId']) {
        $tId = [string]$job.tenantId
    }

    $isDry = $false
    if ($job.PSObject.Properties['dryRun'] -and $null -ne $job.dryRun) {
        $isDry = [bool]$job.dryRun
    }

    $isWrites = $false
    if ($job.PSObject.Properties['writes'] -and $null -ne $job.writes) {
        $isWrites = [bool]$job.writes
    }

    $isConfirmed = $false
    if ($job.PSObject.Properties['confirmed'] -and $null -ne $job.confirmed) {
        $isConfirmed = [bool]$job.confirmed
    }

    $isUnsandboxed = $false
    if ($job.PSObject.Properties['unsandboxed'] -and $null -ne $job.unsandboxed) {
        $isUnsandboxed = [bool]$job.unsandboxed
    }

    $params = @{}
    if ($job.PSObject.Properties['parameters'] -and $null -ne $job.parameters) {
        $params = $job.parameters
    }

    $res = Invoke-CustomTest -ScriptContent $script `
        -MarkdownTemplate $template `
        -TenantId $tId `
        -DryRun:$isDry `
        -Writes:$isWrites `
        -Confirmed:$isConfirmed `
        -Unsandboxed:$isUnsandboxed `
        -Parameters $params

    $res | ConvertTo-Json -Depth 6 -Compress
    return
}
