BeforeAll {
    $script:repoRoot = (Resolve-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
    $script:runTenant = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/run-tenant.ps1'
    $script:workerManifest = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/M365Portal.Workers.psd1'
    $script:workerModule = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/M365Portal.Workers.psm1'
    $script:stubTenantId = '00000000-0000-0000-0000-000000000001'

    . (Join-Path -Path $script:repoRoot -ChildPath 'src/M365-Assess/Common/RunContext.ps1')

    Import-Module -Name $script:workerManifest -Force

    $script:scratchRoots = @()

    function script:New-WorkerScratch {
        $root = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("m365-worker-test-{0}" -f [guid]::NewGuid().ToString('N'))
        New-Item -Path $root -ItemType Directory -Force | Out-Null
        $script:scratchRoots += $root
        return $root
    }

    function script:New-WorkerContextFile {
        param(
            [Parameter(Mandatory)]
            [string]$Directory
        )

        $ctx = New-RunContext -TenantId $script:stubTenantId -Sections @('Tenant') -Auth @{} -Timestamp '20260101_000000' -OutputFolder (Join-Path -Path $Directory -ChildPath 'assessment')
        $contextFile = Join-Path -Path $Directory -ChildPath 'context.json'
        ConvertTo-RunContextJson -Context $ctx | Set-Content -Path $contextFile -Encoding UTF8
        return $contextFile
    }

    function script:New-WorkerStubAssessment {
        param(
            [Parameter(Mandatory)]
            [string]$Directory,

            [Parameter(Mandatory)]
            [ValidateSet('Success', 'Failure')]
            [string]$Mode
        )

        $stub = Join-Path -Path $Directory -ChildPath ("stub-assessment-{0}.ps1" -f $Mode.ToLowerInvariant())
        if ($Mode -eq 'Success') {
            @'
param(
    [string]$OutputFolder = '',
    [Parameter(ValueFromRemainingArguments = $true)]
    $Remaining
)
$ErrorActionPreference = 'Stop'
New-Item -Path $OutputFolder -ItemType Directory -Force | Out-Null
'stub' | Set-Content -Path (Join-Path -Path $OutputFolder -ChildPath 'stub-artifact.json') -Encoding UTF8
'@ | Set-Content -Path $stub -Encoding UTF8
        }
        else {
            @'
param(
    [string]$OutputFolder = '',
    [Parameter(ValueFromRemainingArguments = $true)]
    $Remaining
)
$ErrorActionPreference = 'Stop'
throw 'stub assessment failure'
'@ | Set-Content -Path $stub -Encoding UTF8
        }
        return $stub
    }
}

AfterAll {
    Remove-Module -Name 'M365Portal.Workers' -ErrorAction SilentlyContinue
    foreach ($root in $script:scratchRoots) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'run-tenant.ps1 per-tenant worker entrypoint (T-0006)' {

    Context 'the entrypoint and module layout' {
        It 'exists alongside the worker module' {
            Test-Path -LiteralPath $script:runTenant | Should -BeTrue
            Test-Path -LiteralPath $script:workerManifest | Should -BeTrue
            Test-Path -LiteralPath $script:workerModule | Should -BeTrue
        }

        It 'loads the worker module instead of reimplementing domain logic' {
            $source = Get-Content -LiteralPath $script:runTenant -Raw
            $source | Should -Match 'M365Portal\.Workers'
            $source | Should -Match 'Read-WorkerRunContext'
            $source | Should -Match 'Invoke-WorkerAssessment'
            $source | Should -Match 'Write-WorkerResult'
            $source | Should -Match 'Invoke-WorkerAssessment @invokeParams'
            $source | Should -Not -Match '& \$AssessmentScript'
            $source | Should -Not -Match 'Invoke-M365Assessment @'
        }

        It 'exports the reusable handler functions from the module' {
            $exported = (Get-Module -Name 'M365Portal.Workers').ExportedFunctions.Keys
            $exported | Should -Contain 'Read-WorkerRunContext'
            $exported | Should -Contain 'Get-WorkerArtifacts'
            $exported | Should -Contain 'Write-WorkerResult'
            $exported | Should -Contain 'Invoke-WorkerAssessment'
        }
    }

    Context 'a successful child run' {
        It 'writes a succeeded result envelope and exits 0' {
            $scratch = New-WorkerScratch
            $contextFile = New-WorkerContextFile -Directory $scratch
            $stub = New-WorkerStubAssessment -Directory $scratch -Mode 'Success'
            $output = Join-Path -Path $scratch -ChildPath 'tenant'

            & pwsh -NoProfile -File $script:runTenant -ContextFile $contextFile -OutputFolder $output -JobId 'job-0001' -RunId 'run-0001' -RequestId 'req-0001' -CorrelationId 'corr-0001' -AssessmentScript $stub | Out-Null
            $LASTEXITCODE | Should -Be 0

            $resultPath = Join-Path -Path $output -ChildPath 'result.json'
            Test-Path -LiteralPath $resultPath | Should -BeTrue
            $envelope = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json -AsHashtable
            $envelope['schemaVersion'] | Should -Be 'v1'
            $envelope['jobType'] | Should -Be 'assessment'
            $envelope['jobId'] | Should -Be 'job-0001'
            $envelope['runId'] | Should -Be 'run-0001'
            $envelope['requestId'] | Should -Be 'req-0001'
            $envelope['correlationId'] | Should -Be 'corr-0001'
            $envelope['tenantId'] | Should -Be $script:stubTenantId
            $envelope['status'] | Should -Be 'succeeded'
            $envelope['exitCode'] | Should -Be 0
            $envelope['artifactRefs'] | Should -Contain 'stub-artifact.json'
            $envelope.ContainsKey('error') | Should -BeFalse
        }
    }

    Context 'a failed child run' {
        It 'writes a failed result envelope and exits 1 when the assessment throws' {
            $scratch = New-WorkerScratch
            $contextFile = New-WorkerContextFile -Directory $scratch
            $stub = New-WorkerStubAssessment -Directory $scratch -Mode 'Failure'
            $output = Join-Path -Path $scratch -ChildPath 'tenant'

            & pwsh -NoProfile -File $script:runTenant -ContextFile $contextFile -OutputFolder $output -JobId 'job-0002' -RunId 'run-0002' -RequestId 'req-0002' -CorrelationId 'corr-0002' -AssessmentScript $stub | Out-Null
            $LASTEXITCODE | Should -Be 1

            $resultPath = Join-Path -Path $output -ChildPath 'result.json'
            Test-Path -LiteralPath $resultPath | Should -BeTrue
            $envelope = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json -AsHashtable
            $envelope['schemaVersion'] | Should -Be 'v1'
            $envelope['status'] | Should -Be 'failed'
            $envelope['exitCode'] | Should -Be 1
            $envelope['tenantId'] | Should -Be $script:stubTenantId
            $envelope['error']['code'] | Should -Be 'worker.assessment_failed'
            $envelope['error']['message'] | Should -Match 'stub assessment failure'
        }

        It 'writes a failed result envelope and exits 2 when the context file is missing' {
            $scratch = New-WorkerScratch
            $output = Join-Path -Path $scratch -ChildPath 'tenant'

            & pwsh -NoProfile -File $script:runTenant -ContextFile (Join-Path -Path $scratch -ChildPath 'absent.json') -OutputFolder $output -JobId 'job-0003' -RunId 'run-0003' -RequestId 'req-0003' -CorrelationId 'corr-0003' | Out-Null
            $LASTEXITCODE | Should -Be 2

            $resultPath = Join-Path -Path $output -ChildPath 'result.json'
            Test-Path -LiteralPath $resultPath | Should -BeTrue
            $envelope = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json -AsHashtable
            $envelope['status'] | Should -Be 'failed'
            $envelope['exitCode'] | Should -Be 2
            $envelope['error']['code'] | Should -Be 'worker.invalid_context'
        }
    }

    Context 'the worker module handlers' {
        It 'rehydrates the stub context with tenant and sections intact' {
            $scratch = New-WorkerScratch
            $contextFile = New-WorkerContextFile -Directory $scratch
            $ctx = Read-WorkerRunContext -ContextFile $contextFile
            $ctx.Tenant.TenantId | Should -Be $script:stubTenantId
            @($ctx.Scope.Sections) | Should -Contain 'Tenant'
        }

        It 'emits a contract-shaped result envelope' {
            $scratch = New-WorkerScratch
            $output = Join-Path -Path $scratch -ChildPath 'tenant'
            New-Item -Path $output -ItemType Directory -Force | Out-Null
            'x' | Set-Content -Path (Join-Path -Path $output -ChildPath 'report.html') -Encoding UTF8

            $resultPath = Write-WorkerResult -OutputFolder $output -JobId 'job-0004' -TenantId $script:stubTenantId -RunId 'run-0004' -RequestId 'req-0004' -CorrelationId 'corr-0004' -Status 'succeeded' -ExitCode 0 -ArtifactRefs (Get-WorkerArtifacts -OutputFolder $output) -StartedAt '2026-01-01T00:00:00.000Z' -FinishedAt '2026-01-01T00:05:00.000Z'
            Test-Path -LiteralPath $resultPath | Should -BeTrue
            $envelope = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json -AsHashtable
            $envelope['schemaVersion'] | Should -Be 'v1'
            $envelope['artifactRefs'] | Should -Contain 'report.html'
        }

        It 'maps the rehydrated context onto assessment parameters' {
            $scratch = New-WorkerScratch
            $contextFile = New-WorkerContextFile -Directory $scratch
            $ctx = Read-WorkerRunContext -ContextFile $contextFile
            $probe = Join-Path -Path $scratch -ChildPath 'probe.ps1'
            @'
param(
    [string]$OutputFolder = '',
    [string]$TenantId = '',
    [string[]]$Section = @(),
    [Parameter(ValueFromRemainingArguments = $true)]
    $Remaining
)
$ErrorActionPreference = 'Stop'
[ordered]@{ TenantId = $TenantId; Section = @($Section) } | ConvertTo-Json | Set-Content -Path (Join-Path -Path $OutputFolder -ChildPath 'probe.json') -Encoding UTF8
'@ | Set-Content -Path $probe -Encoding UTF8

            $output = Join-Path -Path $scratch -ChildPath 'tenant'
            New-Item -Path $output -ItemType Directory -Force | Out-Null
            Invoke-WorkerAssessment -Context $ctx -OutputFolder $output -AssessmentScript $probe
            $seen = Get-Content -LiteralPath (Join-Path -Path $output -ChildPath 'probe.json') -Raw | ConvertFrom-Json -AsHashtable
            $seen['TenantId'] | Should -Be $script:stubTenantId
            @($seen['Section']) | Should -Contain 'Tenant'
        }
    }
}
