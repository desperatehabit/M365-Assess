BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-DomainAction.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/domain-action.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker

    $script:domainState = @{}
    $script:auditEvents = [System.Collections.Generic.List[object]]::new()

    function script:New-DomainActionMock {
        param(
            [switch]$NoDomain,
            [switch]$GraphFails
        )
        $script:mockNoDomain = [bool]$NoDomain
        $script:mockGraphFails = [bool]$GraphFails
        Mock Invoke-MgGraphRequest {
            param($Method, $Uri, $Body)
            if ($script:mockGraphFails) {
                throw 'graph unavailable'
            }
            if ($Method -eq 'GET' -and $Uri -match '^/v1\.0/domains/([^/]+)$') {
                $name = $Matches[1]
                if ($script:mockNoDomain -or -not $script:domainState.ContainsKey($name)) {
                    throw "domain '$name' not found"
                }
                return $script:domainState[$name]
            }
            if ($Method -eq 'POST' -and $Uri -eq '/v1.0/domains') {
                $parsed = $Body | ConvertFrom-Json
                $script:domainState[$parsed.id] = @{ id = $parsed.id; isVerified = $false; isDefault = $false }
                return @{
                    id = $parsed.id
                    isVerified = $false
                    isDefault = $false
                    verificationRecords = @(
                        @{ recordType = 'Txt'; label = $parsed.id; text = 'MS=ms987654321'; ttl = 3600 }
                        @{ recordType = 'Mx'; label = $parsed.id; mailExchange = 'contoso-com.mail.protection.outlook.com'; preference = 0; ttl = 3600 }
                    )
                }
            }
            if ($Method -eq 'POST' -and $Uri -match '^/v1\.0/domains/([^/]+)/verify$') {
                $name = $Matches[1]
                $script:domainState[$name].isVerified = $true
                return @{ id = $name; isVerified = $true; isDefault = $script:domainState[$name].isDefault }
            }
            if ($Method -eq 'PATCH' -and $Uri -match '^/v1\.0/domains/([^/]+)$') {
                $name = $Matches[1]
                $script:domainState[$name].isDefault = $true
                return @{ id = $name; isVerified = $script:domainState[$name].isVerified; isDefault = $true }
            }
            if ($Method -eq 'DELETE' -and $Uri -match '^/v1\.0/domains/([^/]+)$') {
                $name = $Matches[1]
                $script:domainState.Remove($name)
                return $null
            }
            return @{ id = 'ok' }
        }
    }

    function script:New-AuditSeam {
        $script:auditEvents.Clear()
        return {
            param($AuditEvent)
            $script:auditEvents.Add($AuditEvent)
        }.GetNewClosure()
    }
}

