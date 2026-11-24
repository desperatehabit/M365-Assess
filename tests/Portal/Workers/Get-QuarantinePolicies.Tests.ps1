BeforeAll {
    $script:repoRoot = (Resolve-Path -LiteralPath (Join-Path -Path $PSScriptRoot -ChildPath '../../..')).Path
    $script:worker = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/M365Portal.Workers/Get-QuarantinePolicies.ps1'
    $script:entrypoint = Join-Path -Path $script:repoRoot -ChildPath 'portal/workers/get-quarantine-policies.ps1'

    function global:Get-QuarantinePolicy { param() }

    . $script:worker

    $script:notificationPolicy = @{
        Name                             = 'Default notification policy'
        QuarantinePolicyType             = 'QuarantinePolicy'
        ESNEnabled                       = $true
        QuarantineRetentionPeriod        = 15
        AddressForMessages               = 'quarantine@contoso.invalid'
        WhenChangedUTC                   = '2026-09-20T12:00:00Z'
    }
    $script:permissionPolicy = @{
        Name                      = 'AdminOnlyAccessPolicy'
        QuarantinePolicyType      = 'AdminOnlyAccessPolicy'
        ESNEnabled                = $false
        QuarantineRetentionPeriod = 30
        AddressForMessages        = ''
        WhenChanged               = '2026-09-18T08:00:00Z'
    }

    function script:New-QuarantinePolicyListMock {
        Mock Get-QuarantinePolicy {
            return @($script:notificationPolicy, $script:permissionPolicy)
        }
    }
}

AfterAll {
    Remove-Item -Path 'Function:\Get-QuarantinePolicy' -ErrorAction SilentlyContinue
}

Describe 'Get-QuarantinePolicies worker (T-0852)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command -Name 'Get-QuarantinePolicies' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'ConvertTo-QuarantinePolicyType' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'ConvertTo-QuarantinePolicyRow' -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command -Name 'Read-QuarantinePoliciesJob' -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'reads quarantine policies with Get- cmdlets only' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-QuarantinePolicy'
            $source | Should -Not -Match 'New-QuarantinePolicy'
            $source | Should -Not -Match 'Set-QuarantinePolicy'
            $source | Should -Not -Match 'Remove-QuarantinePolicy'
            $source | Should -Not -Match 'Invoke-Expression'
        }

        It 'never persists policy data to disk, logs, or transcripts' {
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

        It 'entrypoint connects EXO in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Get-QuarantinePolicies\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-QuarantinePoliciesJob -Path'
            $entrySource | Should -Match 'Get-QuarantinePolicies @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'policy type normalization' {
        It 'accepts notification/permission and EXO QuarantinePolicy/AdminOnlyAccessPolicy aliases' {
            ConvertTo-QuarantinePolicyType -PolicyType 'notification' | Should -Be 'notification'
            ConvertTo-QuarantinePolicyType -PolicyType 'QuarantinePolicy' | Should -Be 'notification'
            ConvertTo-QuarantinePolicyType -PolicyType 'permission' | Should -Be 'permission'
            ConvertTo-QuarantinePolicyType -PolicyType 'AdminOnlyAccessPolicy' | Should -Be 'permission'
        }

        It 'rejects unknown policy types' {
            { ConvertTo-QuarantinePolicyType -PolicyType 'spam' } | Should -Throw '*Unknown quarantine policy type*'
        }
    }

    Context 'list and filter mapping' {
        BeforeEach {
            script:New-QuarantinePolicyListMock
        }

        It 'returns the QuarantinePoliciesPage shape matching quarantine-policies.ts' {
            $result = Get-QuarantinePolicies -TenantId 'tenant-a'

            $result.tenantId | Should -Be 'tenant-a'
            $result.totalCount | Should -Be 2
            $result.items | Should -HaveCount 2
            $result.retrievedAt | Should -Not -BeNullOrEmpty

            $notif = @($result.items | Where-Object -FilterScript { $_.policyType -eq 'notification' })[0]
            $notif.name | Should -Be 'Default notification policy'
            $notif.esnEnabled | Should -BeTrue
            $notif.quarantineRetentionPeriod | Should -Be 15
            $notif.addressForMessages | Should -Be 'quarantine@contoso.invalid'
            $notif.lastModified | Should -Be '2026-09-20T12:00:00Z'

            $perm = @($result.items | Where-Object -FilterScript { $_.policyType -eq 'permission' })[0]
            $perm.name | Should -Be 'AdminOnlyAccessPolicy'
            $perm.esnEnabled | Should -BeFalse
            $perm.quarantineRetentionPeriod | Should -Be 30
            $perm.lastModified | Should -Be '2026-09-18T08:00:00Z'
        }

        It 'filters by PolicyType and PolicyName' {
            $byType = Get-QuarantinePolicies -TenantId 'tenant-a' -PolicyType 'permission'
            $byType.totalCount | Should -Be 1
            @($byType.items)[0].policyType | Should -Be 'permission'

            $byName = Get-QuarantinePolicies -TenantId 'tenant-a' -PolicyName 'default notification policy'
            $byName.totalCount | Should -Be 1
            @($byName.items)[0].name | Should -Be 'Default notification policy'
        }

        It 'requires the tenant identifier' {
            { Get-QuarantinePolicies -TenantId '' } | Should -Throw
        }
    }

    Context 'job envelope' {
        It 'parses tenantId and optional policy filters from a v1 envelope' {
            $jobPath = Join-Path -Path $TestDrive -ChildPath 'quarantine-policies-job.json'
            @{
                schemaVersion = 'v1'
                jobId         = 'job-1'
                tenantId      = 'tenant-a'
                payload       = @{
                    policyType = 'QuarantinePolicy'
                    policyName = 'Default notification policy'
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jobPath -Encoding UTF8

            $job = Read-QuarantinePoliciesJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['PolicyType'] | Should -Be 'notification'
            $job['PolicyName'] | Should -Be 'Default notification policy'
        }

        It 'allows empty payload filters' {
            $jobPath = Join-Path -Path $TestDrive -ChildPath 'quarantine-policies-empty.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{}
            } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $jobPath -Encoding UTF8

            $job = Read-QuarantinePoliciesJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['PolicyType'] | Should -Be ''
            $job['PolicyName'] | Should -Be ''
        }

        It 'rejects unsupported schemaVersion, missing tenantId, unknown policyType, and missing file' {
            $badVersion = Join-Path -Path $TestDrive -ChildPath 'qp-bad-ver.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -LiteralPath $badVersion -Encoding UTF8
            { Read-QuarantinePoliciesJob -Path $badVersion } | Should -Throw '*schemaVersion*'

            $noTenant = Join-Path -Path $TestDrive -ChildPath 'qp-no-tenant.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -LiteralPath $noTenant -Encoding UTF8
            { Read-QuarantinePoliciesJob -Path $noTenant } | Should -Throw '*tenantId*'

            $badType = Join-Path -Path $TestDrive -ChildPath 'qp-bad-type.json'
            @{ schemaVersion = 'v1'; tenantId = 'tenant-a'; payload = @{ policyType = 'spam' } } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $badType -Encoding UTF8
            { Read-QuarantinePoliciesJob -Path $badType } | Should -Throw '*Unknown quarantine policy type*'

            { Read-QuarantinePoliciesJob -Path (Join-Path -Path $TestDrive -ChildPath 'missing.json') } | Should -Throw '*not found*'
        }
    }
}
