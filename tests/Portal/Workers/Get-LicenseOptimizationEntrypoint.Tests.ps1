BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-LicenseOptimization.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-license-optimization.ps1'

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')
}

Describe 'get-license-optimization entrypoint (T-0863)' {
    It 'ships the wrapper beside the implementation' {
        Test-Path -LiteralPath $script:worker | Should -BeTrue
        Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
        (Get-Command Get-LicenseOptimization -CommandType Function) | Should -Not -BeNullOrEmpty
        (Get-Command Read-LicenseOptimizationJob -CommandType Function) | Should -Not -BeNullOrEmpty
    }

    It 'reads the job inactivity window and emits the worker result' {
        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }
        Mock Get-LicenseOptimization {
            param($TenantId, $InactivityDays)
            [pscustomobject]@{
                tenantId       = $TenantId
                inactivityDays = $InactivityDays
                assignments    = @()
            }
        }

        $tempFile = [System.IO.Path]::GetTempFileName()
        try {
            @{ tenantId = 'tenant-xyz'; inactivityDays = 45 } | ConvertTo-Json | Set-Content -LiteralPath $tempFile
            $json = & $script:entrypoint -JobFile $tempFile
            $parsed = $json | ConvertFrom-Json
            $parsed.tenantId | Should -Be 'tenant-xyz'
            $parsed.inactivityDays | Should -Be 45
            Should -Invoke Get-LicenseOptimization -Times 1 -ParameterFilter { $InactivityDays -eq 45 }
        }
        finally {
            Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
        }
    }

    It 'defaults the inactivity window when the envelope omits it' {
        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }
        Mock Get-LicenseOptimization {
            param($TenantId, $InactivityDays)
            [pscustomobject]@{ tenantId = $TenantId; inactivityDays = $InactivityDays }
        }

        $tempFile = [System.IO.Path]::GetTempFileName()
        try {
            @{ tenantId = 'tenant-xyz' } | ConvertTo-Json | Set-Content -LiteralPath $tempFile
            $parsed = (& $script:entrypoint -JobFile $tempFile) | ConvertFrom-Json
            $parsed.inactivityDays | Should -Be 30
        }
        finally {
            Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
        }
    }
}
