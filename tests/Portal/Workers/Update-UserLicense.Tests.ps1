BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Update-UserLicense.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/update-user-license.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker

    $script:sku = 'sku-e5'

    function script:New-GraphMock {
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body)
            if ($Method -eq 'GET') {
                if ($script:mockMissing) { return $null }
                return [pscustomobject]@{
                    id                = $script:mockUserId
                    displayName       = "User $($script:mockUserId)"
                    userPrincipalName = "$($script:mockUserId)@example.invalid"
                    assignedLicenses  = @($script:mockLicenses | ForEach-Object { [pscustomobject]@{ skuId = $_ } })
                }
            }
            return @{}
        }
    }
}

Describe 'Update-UserLicense worker (T-0645)' {

    BeforeEach {
        $script:mockUserId = 'user-1'
        $script:mockLicenses = @()
        $script:mockMissing = $false
    }

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-UserLicenseChange -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Invoke-UserLicenseBulk -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-UserLicensePreview -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-UserLicenseJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'publishes the action set and the confirmation set' {
            Get-LicenseChangeActions | Should -Be @('assign', 'remove')
            Get-LicenseChangeConfirmation | Should -Be @('remove')
        }

        It 'writes with POST only and never evaluates strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method POST'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'entrypoint reads the job envelope, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Update-UserLicense.ps1'
            $entrySource | Should -Match 'Read-UserLicenseJob -Path'
            $entrySource | Should -Match 'Invoke-UserLicenseBulk'
            $entrySource | Should -Match 'Get-UserLicensePreview'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'state and projection' {
        BeforeEach { script:New-GraphMock }

        It 'reads the assigned licences for a user' {
            $script:mockLicenses = @('sku-e5', 'sku-other')
            $state = Get-UserLicenseState -UserId 'user-1'

            $state.id | Should -Be 'user-1'
            (Test-UserLicenseAssigned -State $state -SkuId 'sku-e5') | Should -BeTrue
            (Test-UserLicenseAssigned -State $state -SkuId 'sku-missing') | Should -BeFalse
        }

        It 'projects assign, remove, and unchanged before/after' {
            $assigned = [pscustomobject]@{ id = 'user-1'; assignedLicenses = @('sku-e5') }
            $unassigned = [pscustomobject]@{ id = 'user-2'; assignedLicenses = @() }

            $assign = Get-UserLicenseProjection -Before $unassigned -SkuId 'sku-e5' -Action 'assign'
            $assign.change | Should -Be 'assign'
            $assign.before.assigned | Should -BeFalse
            $assign.after.assigned | Should -BeTrue

            $remove = Get-UserLicenseProjection -Before $assigned -SkuId 'sku-e5' -Action 'remove'
            $remove.change | Should -Be 'remove'
            $remove.before.assigned | Should -BeTrue
            $remove.after.assigned | Should -BeFalse

            $noop = Get-UserLicenseProjection -Before $assigned -SkuId 'sku-e5' -Action 'assign'
            $noop.change | Should -Be 'unchanged'
        }
    }

    Context 'single change' {
        BeforeEach { script:New-GraphMock }

        It 'refuses an unknown action with a structured error and no Graph call' {
            { Invoke-UserLicenseChange -TenantId 'tenant-a' -UserId 'user-1' -SkuId $script:sku -Action 'grantEverything' } |
                Should -Throw '*licensing.unknown_action*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'requires confirmation for a removal' {
            { Invoke-UserLicenseChange -TenantId 'tenant-a' -UserId 'user-1' -SkuId $script:sku -Action 'remove' } |
                Should -Throw '*licensing.confirm_required*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'plans the intended change with no Graph write on dry run' {
            $result = Invoke-UserLicenseChange -TenantId 'tenant-a' -UserId 'user-1' -SkuId $script:sku -Action 'assign' -DryRun

            $result.state | Should -Be 'planned'
            $result.after.assigned | Should -BeTrue
            $result.change | Should -BeNullOrEmpty
            Should -Invoke Invoke-MgGraphRequest -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        }

        It 'assigns through assignLicense and records a change and an audit event' {
            $script:changes = @()
            $script:audits = @()
            $result = Invoke-UserLicenseChange -TenantId 'tenant-a' -UserId 'user-1' -SkuId $script:sku -Action 'assign' `
                -Actor 'operator-1' -Reason 'ticket-1' -CorrelationId 'corr-1' `
                -NewId { 'change-1' } -Clock { '2026-01-01T00:00:00.000Z' } `
                -WriteChange { param($Change) $script:changes += $Change } `
                -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.state | Should -Be 'applied'
            $result.before.assigned | Should -BeFalse
            $result.after.assigned | Should -BeTrue
            Should -Invoke Invoke-MgGraphRequest -ParameterFilter {
                $Method -eq 'POST' -and $Uri -eq '/v1.0/users/user-1/assignLicense' -and $Body -match 'addLicenses'
            }
            $script:changes.Count | Should -Be 1
            $script:changes[0].state | Should -Be 'applied'
            $script:changes[0].action | Should -Be 'assign'
            $script:changes[0].by | Should -Be 'operator-1'
            $script:audits.Count | Should -Be 1
            $script:audits[0].result | Should -Be 'success'
            $script:audits[0].reason | Should -Be 'ticket-1'
        }

        It 'removes through assignLicense with removeLicenses when confirmed' {
            $script:mockLicenses = @($script:sku)
            $result = Invoke-UserLicenseChange -TenantId 'tenant-a' -UserId 'user-1' -SkuId $script:sku -Action 'remove' -Confirmed

            $result.state | Should -Be 'applied'
            $result.before.assigned | Should -BeTrue
            $result.after.assigned | Should -BeFalse
            Should -Invoke Invoke-MgGraphRequest -ParameterFilter {
                $Method -eq 'POST' -and $Uri -eq '/v1.0/users/user-1/assignLicense' -and $Body -match 'removeLicenses'
            }
        }

        It 'returns a failed row with a failure change and audit when Graph rejects the write' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'GET') {
                    return [pscustomobject]@{
                        id = 'user-1'; displayName = 'User 1'
                        userPrincipalName = 'user-1@example.invalid'; assignedLicenses = @()
                    }
                }
                throw 'Authorization_RequestDenied'
            }
            $script:changes = @()
            $script:audits = @()
            $result = Invoke-UserLicenseChange -TenantId 'tenant-a' -UserId 'user-1' -SkuId $script:sku -Action 'assign' `
                -WriteChange { param($Change) $script:changes += $Change } `
                -WriteAudit { param($AuditEvent) $script:audits += $AuditEvent }

            $result.state | Should -Be 'failed'
            $result.error | Should -Match 'Authorization_RequestDenied'
            $script:changes.Count | Should -Be 1
            $script:changes[0].state | Should -Be 'failed'
            $script:audits.Count | Should -Be 1
            $script:audits[0].result | Should -Be 'failure'
        }

        It 'fails a missing user without a Graph write' {
            $script:mockMissing = $true
            $result = Invoke-UserLicenseChange -TenantId 'tenant-a' -UserId 'user-9' -SkuId $script:sku -Action 'assign'

            $result.state | Should -Be 'failed'
            $result.error | Should -Match 'was not found'
            Should -Invoke Invoke-MgGraphRequest -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        }
    }

    Context 'bulk change' {
        BeforeEach {
            $script:execPlan = @{}
            $script:ExecuteSeam = {
                param($UserId)
                $state = if ($script:execPlan.ContainsKey($UserId)) { $script:execPlan[$UserId] } else { 'applied' }
                return [pscustomobject]@{
                    userId = $UserId; skuId = 'sku-e5'; action = 'assign'; state = $state
                    before = [pscustomobject]@{ assigned = $false }; after = $null
                    error = $(if ($state -eq 'failed') { 'boom' } else { $null })
                    change = [pscustomobject]@{ userId = $UserId; state = $state }
                    auditEvent = [pscustomobject]@{ userId = $UserId; result = $state }
                }
            }
        }

        It 'returns a per-row result for each user' {
            $result = Invoke-UserLicenseBulk -TenantId 'tenant-a' -SkuId $script:sku -Action 'assign' `
                -UserIds @('user-1', 'user-2') -ExecuteChange $script:ExecuteSeam

            $result.rows.Count | Should -Be 2
            $result.summary.applied | Should -Be 2
            $result.changes.Count | Should -Be 2
            $result.auditEvents.Count | Should -Be 2
        }

        It 'stops on the first failure by default and marks the rest skipped' {
            $script:execPlan = @{ 'user-2' = 'failed' }
            $result = Invoke-UserLicenseBulk -TenantId 'tenant-a' -SkuId $script:sku -Action 'assign' `
                -UserIds @('user-1', 'user-2', 'user-3') -ExecuteChange $script:ExecuteSeam

            $result.stoppedOnFailure | Should -BeTrue
            $result.rows[0].state | Should -Be 'applied'
            $result.rows[1].state | Should -Be 'failed'
            $result.rows[2].state | Should -Be 'skipped'
            $result.rows[2].error | Should -Be 'batch-stopped'
            $result.changes.Count | Should -Be 2
        }

        It 'continues past a failure when explicitly overridden' {
            $script:execPlan = @{ 'user-2' = 'failed' }
            $result = Invoke-UserLicenseBulk -TenantId 'tenant-a' -SkuId $script:sku -Action 'assign' `
                -UserIds @('user-1', 'user-2', 'user-3') -ExecuteChange $script:ExecuteSeam -ContinueOnFailure

            $result.stoppedOnFailure | Should -BeFalse
            $result.rows[2].state | Should -Be 'applied'
            $result.summary.applied | Should -Be 2
        }

        It 'plans every row on a dry run without writing changes or audits' {
            script:New-GraphMock
            $result = Invoke-UserLicenseBulk -TenantId 'tenant-a' -SkuId $script:sku -Action 'assign' `
                -UserIds @('user-1', 'user-2') -DryRun

            $result.rows.Count | Should -Be 2
            @($result.rows | Where-Object { $_.state -eq 'planned' }).Count | Should -Be 2
            $result.changes.Count | Should -Be 0
            $result.auditEvents.Count | Should -Be 0
        }
    }

    Context 'plan preview read' {
        BeforeEach { script:New-GraphMock }

        It 'returns the live assigned flag per user for the SKU' {
            $script:mockLicenses = @($script:sku)
            $preview = Get-UserLicensePreview -TenantId 'tenant-a' -SkuId $script:sku -UserIds @('user-1')

            $preview.tenantId | Should -Be 'tenant-a'
            $preview.users.Count | Should -Be 1
            $preview.users[0].assigned | Should -BeTrue
        }

        It 'reports a missing user as not found and unassigned' {
            $script:mockMissing = $true
            $preview = Get-UserLicensePreview -TenantId 'tenant-a' -SkuId $script:sku -UserIds @('user-9')

            $preview.users[0].found | Should -BeFalse
            $preview.users[0].assigned | Should -BeFalse
        }
    }

    Context 'job envelope' {
        It 'reads a plan envelope' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("license-job-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    correlationId = 'corr-1'
                    payload       = @{ operation = 'plan'; skuId = 'sku-e5'; userIds = @('user-1', 'user-2') }
                } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-UserLicenseJob -Path $path

                $job['TenantId'] | Should -Be 'tenant-a'
                $job['Operation'] | Should -Be 'plan'
                $job['SkuId'] | Should -Be 'sku-e5'
                $job['UserIds'].Count | Should -Be 2
                $job['CorrelationId'] | Should -Be 'corr-1'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'reads an apply envelope with confirmation and dry-run flags' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("license-job-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{
                    schemaVersion = 'v1'
                    tenantId      = 'tenant-a'
                    correlationId = 'corr-envelope'
                    payload       = @{ operation = 'apply'; skuId = 'sku-e5'; action = 'remove'; userIds = @('user-1'); confirm = $true; dryRun = $false; correlationId = 'corr-request'; reason = 'ticket-1' }
                } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-UserLicenseJob -Path $path

                $job['Operation'] | Should -Be 'apply'
                $job['Action'] | Should -Be 'remove'
                $job['Confirmed'] | Should -BeTrue
                $job['DryRun'] | Should -BeFalse
                $job['Reason'] | Should -Be 'ticket-1'
                $job['CorrelationId'] | Should -Be 'corr-request'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'accepts a single userId' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("license-job-{0}.json" -f ([guid]::NewGuid()))
            try {
                @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ operation = 'plan'; skuId = 'sku-e5'; userId = 'user-1' } } |
                    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8

                $job = Read-UserLicenseJob -Path $path
                $job['UserIds'] | Should -Be @('user-1')
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects a missing file, bad schema, and missing fields' {
            { Read-UserLicenseJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'no-such-license-job.json') } | Should -Throw

            $badVersion = Join-Path ([System.IO.Path]::GetTempPath()) ("license-job-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a'; payload = @{ operation = 'plan'; skuId = 'sku-e5'; userIds = @('user-1') } } |
                ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $badVersion -Encoding UTF8
            try {
                { Read-UserLicenseJob -Path $badVersion } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $badVersion -Force -ErrorAction SilentlyContinue
            }

            $noUsers = Join-Path ([System.IO.Path]::GetTempPath()) ("license-job-{0}.json" -f ([guid]::NewGuid()))
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ operation = 'plan'; skuId = 'sku-e5' } } |
                ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $noUsers -Encoding UTF8
            try {
                { Read-UserLicenseJob -Path $noUsers } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $noUsers -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'entrypoint' {
        It 'plans a licence change through the direct-parameter mode' {
            script:New-GraphMock
            $json = & $script:entrypoint -TenantId 'tenant-a' -SkuId $script:sku -Action 'assign' -UserIds 'user-1' -DryRun
            $parsed = $json | ConvertFrom-Json

            $parsed.dryRun | Should -BeTrue
            $parsed.rows.Count | Should -Be 1
            $parsed.rows[0].state | Should -Be 'planned'
        }

        It 'applies a removal through the direct-parameter mode with confirmation' {
            $script:mockLicenses = @($script:sku)
            script:New-GraphMock
            $json = & $script:entrypoint -TenantId 'tenant-a' -SkuId $script:sku -Action 'remove' -UserIds 'user-1' -Confirm
            $parsed = $json | ConvertFrom-Json

            $parsed.rows[0].state | Should -Be 'applied'
            $parsed.changes.Count | Should -Be 1
            $parsed.changes[0].action | Should -Be 'remove'
            $parsed.auditEvents.Count | Should -Be 1
        }
    }
}

Describe 'Update-UserLicense Graph URIs (T-0897)' {
    BeforeEach {
        $script:mockUserId = 'user-1'
        $script:mockLicenses = @()
        $script:mockMissing = $false
        script:New-GraphMock
    }

    It 'reads the license state at the exact user URI with a literal $select' {
        $null = Get-UserLicenseState -UserId 'user-1'

        Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'GET' -and $Uri -ceq '/v1.0/users/user-1?$select=id,displayName,userPrincipalName,assignedLicenses'
        }
    }

    It 'uses that URI when a license change runs' {
        $null = Invoke-UserLicenseChange -TenantId 'tenant-a' -UserId 'user-1' -SkuId $script:sku -Action 'assign' -DryRun

        Should -Invoke Invoke-MgGraphRequest -ParameterFilter {
            $Method -eq 'GET' -and $Uri -ceq '/v1.0/users/user-1?$select=id,displayName,userPrincipalName,assignedLicenses'
        }
    }
}
