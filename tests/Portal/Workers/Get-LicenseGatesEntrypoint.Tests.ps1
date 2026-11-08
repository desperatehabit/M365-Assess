BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-LicenseGates.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-license-gates.ps1'

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')
}

Describe 'get-license-gates entrypoint (T-0863)' {
    It 'ships the wrapper beside the implementation' {
        Test-Path -LiteralPath $script:worker | Should -BeTrue
        Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
        (Get-Command Get-LicenseGates -CommandType Function) | Should -Not -BeNullOrEmpty
        (Get-Command Read-LicenseGatesJob -CommandType Function) | Should -Not -BeNullOrEmpty
    }

    It 'reads the tenant from the job and emits the gate map' {
        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }
        Mock Get-LicenseGates {
            param($TenantId)
            [pscustomobject]@{
                tenantId = $TenantId
                gates    = [ordered]@{
                    'FEATURE-X' = [pscustomobject]@{
                        status        = 'gated'
                        requiredPlans = @('PLAN-A')
                        missingPlans  = @('PLAN-A')
                    }
                }
            }
        }

        $tempFile = [System.IO.Path]::GetTempFileName()
        try {
            @{ tenantId = 'tenant-xyz' } | ConvertTo-Json | Set-Content -LiteralPath $tempFile
            $json = & $script:entrypoint -JobFile $tempFile
            $parsed = $json | ConvertFrom-Json
            $parsed.tenantId | Should -Be 'tenant-xyz'
            $parsed.gates.'FEATURE-X'.status | Should -Be 'gated'
            Should -Invoke Get-LicenseGates -Times 1 -ParameterFilter { $TenantId -eq 'tenant-xyz' }
        }
        finally {
            Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
        }
    }

    It 'throws when the envelope has no tenantId' {
        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }

        $tempFile = [System.IO.Path]::GetTempFileName()
        try {
            @{ } | ConvertTo-Json | Set-Content -LiteralPath $tempFile
            { & $script:entrypoint -JobFile $tempFile } | Should -Throw
        }
        finally {
            Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
        }
    }
}
