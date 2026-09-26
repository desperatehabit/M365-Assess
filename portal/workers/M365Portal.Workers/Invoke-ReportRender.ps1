# Invoke-ReportRender renders server-side PDFs via pinned headless Chromium (ADR-0016).
# The module's self-contained HTML report (ADR-0008) is the single source of layout; this
# handler prints that HTML to PDF so the on-screen report and the PDF cannot diverge.

$script:PinnedChromiumVersion = '153.0.8010.36'
$script:DefaultRenderTimeoutSec = 120
$script:DefaultRenderMemoryLimitMB = 2048

function Get-PinnedChromiumVersion {
    <#
    .SYNOPSIS
        Returns the pinned headless Chromium version PDF renders are validated against.
    .DESCRIPTION
        ADR-0016 pins the browser version so output drift across releases is caught instead
        of silently shipping. Invoke-ReportRender defaults its -ChromiumVersion to this value.
    .EXAMPLE
        Get-PinnedChromiumVersion
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()

    return $script:PinnedChromiumVersion
}

function Test-ReportRenderInput {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$HtmlContent
    )

    if ([string]::IsNullOrWhiteSpace($HtmlContent)) {
        throw [System.ArgumentException]::new('render.invalid_input: renderer input is empty.')
    }
    # Only HTML produced by our own builders reaches the browser process: both the module
    # report (Get-ReportTemplate) and builder output inline window.REPORT_DATA into a root
    # shell, so foreign HTML lacking those markers is rejected (ADR-0016 render injection).
    if ($HtmlContent -notmatch 'window\.REPORT_DATA' -or $HtmlContent -notmatch '<div id="root"') {
        throw [System.ArgumentException]::new('render.invalid_input: renderer input is not a report produced by our own HTML builders.')
    }
    # Our HTML is self-contained by construction (ADR-0008): an external script URL proves
    # foreign content even when the markers above are spoofed into tenant text.
    if ($HtmlContent -match '<script[^>]+src\s*=\s*["' + "']https?://") {
        throw [System.ArgumentException]::new('render.invalid_input: renderer input references an external script.')
    }
}

function Resolve-RenderChromiumPath {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$ChromiumPath = ''
    )

    if ($ChromiumPath) {
        if (-not (Test-Path -LiteralPath $ChromiumPath)) {
            throw [System.IO.FileNotFoundException]::new("render.chromium_not_found: Chromium binary not found: $ChromiumPath")
        }
        return $ChromiumPath
    }
    foreach ($candidate in @($env:M365_CHROMIUM_PATH, $env:CHROMIUM_PATH)) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }
    foreach ($name in @('chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'headless_shell')) {
        $found = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
            return $found.Source
        }
    }
    throw [System.IO.FileNotFoundException]::new('render.chromium_not_found: no Chromium binary found; pass -ChromiumPath or set M365_CHROMIUM_PATH.')
}

function Assert-ChromiumVersion {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ResolvedChromiumPath,

        [Parameter(Mandatory)]
        [string]$ExpectedVersion
    )

    $versionOutput = & $ResolvedChromiumPath --version 2>&1 | Out-String
    $matched = [regex]::Match($versionOutput, '(\d+\.\d+\.\d+\.\d+)')
    if (-not $matched.Success) {
        throw [System.InvalidOperationException]::new("render.version_mismatch: could not parse Chromium version from: $versionOutput")
    }
    if ($matched.Groups[1].Value -ne $ExpectedVersion) {
        throw [System.InvalidOperationException]::new("render.version_mismatch: Chromium version $($matched.Groups[1].Value) does not match pinned $ExpectedVersion.")
    }
}