Describe 'Invoke-DomainAction worker (T-0663)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-DomainAction -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-DomainActionJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Add-Domain -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Verify-Domain -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Remove-Domain -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Set-DomainDefault -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'publishes the section-3.1 action set' {
            Get-DomainActions | Should -Be @('add', 'verify', 'remove', 'setDefault')
        }

        It 'writes with POST, PATCH, and DELETE only and never evaluates strings as code' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method POST'
            $source | Should -Match 'Invoke-MgGraphRequest -Method PATCH'
            $source | Should -Match 'Invoke-MgGraphRequest -Method DELETE'
            $source | Should -Not -Match '-Method PUT'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'never persists user data to disk, logs, or transcripts' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Export-Clixml'
            $source | Should -Not -Match 'Add-Content'
            $source | Should -Not -Match 'Set-Content'
            $source | Should -Not -Match 'Start-Transcript'
            $source | Should -Not -Match 'Write-Host'
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Not -Match 'Out-File'
            $entrySource | Should -Not -Match 'Start-Transcript'
            $entrySource | Should -Not -Match 'Write-Host'
        }

        It 'entrypoint reads the job envelope, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Invoke-DomainAction.ps1'
            $entrySource | Should -Match 'Read-DomainActionJob -Path'
            $entrySource | Should -Match 'Invoke-DomainAction'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'add dispatch' {
        BeforeEach {
            script:New-DomainActionMock
        }

        It 'requires the tenant and domain identifiers' {
            { Add-Domain -TenantId '' -Domain 'contoso.com' -Confirmed } | Should -Throw
            { Add-Domain -TenantId 'tenant-a' -Domain '' -Confirmed } | Should -Throw
        }

        It 'refuses to add without confirmation' {
            { Add-Domain -TenantId 'tenant-a' -Domain 'contoso.com' } | Should -Throw '*domains.confirm_required*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'plans the add on dry run with no Graph write and no audit' {
            $seam = script:New-AuditSeam
            $result = Add-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -DryRun -WriteAudit $seam
            $result.status | Should -Be 'planned'
            $result.verificationRecords | Should -BeNullOrEmpty
            $result.auditEvent | Should -BeNullOrEmpty
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
            $script:auditEvents.Count | Should -Be 0
        }

        It 'adds the domain, returns the verification records, and leaves it unverified' {
            $seam = script:New-AuditSeam
            $result = Add-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed -WriteAudit $seam
            $result.status | Should -Be 'applied'
            $result.verificationRecords | Should -HaveCount 2
            $result.verificationRecords[0].recordType | Should -Be 'Txt'
            $result.verificationRecords[1].recordType | Should -Be 'Mx'
            $script:domainState['contoso.com'].isVerified | Should -BeFalse
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Uri -eq '/v1.0/domains' }
        }

        It 'writes one success audit event on add' {
            $seam = script:New-AuditSeam
            $null = Add-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed -Actor 'user-1' -CorrelationId 'corr-1' -WriteAudit $seam
            $script:auditEvents.Count | Should -Be 1
            $script:auditEvents[0].action | Should -Be 'domains.action:add'
            $script:auditEvents[0].targetType | Should -Be 'domain'
            $script:auditEvents[0].targetId | Should -Be 'contoso.com'
            $script:auditEvents[0].result | Should -Be 'success'
            $script:auditEvents[0].actor | Should -Be 'user-1'
            $script:auditEvents[0].correlationId | Should -Be 'corr-1'
        }

        It 'refuses an existing domain with a structured code and no POST' {
            $null = Add-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed
            $seam = script:New-AuditSeam
            $result = Add-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed -WriteAudit $seam
            $result.status | Should -Be 'failed'
            $result.code | Should -Be 'domain_already_exists'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
            $script:auditEvents[0].result | Should -Be 'failure'
        }

        It 'returns a failed result with a failure audit when the Graph write fails' {
            script:New-DomainActionMock -GraphFails
            $seam = script:New-AuditSeam
            $result = Add-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed -WriteAudit $seam
            $result.status | Should -Be 'failed'
            $result.error | Should -Match 'graph unavailable'
            $script:auditEvents.Count | Should -Be 1
            $script:auditEvents[0].result | Should -Be 'failure'
        }
    }

    Context 'verify dispatch' {
        BeforeEach {
            script:New-DomainActionMock
            $null = Add-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed
            $script:auditEvents.Clear()
        }

        It 'refuses to verify without confirmation' {
            { Verify-Domain -TenantId 'tenant-a' -Domain 'contoso.com' } | Should -Throw '*domains.confirm_required*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Uri -like '*/verify' }
        }

        It 'verifies the domain and writes one success audit event' {
            $seam = script:New-AuditSeam
            $result = Verify-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed -WriteAudit $seam
            $result.status | Should -Be 'applied'
            $script:domainState['contoso.com'].isVerified | Should -BeTrue
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Uri -like '*/verify' }
            $script:auditEvents.Count | Should -Be 1
            $script:auditEvents[0].action | Should -Be 'domains.action:verify'
            $script:auditEvents[0].result | Should -Be 'success'
        }

        It 'refuses a missing domain with domain_not_found and no verify call' {
            $seam = script:New-AuditSeam
            $result = Verify-Domain -TenantId 'tenant-a' -Domain 'missing.com' -Confirmed -WriteAudit $seam
            $result.status | Should -Be 'failed'
            $result.code | Should -Be 'domain_not_found'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Uri -like '*/verify' }
            $script:auditEvents[0].result | Should -Be 'failure'
        }
    }

    Context 'remove dispatch' {
        BeforeEach {
            script:New-DomainActionMock
            $null = Add-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed
            $script:auditEvents.Clear()
        }

        It 'refuses to remove without confirmation' {
            { Remove-Domain -TenantId 'tenant-a' -Domain 'contoso.com' } | Should -Throw '*domains.confirm_required*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' }
        }

        It 'removes the domain and writes one success audit event' {
            $seam = script:New-AuditSeam
            $result = Remove-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed -WriteAudit $seam
            $result.status | Should -Be 'applied'
            $script:domainState.ContainsKey('contoso.com') | Should -BeFalse
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'DELETE' }
            $script:auditEvents.Count | Should -Be 1
            $script:auditEvents[0].action | Should -Be 'domains.action:remove'
            $script:auditEvents[0].result | Should -Be 'success'
        }

        It 'refuses a missing domain with domain_not_found and no DELETE' {
            $seam = script:New-AuditSeam
            $result = Remove-Domain -TenantId 'tenant-a' -Domain 'missing.com' -Confirmed -WriteAudit $seam
            $result.status | Should -Be 'failed'
            $result.code | Should -Be 'domain_not_found'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' }
        }
    }

    Context 'set-default dispatch' {
        BeforeEach {
            script:New-DomainActionMock
            $null = Add-Domain -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed
            $script:auditEvents.Clear()
        }

        It 'refuses to set default without confirmation' {
            { Set-DomainDefault -TenantId 'tenant-a' -Domain 'contoso.com' } | Should -Throw '*domains.confirm_required*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'PATCH' }
        }

        It 'sets the domain default and writes one success audit event' {
            $seam = script:New-AuditSeam
            $result = Set-DomainDefault -TenantId 'tenant-a' -Domain 'contoso.com' -Confirmed -WriteAudit $seam
            $result.status | Should -Be 'applied'
            $script:domainState['contoso.com'].isDefault | Should -BeTrue
            Should -Invoke Invoke-MgGraphRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'PATCH' }
            $script:auditEvents.Count | Should -Be 1
            $script:auditEvents[0].action | Should -Be 'domains.action:setDefault'
            $script:auditEvents[0].result | Should -Be 'success'
        }

        It 'refuses a missing domain with domain_not_found and no PATCH' {
            $seam = script:New-AuditSeam
            $result = Set-DomainDefault -TenantId 'tenant-a' -Domain 'missing.com' -Confirmed -WriteAudit $seam
            $result.status | Should -Be 'failed'
            $result.code | Should -Be 'domain_not_found'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'PATCH' }
        }
    }

    Context 'action dispatcher' {
        BeforeEach {
            script:New-DomainActionMock
        }

        It 'routes add, verify, remove, and setDefault by name' {
            (Invoke-DomainAction -TenantId 'tenant-a' -Domain 'contoso.com' -Action 'add' -Confirmed).status | Should -Be 'applied'
            (Invoke-DomainAction -TenantId 'tenant-a' -Domain 'contoso.com' -Action 'verify' -Confirmed).status | Should -Be 'applied'
            (Invoke-DomainAction -TenantId 'tenant-a' -Domain 'contoso.com' -Action 'setDefault' -Confirmed).status | Should -Be 'applied'
            (Invoke-DomainAction -TenantId 'tenant-a' -Domain 'contoso.com' -Action 'remove' -Confirmed).status | Should -Be 'applied'
        }

        It 'refuses an unknown action with a structured error and no Graph call' {
            { Invoke-DomainAction -TenantId 'tenant-a' -Domain 'contoso.com' -Action 'deleteEverything' -Confirmed } | Should -Throw '*domains.unknown_action*'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'passes the audit seam through to the action' {
            $seam = script:New-AuditSeam
            $null = Invoke-DomainAction -TenantId 'tenant-a' -Domain 'contoso.com' -Action 'add' -Confirmed -WriteAudit $seam
            $script:auditEvents.Count | Should -Be 1
            $script:auditEvents[0].action | Should -Be 'domains.action:add'
        }
    }

    Context 'job envelope' {
        It 'reads the action from the envelope and rejects bad envelopes' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ('domain-action-job-{0}.json' -f [guid]::NewGuid())
            @{
                schemaVersion = 'v1'
                tenantId = 'tenant-a'
                correlationId = 'corr-1'
                payload = @{ domain = 'contoso.com'; action = 'add'; confirmed = $true; actor = 'user-1' }
            } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding UTF8
            try {
                $job = Read-DomainActionJob -Path $path
                $job['TenantId'] | Should -Be 'tenant-a'
                $job['Domain'] | Should -Be 'contoso.com'
                $job['Action'] | Should -Be 'add'
                $job['Confirmed'] | Should -BeTrue
                $job['Actor'] | Should -Be 'user-1'
                $job['CorrelationId'] | Should -Be 'corr-1'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
            { Read-DomainActionJob -Path (Join-Path ([System.IO.Path]::GetTempPath()) 'missing-domain-action-job.json') } | Should -Throw '*not found*'
        }

        It 'rejects an envelope with an unsupported action' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ('domain-action-job-{0}.json' -f [guid]::NewGuid())
            @{
                schemaVersion = 'v1'
                tenantId = 'tenant-a'
                correlationId = 'corr-1'
                payload = @{ domain = 'contoso.com'; action = 'wipe'; confirmed = $true }
            } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding UTF8
            try {
                { Read-DomainActionJob -Path $path } | Should -Throw '*unsupported action*'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Context 'entrypoint dispatch' {
        BeforeEach {
            script:New-DomainActionMock
        }

        It 'reads direct parameters, dispatches, and emits the JSON result' {
            $output = & $script:entrypoint -TenantId 'tenant-a' -Domain 'contoso.com' -Action 'add' -Confirmed
            $result = $output | ConvertFrom-Json
            $result.status | Should -Be 'applied'
            $result.action | Should -Be 'add'
            $result.domain | Should -Be 'contoso.com'
            $result.verificationRecords | Should -HaveCount 2
        }
    }
}
