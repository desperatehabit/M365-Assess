# Invoke-CustomTest.Tests.ps1
# Pester tests for T-0707 — sandboxed custom-test dry-run/run and markdown output rendering.

#Requires -Module Pester
Set-StrictMode -Version Latest

Describe 'Invoke-CustomTest (T-0707)' {
    BeforeAll {
        $script:repoRoot = (Resolve-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
        $script:handler = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/Invoke-CustomTest.ps1'
        . $script:handler
    }

    Context 'dry-run execution' {
        It 'executes in the sandbox and returns rendered markdown without persisting state' {
            $script = @'
$out = @{
    name = "Test-Compliance"
    status = "Pass"
    details = "All controls met"
}
$out | ConvertTo-Json -Compress
'@
            $template = "### {{ name }}`nResult: {{ status }}`nNotes: {{ details }}"

            $result = Invoke-CustomTest -ScriptContent $script `
                -MarkdownTemplate $template `
                -TenantId 'tenant-1' `
                -DryRun

            $result.Success | Should -Be $true
            $result.Status | Should -Be 'Pass'
            $result.DryRun | Should -Be $true
            $result.RenderedMarkdown | Should -Be "### Test-Compliance`nResult: Pass`nNotes: All controls met"
        }

        It 'dry-run does not require gate confirmation even when writes are declared' {
            $script = @'
@{ status = "Pass"; note = "simulation" } | ConvertTo-Json -Compress
'@
            $result = Invoke-CustomTest -ScriptContent $script `
                -TenantId 'tenant-1' `
                -Writes `
                -DryRun

            $result.Success | Should -Be $true
            $result.DryRun | Should -Be $true
        }
    }

    Context 'live run execution' {
        It 'executes in the sandbox and records a passing result' {
            $script = @'
@{ status = "Pass"; score = 100 } | ConvertTo-Json -Compress
'@
            $result = Invoke-CustomTest -ScriptContent $script -TenantId 'tenant-1'

            $result.Success | Should -Be $true
            $result.Status | Should -Be 'Pass'
            $result.DryRun | Should -Be $false
            $result.ExitCode | Should -Be 0
        }

        It 'records a failing result when script reports failure' {
            $script = @'
@{ status = "Fail"; error = "Check failed" } | ConvertTo-Json -Compress
'@
            $result = Invoke-CustomTest -ScriptContent $script -TenantId 'tenant-1'

            $result.Success | Should -Be $false
            $result.Status | Should -Be 'Fail'
            $result.DryRun | Should -Be $false
        }
    }

    Context 'EPIC-006 write gating' {
        It 'refuses live run with writes when unconfirmed' {
            $script = 'Write-Output "trying to write"'
            {
                Invoke-CustomTest -ScriptContent $script -TenantId 'tenant-1' -Writes
            } | Should -Throw "*remediation.gate_required*"
        }

        It 'refuses live run when parameters declare writes without confirmation' {
            $script = 'Write-Output "trying to write"'
            {
                Invoke-CustomTest -ScriptContent $script -TenantId 'tenant-1' -Parameters @{ writes = $true }
            } | Should -Throw "*remediation.gate_required*"
        }

        It 'permits live run with writes when confirmed' {
            $script = '@{ status = "Pass" } | ConvertTo-Json -Compress'
            $result = Invoke-CustomTest -ScriptContent $script -TenantId 'tenant-1' -Writes -Confirmed

            $result.Success | Should -Be $true
            $result.Status | Should -Be 'Pass'
        }
    }

    Context 'unsandboxed write and policy enforcement' {
        It 'refuses when unsandboxed execution is requested' {
            {
                Invoke-CustomTest -ScriptContent 'Write-Output "hi"' -TenantId 'tenant-1' -Unsandboxed
            } | Should -Throw "*custom_test.unsandboxed_write_refused*"
        }

        It 'refuses disallowed commands via sandbox allowlist' {
            $script = 'Start-Process -FilePath "pwsh"'
            $result = Invoke-CustomTest -ScriptContent $script -TenantId 'tenant-1'

            $result.Success | Should -Be $false
            $result.Status | Should -Be 'Fail'
            $result.Error | Should -Match 'sandbox\.policy_violation'
        }

        It 'refuses unsandboxed network or filesystem cmdlets' {
            $script = 'Invoke-WebRequest -Uri "https://example.invalid"'
            $result = Invoke-CustomTest -ScriptContent $script -TenantId 'tenant-1'

            $result.Success | Should -Be $false
            $result.Status | Should -Be 'Fail'
            $result.Error | Should -Match 'sandbox\.policy_violation'
        }
    }

    Context 'markdown template rendering' {
        It 'renders collections and missing tokens via Format-ScriptOutput' {
            $script = @'
@{
    title = "Audit Summary"
    items = @(
        @{ name = "Rule1" },
        @{ name = "Rule2" }
    )
} | ConvertTo-Json -Compress
'@
            $template = "# {{ title }}`n{{#each items}}- {{ name }}`n{{/each}}"
            $result = Invoke-CustomTest -ScriptContent $script -MarkdownTemplate $template -TenantId 'tenant-1'

            $result.RenderedMarkdown | Should -Be "# Audit Summary`n- Rule1`n- Rule2`n"
        }
    }

    Context 'job envelope invocation' {
        It 'reads job file and outputs JSON result' {
            $tempFile = [System.IO.Path]::GetTempFileName()
            try {
                $job = @{
                    scriptContent    = '@{ status = "Pass"; value = 42 } | ConvertTo-Json -Compress'
                    markdownTemplate = 'Result: {{ value }}'
                    tenantId         = 'tenant-1'
                    dryRun           = $true
                } | ConvertTo-Json -Compress
                Set-Content -LiteralPath $tempFile -Value $job -Encoding UTF8

                $output = pwsh -NoProfile -NonInteractive -File $script:handler -JobFile $tempFile
                $parsed = $output | ConvertFrom-Json
                $parsed.Success | Should -Be $true
                $parsed.Status | Should -Be 'Pass'
                $parsed.RenderedMarkdown | Should -Be 'Result: 42'
                $parsed.DryRun | Should -Be $true
            }
            finally {
                Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
