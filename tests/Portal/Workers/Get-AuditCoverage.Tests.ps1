BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-AuditCoverage.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-audit-coverage.ps1'

    function global:Get-AdminAuditLogConfig {
        param()
    }

    . $script:worker
    . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

    $script:finding = @{
        id      = 'finding-1'
        runId   = 'run-1'
        checkId = 'COMPLIANCE-AUDIT-001'
    }
}

Describe 'Get-AuditCoverage worker (T-0624)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-AuditCoverage -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-AuditCoverageJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Connect-WorkerPurview -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Disconnect-WorkerPurview -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: reads audit config and invokes no mutating audit cmdlets' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-AdminAuditLogConfig'
            $source | Should -Not -Match '(?m)^\s*(Set|New|Remove|Enable|Disable|Update|Add)-AdminAuditLogConfig'
        }

        It 'never persists coverage state to disk, logs, or artifacts' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Export-Clixml'
            $source | Should -Not -Match 'Add-Content'
            $source | Should -Not -Match 'Set-Content'
            $source | Should -Not -Match 'Start-Transcript'
            $source | Should -Not -Match 'Tee-Object'
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Not -Match 'Out-File'
            $entrySource | Should -Not -Match 'Start-Transcript'
        }

        It 'entrypoint connects Purview in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-AuditCoverage\.ps1'
            $entrySource | Should -Match 'Connect-WorkerPurview -JobFile \$JobFile'
            $entrySource | Should -Match 'Read-AuditCoverageJob -Path'
            $entrySource | Should -Match 'Get-AuditCoverage -TenantId \$TenantId -LastSearchAt \$LastSearchAt -Finding \$Finding'
            $entrySource | Should -Match 'ConvertTo-Json'
            $entrySource | Should -Match 'Disconnect-WorkerPurview'
        }
    }

    Context 'the job envelope reader' {
        It 'reads the tenant and portal-side inputs from the envelope' {
            $envelope = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ([guid]::NewGuid().ToString() + '.json')
            try {
                @{
                    tenantId      = 'tenant-a'
                    lastSearchAt = '2026-09-20T10:00:00Z'
                    finding      = $script:finding
                } | ConvertTo-Json | Set-Content -LiteralPath $envelope

                $job = Read-AuditCoverageJob -Path $envelope
                $job['TenantId'] | Should -Be 'tenant-a'
                $job['LastSearchAt'] | Should -Be '2026-09-20T10:00:00Z'
                $job['Finding'] | Should -Not -BeNullOrEmpty
            }
            finally {
                Remove-Item -LiteralPath $envelope -Force -ErrorAction SilentlyContinue
            }
        }

        It 'defaults lastSearchAt to empty and finding to null when absent' {
            $envelope = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ([guid]::NewGuid().ToString() + '.json')
            try {
                @{ tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -LiteralPath $envelope

                $job = Read-AuditCoverageJob -Path $envelope
                $job['LastSearchAt'] | Should -Be ''
                $job['Finding'] | Should -BeNullOrEmpty
            }
            finally {
                Remove-Item -LiteralPath $envelope -Force -ErrorAction SilentlyContinue
            }
        }

        It 'throws when the envelope is missing tenantId' {
            $envelope = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ([guid]::NewGuid().ToString() + '.json')
            try {
                @{ lastSearchAt = '2026-09-20T10:00:00Z' } | ConvertTo-Json | Set-Content -LiteralPath $envelope

                { Read-AuditCoverageJob -Path $envelope } | Should -Throw "*missing mandatory 'tenantId'*"
            }
            finally {
                Remove-Item -LiteralPath $envelope -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'coverage computation' {
        It 'reports auditEnabled true with no gaps when ingestion is enabled' {
            Mock Get-AdminAuditLogConfig {
                return @{ UnifiedAuditLogIngestionEnabled = $true }
            }

            $result = Get-AuditCoverage -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.auditEnabled | Should -BeTrue
            $result.lastSearchAt | Should -BeNullOrEmpty
            $result.gaps | Should -HaveCount 0
        }

        It 'carries the portal last-search instant through' {
            Mock Get-AdminAuditLogConfig {
                return @{ UnifiedAuditLogIngestionEnabled = $true }
            }

            $result = Get-AuditCoverage -TenantId 'tenant-a' -LastSearchAt '2026-09-20T10:00:00Z'

            $result.lastSearchAt | Should -Be '2026-09-20T10:00:00Z'
        }

        It 'treats a string "False" flag as disabled' {
            Mock Get-AdminAuditLogConfig {
                return @{ UnifiedAuditLogIngestionEnabled = 'False' }
            }

            $result = Get-AuditCoverage -TenantId 'tenant-a'
            $result.auditEnabled | Should -BeFalse
            $result.gaps | Should -HaveCount 1
        }
    }

    Context 'gaps when audit logging is disabled' {
        It 'yields one COMPLIANCE-AUDIT-001 gap linking the EPIC-006 remediation' {
            Mock Get-AdminAuditLogConfig {
                return @{ UnifiedAuditLogIngestionEnabled = $false }
            }

            $result = Get-AuditCoverage -TenantId 'tenant-a'

            $result.auditEnabled | Should -BeFalse
            $result.gaps | Should -HaveCount 1
            $gap = $result.gaps[0]
            $gap.checkId | Should -Be 'COMPLIANCE-AUDIT-001'
            $gap.remediation | Should -Match 'EPIC-006'
            $gap.remediation | Should -Match 'Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled \$true'
            $gap.findingId | Should -BeNullOrEmpty
            $gap.runId | Should -BeNullOrEmpty
        }

        It 'references the run-results finding when the caller supplies one' {
            Mock Get-AdminAuditLogConfig {
                return @{ UnifiedAuditLogIngestionEnabled = $false }
            }

            $result = Get-AuditCoverage -TenantId 'tenant-a' -Finding $script:finding

            $gap = $result.gaps[0]
            $gap.checkId | Should -Be 'COMPLIANCE-AUDIT-001'
            $gap.findingId | Should -Be 'finding-1'
            $gap.runId | Should -Be 'run-1'
        }
    }
}
