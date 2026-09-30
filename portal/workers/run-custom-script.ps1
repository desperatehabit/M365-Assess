<#
.SYNOPSIS
    Worker entrypoint for running a custom script in the sandbox (T-0837).
.DESCRIPTION
    Reads a job envelope from -JobFile (content, tenantId, dryRun, parameters) and runs
    the script through Invoke-SandboxedScript. Emits the result as JSON on stdout:
    output, exitCode, error, and durationMs. A script that fails the sandbox policy or
    errors at runtime is reported with exitCode 1 and the error message, not a non-zero
    process exit, so the BFF can return the failure in the response body.
.PARAMETER JobFile
    Path to the job envelope JSON written by the BFF.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$JobFile
)

$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'M365Portal.Workers/Invoke-SandboxedScript.ps1')

$job = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
$content = [string]$job.content
$dryRun = [bool]$job.dryRun
$arguments = @{}
if ($job.parameters) {
    foreach ($prop in $job.parameters.PSObject.Properties) {
        $arguments[$prop.Name] = $prop.Value
    }
}
$arguments['dryRun'] = $dryRun

$started = [DateTime]::UtcNow
try {
    $result = Invoke-SandboxedScript -ScriptContent $content -Arguments $arguments
    $payload = [ordered]@{
        output     = [string]$result.Output
        exitCode   = [int]$result.ExitCode
        error      = $null
        durationMs = [int](([DateTime]::UtcNow - $started).TotalMilliseconds)
    }
} catch {
    $payload = [ordered]@{
        output     = ''
        exitCode   = 1
        error      = $_.Exception.Message
        durationMs = [int](([DateTime]::UtcNow - $started).TotalMilliseconds)
    }
}
$payload | ConvertTo-Json -Depth 6 -Compress
