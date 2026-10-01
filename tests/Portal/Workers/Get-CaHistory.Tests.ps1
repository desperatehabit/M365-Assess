BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-CaHistory.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-ca-history.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    function New-CaAuditEntry {
        param(
            [string]$Id,
            [string]$Activity,
            [string]$Timestamp,
            [string]$PolicyId = 'pol-1',
            [string]$PolicyName = 'Require MFA',
            [string]$InitiatorUpn = '',
            [string]$AppDisplayName = '',
            [string]$Result = 'success'
        )

        $initiatedBy = $null
        if ($InitiatorUpn) {
            $initiatedBy = [pscustomobject]@{ user = [pscustomobject]@{ userPrincipalName = $InitiatorUpn } }
        }
        elseif ($AppDisplayName) {
            $initiatedBy = [pscustomobject]@{ app = [pscustomobject]@{ displayName = $AppDisplayName } }
        }

        return [pscustomobject]@{
            id                  = $Id
            activityDisplayName = $Activity
            activityDateTime    = $Timestamp
            category            = 'PolicyManagement'
            result              = $Result
            initiatedBy         = $initiatedBy
            targetResources     = @(
                [pscustomobject]@{
                    id                = $PolicyId
                    displayName       = $PolicyName
                    '@odata.type'     = '#microsoft.graph.policy'
                    modifiedProperties = @()
                }
            )
        }
    }

    . $script:worker
}

