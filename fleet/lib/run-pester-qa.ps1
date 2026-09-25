<#
.SYNOPSIS
    Run the M365-Assess Pester suite for fleet QA and emit a JUnit XML report.

.DESCRIPTION
    Pester 5 emits NUnit XML, but the fleet runner (fleet/lib/runner.py via
    fleet.py's run_suite) parses JUnit: <testcase> elements carrying a <failure>
    child. This script runs the suite once, writes NUnit to a sibling file, then
    translates the failing test cases into the JUnit shape the runner expects, at
    the exact path the runner passed in.

    QA is baseline-relative: fleet.py baseline records the failing set on main and
    QA only counts NEW failures, so a suite that is already red does not fail every
    ticket.

.PARAMETER XmlPath
    Destination JUnit XML path. The fleet runner substitutes this from {xml}.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$XmlPath
)

$ErrorActionPreference = 'Continue'
$nunitPath = "$XmlPath.nunit"

function Write-JUnitReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object[]]$Cases
    )

    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine('<testsuites>')
    [void]$sb.AppendLine('<testsuite name="pester">')
    foreach ($c in $Cases) {
        $name = [System.Security.SecurityElement]::Escape([string]$c.Name)
        if ($c.Failed) {
            [void]$sb.AppendLine("<testcase classname=`"pester`" name=`"$name`"><failure/></testcase>")
        }
        else {
            [void]$sb.AppendLine("<testcase classname=`"pester`" name=`"$name`"/>")
        }
    }
    [void]$sb.AppendLine('</testsuite>')
    [void]$sb.AppendLine('</testsuites>')
    Set-Content -LiteralPath $Path -Value $sb.ToString() -Encoding UTF8
}

# Pester 5 configuration form, matching .github/workflows/ci.yml.
$config = New-PesterConfiguration
$config.Run.Path = './tests'
$config.Run.Exit = $false
$config.Run.PassThru = $true
$config.TestResult.Enabled = $true
$config.TestResult.OutputPath = $nunitPath
$config.TestResult.OutputFormat = 'NUnitXml'
$config.Output.Verbosity = 'None'

$result = Invoke-Pester -Configuration $config

$cases = @()
if (Test-Path -LiteralPath $nunitPath) {
    try {
        [xml]$doc = Get-Content -LiteralPath $nunitPath -Raw
        foreach ($tc in $doc.SelectNodes('//test-case')) {
            $full = if ($tc.fullname) { [string]$tc.fullname } else { [string]$tc.name }
            $cases += [pscustomobject]@{
                Name   = $full
                Failed = ([string]$tc.result) -eq 'Failed'
            }
        }
    }
    catch {
        $cases += [pscustomobject]@{ Name = 'PESTER_XML_PARSE_ERROR'; Failed = $true }
    }
}
else {
    # No NUnit report means the suite never ran to completion. Emit a failing case
    # so the runner treats the run as invalid rather than clean.
    $cases += [pscustomobject]@{ Name = 'PESTER_NO_RESULT'; Failed = $true }
}

Write-JUnitReport -Path $XmlPath -Cases $cases

$failedCount = @($cases | Where-Object { $_.Failed }).Count
Write-Host "Pester: $($cases.Count) test case(s); $failedCount failed."

if ($failedCount -gt 0) { exit 1 }
exit 0
