BeforeAll {
    $script:repoRoot = (Resolve-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
    $script:worker = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/run-custom-script.ps1'
    $script:scratchRoots = @()

    function script:New-Scratch {
        $root = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("m365-script-worker-test-{0}" -f [guid]::NewGuid().ToString('N'))
        New-Item -Path $root -ItemType Directory -Force | Out-Null
        $script:scratchRoots += $root
        return $root
    }

    function script:New-JobFile {
        param(
            [Parameter(Mandatory)]
            [string]$Directory,

            [Parameter(Mandatory)]
            [hashtable]$Job
        )
        $jobFile = Join-Path -Path $Directory -ChildPath 'job.json'
        $Job | ConvertTo-Json -Depth 10 | Set-Content -Path $jobFile -Encoding UTF8
        return $jobFile
    }
}

AfterAll {
    foreach ($root in $script:scratchRoots) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'run-custom-script.ps1 worker entrypoint (T-0837)' {

    Context 'the entrypoint' {
        It 'exists alongside the worker module' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
        }

        It 'dot-sources the sandbox handler and emits JSON' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-SandboxedScript'
            $source | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'a successful script run' {
        It 'runs the script and returns output, exit code, and duration' {
            $scratch = New-Scratch
            $job = @{
                content    = "Write-Output 'hello-custom-script'"
                tenantId  = '00000000-0000-0000-0000-000000000001'
                dryRun     = $true
                parameters = @{ dryRunContract = $true }
            }
            $jobFile = New-JobFile -Directory $scratch -Job $job

            $stdout = & pwsh -NoProfile -File $script:worker -JobFile $jobFile
            $LASTEXITCODE | Should -Be 0

            $result = $stdout | ConvertFrom-Json
            $result.output | Should -Match 'hello-custom-script'
            $result.exitCode | Should -Be 0
            $result.error | Should -BeNullOrEmpty
            $result.durationMs | Should -Not -BeNullOrEmpty
        }
    }

    Context 'a policy violation' {
        It 'reports the violation as exit code 1 with the error message' {
            $scratch = New-Scratch
            $job = @{
                content    = "Get-Content -LiteralPath '/etc/hostname'"
                tenantId  = '00000000-0000-0000-0000-000000000001'
                dryRun     = $false
                parameters = $null
            }
            $jobFile = New-JobFile -Directory $scratch -Job $job

            $stdout = & pwsh -NoProfile -File $script:worker -JobFile $jobFile
            $LASTEXITCODE | Should -Be 0

            $result = $stdout | ConvertFrom-Json
            $result.exitCode | Should -Be 1
            $result.error | Should -Match 'sandbox.policy_violation'
        }
    }

    Context 'the dry-run flag' {
        It 'passes the dryRun flag through to the script' {
            $scratch = New-Scratch
            $job = @{
                content    = 'Write-Output "dryRun=$dryRun"'
                tenantId  = '00000000-0000-0000-0000-000000000001'
                dryRun     = $true
                parameters = @{ dryRunContract = $true }
            }
            $jobFile = New-JobFile -Directory $scratch -Job $job

            $stdout = & pwsh -NoProfile -File $script:worker -JobFile $jobFile
            $LASTEXITCODE | Should -Be 0

            $result = $stdout | ConvertFrom-Json
            $result.output | Should -Match 'dryRun=True'
        }
    }

    Context 'script parameters' {
        It 'injects parameters as variables into the sandbox' {
            $scratch = New-Scratch
            $job = @{
                content    = 'Write-Output "param=$myParam"'
                tenantId  = '00000000-0000-0000-0000-000000000001'
                dryRun     = $false
                parameters = @{ myParam = 'test-value' }
            }
            $jobFile = New-JobFile -Directory $scratch -Job $job

            $stdout = & pwsh -NoProfile -File $script:worker -JobFile $jobFile
            $LASTEXITCODE | Should -Be 0

            $result = $stdout | ConvertFrom-Json
            $result.output | Should -Match 'param=test-value'
        }
    }
}