Describe 'Get-CaHistory worker (T-0830)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-CaHistory -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-CaHistoryJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }
    }

    Context 'Job envelope reading' {
        It 'throws when envelope does not exist' {
            { Read-CaHistoryJob -Path '/path/does/not/exist.json' } | Should -Throw "*not found*"
        }

        It 'throws when tenantId is missing' {
            $tmp = New-TemporaryFile
            Set-Content -LiteralPath $tmp.FullName -Value '{"policyId":"pol-1"}'
            try {
                { Read-CaHistoryJob -Path $tmp.FullName } | Should -Throw "*missing mandatory 'tenantId'*"
            }
            finally {
                Remove-Item -LiteralPath $tmp.FullName -Force -ErrorAction SilentlyContinue
            }
        }

        It 'reads tenantId, policyId, and top from the envelope' {
            $tmp = New-TemporaryFile
            Set-Content -LiteralPath $tmp.FullName -Value '{"tenantId":"tenant-test","policyId":"pol-1","top":25}'
            try {
                $job = Read-CaHistoryJob -Path $tmp.FullName
                $job.TenantId | Should -Be 'tenant-test'
                $job.PolicyId | Should -Be 'pol-1'
                $job.Top | Should -Be 25
            }
            finally {
                Remove-Item -LiteralPath $tmp.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'Directory audit query' {
        It 'queries directoryAudits filtered to the CA policy activities' {
            $script:seenUri = $null
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                $Method | Should -Be 'GET'
                $script:seenUri = $Uri
                return [pscustomobject]@{ value = @() }
            }

            $null = Get-CaHistory -TenantId 'tenant-test'

            $decoded = [uri]::UnescapeDataString($script:seenUri)
            $decoded | Should -Match 'auditLogs/directoryAudits'
            $decoded | Should -Match "activityDisplayName eq 'Add conditional access policy'"
            $decoded | Should -Match "activityDisplayName eq 'Update conditional access policy'"
            $decoded | Should -Match "activityDisplayName eq 'Delete conditional access policy'"
        }

        It 'returns CA policy changes in the CaPolicyChangeRecord shape with source directoryAudit' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                return [pscustomobject]@{
                    value = @(
                        New-CaAuditEntry -Id 'audit-1' -Activity 'Add conditional access policy' -Timestamp '2026-09-01T00:00:00Z' -PolicyId 'pol-1' -PolicyName 'Require MFA' -InitiatorUpn 'admin@contoso.com'
                        New-CaAuditEntry -Id 'audit-2' -Activity 'Update conditional access policy' -Timestamp '2026-09-02T00:00:00Z' -PolicyId 'pol-1' -PolicyName 'Require MFA' -InitiatorUpn 'admin@contoso.com'
                        New-CaAuditEntry -Id 'audit-3' -Activity 'Delete conditional access policy' -Timestamp '2026-09-03T00:00:00Z' -PolicyId 'pol-2' -PolicyName 'Block Legacy' -InitiatorUpn 'admin@contoso.com'
                    )
                }
            }

            $res = Get-CaHistory -TenantId 'tenant-test'
            $res.tenantId | Should -Be 'tenant-test'
            $res.totalCount | Should -Be 3

            $res.items[0].id | Should -Be 'audit-3'
            $res.items[0].source | Should -Be 'directoryAudit'
            $res.items[0].policyId | Should -Be 'pol-2'
            $res.items[0].policyName | Should -Be 'Block Legacy'
            $res.items[0].timestamp | Should -Be '2026-09-03T00:00:00Z'
            $res.items[0].initiatedBy | Should -Be 'admin@contoso.com'
            $res.items[0].action | Should -Be 'ca.policy.delete'
            $res.items[0].before | Should -BeNullOrEmpty
            $res.items[0].after | Should -BeNullOrEmpty
            $res.items[0].rawAudit.activity | Should -Be 'Delete conditional access policy'
            $res.items[0].rawAudit.category | Should -Be 'PolicyManagement'

            $res.items[2].action | Should -Be 'ca.policy.create'
        }

        It 'falls back to the app display name, then System, for initiatedBy' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                return [pscustomobject]@{
                    value = @(
                        New-CaAuditEntry -Id 'audit-app' -Activity 'Add conditional access policy' -Timestamp '2026-09-01T00:00:00Z' -AppDisplayName 'My CA Tool'
                        New-CaAuditEntry -Id 'audit-sys' -Activity 'Add conditional access policy' -Timestamp '2026-09-02T00:00:00Z'
                    )
                }
            }

            $res = Get-CaHistory -TenantId 'tenant-test'
            $res.items[0].initiatedBy | Should -Be 'System'
            $res.items[1].initiatedBy | Should -Be 'My CA Tool'
        }

        It 'narrows the history to one policy when PolicyId is given' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                return [pscustomobject]@{
                    value = @(
                        New-CaAuditEntry -Id 'audit-1' -Activity 'Add conditional access policy' -Timestamp '2026-09-01T00:00:00Z' -PolicyId 'pol-1'
                        New-CaAuditEntry -Id 'audit-2' -Activity 'Add conditional access policy' -Timestamp '2026-09-02T00:00:00Z' -PolicyId 'pol-2'
                    )
                }
            }

            $res = Get-CaHistory -TenantId 'tenant-test' -PolicyId 'pol-1'
            $res.totalCount | Should -Be 1
            $res.items[0].policyId | Should -Be 'pol-1'
        }

        It 'follows @odata.nextLink pages' {
            $page1 = @(New-CaAuditEntry -Id 'audit-1' -Activity 'Add conditional access policy' -Timestamp '2026-09-01T00:00:00Z' -InitiatorUpn 'admin@contoso.com')
            $page2 = @(New-CaAuditEntry -Id 'audit-2' -Activity 'Update conditional access policy' -Timestamp '2026-09-02T00:00:00Z' -InitiatorUpn 'admin@contoso.com')
            $script:uris = @()
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                $script:uris += $Uri
                if ($Uri -like '*page=2*') {
                    return [pscustomobject]@{ value = $page2 }
                }
                return [pscustomobject]@{ value = $page1; '@odata.nextLink' = 'https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?page=2' }
            }

            $res = Get-CaHistory -TenantId 'tenant-test'
            $script:uris.Count | Should -Be 2
            $res.totalCount | Should -Be 2
            $res.items[0].id | Should -Be 'audit-2'
        }

        It 'caps the result at Top, newest first' {
            $auditEntries = @()
            for ($i = 1; $i -le 5; $i++) {
                $auditEntries += New-CaAuditEntry -Id "audit-$i" -Activity 'Add conditional access policy' -Timestamp "2026-09-0${i}T00:00:00Z"
            }
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri)
                return [pscustomobject]@{ value = $auditEntries }
            }

            $res = Get-CaHistory -TenantId 'tenant-test' -Top 2
            $res.totalCount | Should -Be 2
            $res.items[0].id | Should -Be 'audit-5'
            $res.items[1].id | Should -Be 'audit-4'
        }
    }
}
