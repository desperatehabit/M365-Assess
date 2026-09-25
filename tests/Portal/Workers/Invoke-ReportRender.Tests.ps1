BeforeAll {
    $script:repoRoot = (Resolve-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
    $script:renderReport = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/render-report.ps1'
    $script:workerModule = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/M365Portal.Workers.psm1'
    $script:renderHandler = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/Invoke-ReportRender.ps1'
    $script:stubTenantId = '00000000-0000-0000-0000-000000000002'

    Import-Module -Name $script:workerModule -Force

    $script:scratchRoots = @()

    function script:New-RenderScratch {
        $root = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("m365-render-test-{0}" -f [guid]::NewGuid().ToString('N'))
        New-Item -Path $root -ItemType Directory -Force | Out-Null
        $script:scratchRoots += $root
        return $root
    }

    function script:New-BuilderHtml {
        return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script>window.REPORT_DATA = {};</script><script id="report-overrides">window.REPORT_OVERRIDES = null;</script></body></html>'
    }

    function script:New-StubChromium {
        param(
            [Parameter(Mandatory)]
            [string]$Directory,

            [Parameter()]
            [ValidateSet('Success', 'Hang', 'WrongVersion')]
            [string]$Mode = 'Success'
        )

        $stub = Join-Path -Path $Directory -ChildPath ("stub-chromium-{0}.sh" -f $Mode.ToLowerInvariant())
        $versionLine = 'Chromium 153.0.8010.36'
        if ($Mode -eq 'WrongVersion') {
            $versionLine = 'Chromium 0.0.0.0'
        }
        $renderBody = 'exit 0'
        if ($Mode -eq 'Success') {
            $renderBody = @'
    for arg in "$@"; do
      case "$arg" in
        --print-to-pdf=*)
          out=${arg#--print-to-pdf=}
          printf '%%PDF-1.4\nstub\n%%%%EOF\n' > "$out"
          ;;
      esac
    done
    exit 0
'@
        }
        elseif ($Mode -eq 'Hang') {
            $renderBody = 'sleep 47; exit 0'
        }
        @"
#!/bin/sh
if [ "`$1" = "--version" ]; then
  echo "$versionLine"
  exit 0
fi
$renderBody
"@ | Set-Content -Path $stub -Encoding UTF8NoBOM
        & chmod '+x' $stub | Out-Null
        return $stub
    }

    function script:New-ReportJobFile {
        param(
            [Parameter(Mandatory)]
            [string]$Directory,

            [Parameter(Mandatory)]
            [string]$HtmlFileName
        )

        $job = [ordered]@{
            schemaVersion = 'v1'
            jobId         = 'job-render-0001'
            jobType       = 'report'
            tenantId      = $script:stubTenantId
            runId         = 'run-render-0001'
            requestId     = 'req-render-0001'
            correlationId = 'corr-render-0001'
            createdAt     = '2026-01-01T00:00:00.000Z'
            payload       = [ordered]@{
                htmlRef     = $HtmlFileName
                pdfFileName = 'report.pdf'
            }
        }
        $jobFile = Join-Path -Path $Directory -ChildPath 'report-job.json'
        $job | ConvertTo-Json -Depth 10 | Set-Content -Path $jobFile -Encoding UTF8
        return $jobFile
    }
}

AfterAll {
    Remove-Module -Name 'M365Portal.Workers' -ErrorAction SilentlyContinue
    foreach ($root in $script:scratchRoots) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'Invoke-ReportRender headless Chromium PDF worker (T-0082)' {

    Context 'the worker layout' {
        It 'exists alongside the worker module' {
            Test-Path -LiteralPath $script:renderReport | Should -BeTrue
            Test-Path -LiteralPath $script:renderHandler | Should -BeTrue
            Test-Path -LiteralPath $script:workerModule | Should -BeTrue
        }

        It 'exports the render handler from the module' {
            $exported = (Get-Module -Name 'M365Portal.Workers').ExportedFunctions.Keys
            $exported | Should -Contain 'Invoke-ReportRender'
            $exported | Should -Contain 'Get-PinnedChromiumVersion'
        }

        It 'pins the Chromium version in configuration' {
            $pinned = Get-PinnedChromiumVersion
            $pinned | Should -Match '^\d+\.\d+\.\d+\.\d+$'
            $source = Get-Content -LiteralPath $script:renderHandler -Raw
            $source | Should -Match 'PinnedChromiumVersion'
        }
    }

    Context 'a successful render' {
        It 'renders builder HTML to a PDF artifact via the stub Chromium' {
            $scratch = New-RenderScratch
            $htmlPath = Join-Path -Path $scratch -ChildPath 'report.html'
            New-BuilderHtml | Set-Content -Path $htmlPath -Encoding UTF8
            $stub = New-StubChromium -Directory $scratch -Mode 'Success'
            $pdfPath = Join-Path -Path $scratch -ChildPath 'report.pdf'

            $result = Invoke-ReportRender -HtmlPath $htmlPath -PdfPath $pdfPath -ChromiumPath $stub

            Test-Path -LiteralPath $pdfPath | Should -BeTrue
            $magic = Get-Content -LiteralPath $pdfPath -TotalCount 4 -AsByteStream
            [char]$magic[0] | Should -Be '%'
            [char]$magic[1] | Should -Be 'P'
            [char]$magic[2] | Should -Be 'D'
            [char]$magic[3] | Should -Be 'F'
            $result.PdfPath | Should -Be ([System.IO.Path]::GetFullPath($pdfPath))
        }

        It 'stages inline HTML to a temp path and cleans it up' {
            $scratch = New-RenderScratch
            $stub = New-StubChromium -Directory $scratch -Mode 'Success'
            $pdfPath = Join-Path -Path $scratch -ChildPath 'inline.pdf'
            $before = @(Get-ChildItem -Path ([System.IO.Path]::GetTempPath()) -Filter 'm365-report-render-*.html' -ErrorAction SilentlyContinue)

            Invoke-ReportRender -HtmlContent (New-BuilderHtml) -PdfPath $pdfPath -ChromiumPath $stub | Out-Null

            Test-Path -LiteralPath $pdfPath | Should -BeTrue
            $after = @(Get-ChildItem -Path ([System.IO.Path]::GetTempPath()) -Filter 'm365-report-render-*.html' -ErrorAction SilentlyContinue)
            $after.Count | Should -Be $before.Count
        }
    }

    Context 'render injection rejection' {
        It 'rejects HTML that our builders did not produce' {
            $scratch = New-RenderScratch
            $htmlPath = Join-Path -Path $scratch -ChildPath 'foreign.html'
            '<html><body><script>alert(1)</script></body></html>' | Set-Content -Path $htmlPath -Encoding UTF8
            $stub = New-StubChromium -Directory $scratch -Mode 'Success'
            $pdfPath = Join-Path -Path $scratch -ChildPath 'foreign.pdf'

            { Invoke-ReportRender -HtmlPath $htmlPath -PdfPath $pdfPath -ChromiumPath $stub } | Should -Throw '*render.invalid_input*'
            Test-Path -LiteralPath $pdfPath | Should -BeFalse
        }

        It 'rejects builder-shaped HTML carrying an external script' {
            $scratch = New-RenderScratch
            $htmlPath = Join-Path -Path $scratch -ChildPath 'evil.html'
            ('<html><body><div id="root"></div><script>window.REPORT_DATA = {};</script><script src="https://evil.example/x.js"></script></body></html>') | Set-Content -Path $htmlPath -Encoding UTF8
            $stub = New-StubChromium -Directory $scratch -Mode 'Success'
            $pdfPath = Join-Path -Path $scratch -ChildPath 'evil.pdf'

            { Invoke-ReportRender -HtmlPath $htmlPath -PdfPath $pdfPath -ChromiumPath $stub } | Should -Throw '*render.invalid_input*'
            Test-Path -LiteralPath $pdfPath | Should -BeFalse
        }
    }

    Context 'bounds and versioning' {
        It 'kills a render past the timeout' {
            $scratch = New-RenderScratch
            $htmlPath = Join-Path -Path $scratch -ChildPath 'report.html'
            New-BuilderHtml | Set-Content -Path $htmlPath -Encoding UTF8
            $stub = New-StubChromium -Directory $scratch -Mode 'Hang'
            $pdfPath = Join-Path -Path $scratch -ChildPath 'report.pdf'

            { Invoke-ReportRender -HtmlPath $htmlPath -PdfPath $pdfPath -ChromiumPath $stub -TimeoutSec 2 } | Should -Throw '*render.timeout*'
            $lingering = @((& ps -eo args) | Where-Object { $_ -match 'sleep 47' })
            $lingering.Count | Should -Be 0
        }

        It 'rejects a Chromium that does not match the pinned version' {
            $scratch = New-RenderScratch
            $htmlPath = Join-Path -Path $scratch -ChildPath 'report.html'
            New-BuilderHtml | Set-Content -Path $htmlPath -Encoding UTF8
            $stub = New-StubChromium -Directory $scratch -Mode 'WrongVersion'
            $pdfPath = Join-Path -Path $scratch -ChildPath 'report.pdf'

            { Invoke-ReportRender -HtmlPath $htmlPath -PdfPath $pdfPath -ChromiumPath $stub } | Should -Throw '*render.version_mismatch*'
        }
    }

    Context 'the render-report.ps1 entrypoint' {
        It 'writes a succeeded result envelope and exits 0' {
            $scratch = New-RenderScratch
            New-BuilderHtml | Set-Content -Path (Join-Path -Path $scratch -ChildPath 'report.html') -Encoding UTF8
            $jobFile = New-ReportJobFile -Directory $scratch -HtmlFileName 'report.html'
            $stub = New-StubChromium -Directory $scratch -Mode 'Success'
            $output = Join-Path -Path $scratch -ChildPath 'render'

            & pwsh -NoProfile -File $script:renderReport -JobFile $jobFile -OutputFolder $output -ChromiumPath $stub | Out-Null
            $LASTEXITCODE | Should -Be 0

            Test-Path -LiteralPath (Join-Path -Path $output -ChildPath 'report.pdf') | Should -BeTrue
            $envelope = Get-Content -LiteralPath (Join-Path -Path $output -ChildPath 'result.json') -Raw | ConvertFrom-Json -AsHashtable
            $envelope['schemaVersion'] | Should -Be 'v1'
            $envelope['jobType'] | Should -Be 'report'
            $envelope['jobId'] | Should -Be 'job-render-0001'
            $envelope['tenantId'] | Should -Be $script:stubTenantId
            $envelope['status'] | Should -Be 'succeeded'
            $envelope['exitCode'] | Should -Be 0
            $envelope['artifactRefs'] | Should -Contain 'report.pdf'
            $envelope.ContainsKey('error') | Should -BeFalse
        }

        It 'kills an overrunning render and reports a retryable failed job' {
            $scratch = New-RenderScratch
            New-BuilderHtml | Set-Content -Path (Join-Path -Path $scratch -ChildPath 'report.html') -Encoding UTF8
            $jobFile = New-ReportJobFile -Directory $scratch -HtmlFileName 'report.html'
            $stub = New-StubChromium -Directory $scratch -Mode 'Hang'
            $output = Join-Path -Path $scratch -ChildPath 'render'

            & pwsh -NoProfile -File $script:renderReport -JobFile $jobFile -OutputFolder $output -ChromiumPath $stub -TimeoutSec 2 | Out-Null
            $LASTEXITCODE | Should -Be 1

            $envelope = Get-Content -LiteralPath (Join-Path -Path $output -ChildPath 'result.json') -Raw | ConvertFrom-Json -AsHashtable
            $envelope['schemaVersion'] | Should -Be 'v1'
            $envelope['jobType'] | Should -Be 'report'
            $envelope['status'] | Should -Be 'failed'
            $envelope['exitCode'] | Should -Be 1
            $envelope['error']['code'] | Should -Be 'render.timeout'
            $envelope['error']['retryable'] | Should -BeTrue
        }

        It 'writes a failed envelope and exits 2 when the job file is missing' {
            $scratch = New-RenderScratch
            $output = Join-Path -Path $scratch -ChildPath 'render'

            & pwsh -NoProfile -File $script:renderReport -JobFile (Join-Path -Path $scratch -ChildPath 'absent.json') -OutputFolder $output | Out-Null
            $LASTEXITCODE | Should -Be 2

            $envelope = Get-Content -LiteralPath (Join-Path -Path $output -ChildPath 'result.json') -Raw | ConvertFrom-Json -AsHashtable
            $envelope['status'] | Should -Be 'failed'
            $envelope['exitCode'] | Should -Be 2
            $envelope['error']['code'] | Should -Be 'worker.invalid_job'
        }
    }
}