function Invoke-ReportRender {
    <#
    .SYNOPSIS
        Renders builder/executive report HTML to a PDF artifact via pinned headless Chromium.
    .DESCRIPTION
        Stages the HTML to a temp path when given inline content, validates it was produced
        by our own HTML builders, then prints it to PDF with headless Chromium under a
        timeout and a memory bound. The PDF is written to the artifact path; render bytes
        never go into the DB (EPIC-005 SPEC.md section 11.5).
    .PARAMETER HtmlPath
        Path to a report HTML file produced by our own builders.
    .PARAMETER HtmlContent
        Inline report HTML; staged to a temp path before rendering.
    .PARAMETER PdfPath
        Artifact path receiving the rendered PDF.
    .PARAMETER ChromiumPath
        Chromium binary. Defaults to M365_CHROMIUM_PATH/CHROMIUM_PATH or a well-known name.
    .PARAMETER ChromiumVersion
        Expected Chromium version. Defaults to the pinned version.
    .PARAMETER TimeoutSec
        Render timeout in seconds; an overrunning render is killed and throws TimeoutException.
    .PARAMETER MemoryLimitMB
        Memory bound in megabytes; a render exceeding it is killed.
    .PARAMETER SkipVersionCheck
        Bypasses the pinned-version check for operators running a patched browser.
    .EXAMPLE
        Invoke-ReportRender -HtmlPath './report.html' -PdfPath './report.pdf'
    #>
    [CmdletBinding(DefaultParameterSetName = 'ByPath')]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory, ParameterSetName = 'ByPath')]
        [ValidateNotNullOrEmpty()]
        [string]$HtmlPath,

        [Parameter(Mandatory, ParameterSetName = 'ByContent')]
        [ValidateNotNullOrEmpty()]
        [string]$HtmlContent,

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$PdfPath,

        [Parameter()]
        [string]$ChromiumPath = '',

        [Parameter()]
        [string]$ChromiumVersion = '',

        [Parameter()]
        [ValidateRange(1, 3600)]
        [int]$TimeoutSec = 120,

        [Parameter()]
        [ValidateRange(64, 32768)]
        [int]$MemoryLimitMB = 2048,

        [Parameter()]
        [switch]$SkipVersionCheck
    )

    if (-not $ChromiumVersion) {
        $ChromiumVersion = $script:PinnedChromiumVersion
    }
    if ($TimeoutSec -le 0) {
        $TimeoutSec = $script:DefaultRenderTimeoutSec
    }

    $stagedTempHtml = $false
    if ($PSCmdlet.ParameterSetName -eq 'ByContent') {
        $HtmlPath = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("m365-report-render-{0}.html" -f [guid]::NewGuid().ToString('N'))
        Set-Content -LiteralPath $HtmlPath -Value $HtmlContent -Encoding UTF8
        $stagedTempHtml = $true
    }

    try {
        if (-not (Test-Path -LiteralPath $HtmlPath -PathType Leaf)) {
            throw [System.IO.FileNotFoundException]::new("render.invalid_input: report HTML not found: $HtmlPath")
        }
        Test-ReportRenderInput -HtmlContent (Get-Content -LiteralPath $HtmlPath -Raw -Encoding UTF8)

        $resolvedChromium = Resolve-RenderChromiumPath -ChromiumPath $ChromiumPath
        if (-not $SkipVersionCheck) {
            Assert-ChromiumVersion -ResolvedChromiumPath $resolvedChromium -ExpectedVersion $ChromiumVersion
        }

        $pdfDirectory = Split-Path -Path $PdfPath -Parent
        if ($pdfDirectory) {
            New-Item -Path $pdfDirectory -ItemType Directory -Force | Out-Null
        }
        $fullHtml = (Resolve-Path -LiteralPath $HtmlPath).Path
        $fullPdf = [System.IO.Path]::GetFullPath($PdfPath)

        $arguments = @(
            '--headless',
            '--disable-gpu',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--hide-scrollbars',
            ('--print-to-pdf={0}' -f $fullPdf),
            '--print-to-pdf-no-header',
            '--no-pdf-header-footer',
            $fullHtml
        )

        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $resolvedChromium
        # ArgumentList keeps render paths out of any shell, so spaces in artifact
        # paths cannot break the invocation or inject flags.
        foreach ($argument in $arguments) {
            $startInfo.ArgumentList.Add($argument)
        }
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true

        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        $null = $process.Start()

        try {
            $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
            $memoryLimitBytes = [long]$MemoryLimitMB * 1024L * 1024L
            while (-not $process.WaitForExit(250)) {
                # Refresh races the process exit; an exited renderer just falls through
                # to the exit-code check below.
                $overBudget = $false
                try {
                    $process.Refresh()
                    $overBudget = $process.WorkingSet64 -gt $memoryLimitBytes
                }
                catch [System.InvalidOperationException] {
                    break
                }
                if ($overBudget) {
                    throw [System.OutOfMemoryException]::new("render.memory_exceeded: Chromium exceeded the ${MemoryLimitMB}MB bound.")
                }
                if ([DateTime]::UtcNow -ge $deadline) {
                    throw [System.TimeoutException]::new("render.timeout: Chromium render exceeded ${TimeoutSec}s and was killed.")
                }
            }
            if ($process.ExitCode -ne 0) {
                throw [System.InvalidOperationException]::new("render.failed: Chromium exited with code $($process.ExitCode).")
            }
        }
        finally {
            if (-not $process.HasExited) {
                try {
                    $process.Kill($true)
                }
                catch {
                    Write-Verbose "render: process-tree kill failed, retrying direct kill: $($_.Exception.Message)"
                    try {
                        $process.Kill()
                    }
                    catch {
                        Write-Verbose "render: direct kill failed: $($_.Exception.Message)"
                    }
                }
                $process.WaitForExit(5000) | Out-Null
            }
            $process.Dispose()
        }

        if (-not (Test-Path -LiteralPath $fullPdf -PathType Leaf)) {
            throw [System.InvalidOperationException]::new('render.failed: Chromium exited 0 but wrote no PDF.')
        }
        $magic = Get-Content -LiteralPath $fullPdf -TotalCount 4 -AsByteStream -ErrorAction Stop
        if ($magic.Count -lt 4 -or $magic[0] -ne 0x25 -or $magic[1] -ne 0x50 -or $magic[2] -ne 0x44 -or $magic[3] -ne 0x46) {
            throw [System.InvalidOperationException]::new('render.failed: Chromium output is not a PDF.')
        }

        return [pscustomobject]@{
            PdfPath          = $fullPdf
            HtmlPath         = $fullHtml
            ChromiumPath     = $resolvedChromium
            ChromiumVersion  = $ChromiumVersion
            TimeoutSec       = $TimeoutSec
            MemoryLimitMB    = $MemoryLimitMB
        }
    }
    finally {
        if ($stagedTempHtml -and (Test-Path -LiteralPath $HtmlPath)) {
            Remove-Item -LiteralPath $HtmlPath -Force -ErrorAction SilentlyContinue
        }
    }
}
