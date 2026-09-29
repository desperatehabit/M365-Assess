BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-QuarantinePolicy.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-quarantine-policy.ps1'

    function global:Get-QuarantinePolicy { param($Identity) }
    function global:New-QuarantinePolicy { param($Name, $QuarantinePolicyType) }
    function global:Set-QuarantinePolicy { param($Identity) }
    function global:Remove-QuarantinePolicy { param($Identity, $Confirm) }

    . $script:worker

    $script:notificationPolicy = @{
        Name                      = 'Default notification policy'
        QuarantinePolicyType      = 'QuarantinePolicy'
        ESNEnabled                = $true
        QuarantineRetentionPeriod = 15
        AddressForMessages        = ''
        AdminAddressForMessages   = ''
        EndUserSpamNotificationFrequency = 'Daily'
        UseSystemDefault          = $false
    }
}

Describe 'Set-QuarantinePolicy worker (T-0428)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-SetQuarantinePolicy -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SetQuarantinePolicyJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-QuarantinePolicyType -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'entrypoint connects EXO in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Set-QuarantinePolicy\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-SetQuarantinePolicyJob -Path'
            $entrySource | Should -Match 'Invoke-SetQuarantinePolicy -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'policy type' {
        It 'accepts the two §3.5 types and the EXO aliases' {
            ConvertTo-QuarantinePolicyType -PolicyType 'notification' | Should -Be 'notification'
            ConvertTo-QuarantinePolicyType -PolicyType 'permission' | Should -Be 'permission'
            ConvertTo-QuarantinePolicyType -PolicyType 'QuarantinePolicy' | Should -Be 'notification'
            ConvertTo-QuarantinePolicyType -PolicyType 'AdminOnlyAccessPolicy' | Should -Be 'permission'
        }

        It 'rejects unknown policy types' {
            { ConvertTo-QuarantinePolicyType -PolicyType 'spam' } | Should -Throw '*Unknown quarantine policy type*'
        }
    }

    Context 'Create operation' {
        It 'DryRun returns a plan preview without calling New-' {
            $newCalled = $false
            Mock New-QuarantinePolicy { param($Name, $QuarantinePolicyType) $newCalled = $true }

            $res = Invoke-SetQuarantinePolicy -TenantId 'tenant-test' -PolicyType 'notification' -Action 'create' -PolicyName 'Strict' -Settings @{ esnEnabled = $true } -DryRun $true
            $res.success | Should -BeTrue
            $res.plan.action | Should -Be 'create'
            $res.plan.policyName | Should -Be 'Strict'
            $res.plan.after.name | Should -Be 'Strict'
            $res.plan.diff.Count | Should -BeGreaterThan 0
            $newCalled | Should -BeFalse
        }

        It 'executes create with New- and records audit event' {
            Mock New-QuarantinePolicy { param($Name, $QuarantinePolicyType) return @{ Name = $Name } }

            $res = Invoke-SetQuarantinePolicy -TenantId 'tenant-test' -PolicyType 'notification' -Action 'create' -PolicyName 'Strict' -Settings @{ esnEnabled = $true } -DryRun $false
            $res.success | Should -BeTrue
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'quarantine.policy.create'
            $res.auditEvent.targetId | Should -Be 'Strict'
        }

        It 'requires policyName for create' {
            { Invoke-SetQuarantinePolicy -TenantId 'tenant-test' -PolicyType 'notification' -Action 'create' -PolicyName '' -Settings @{} -DryRun $true } | Should -Throw '*policyName is required for create*'
        }
    }

    Context 'Edit operation' {
        BeforeEach {
            Mock Get-QuarantinePolicy { param($Identity) return @($script:notificationPolicy) }
        }

        It 'DryRun returns diff preview without calling Set-' {
            $setCalled = $false
            Mock Set-QuarantinePolicy { param($Identity) $setCalled = $true }

            $res = Invoke-SetQuarantinePolicy -TenantId 'tenant-test' -PolicyType 'notification' -Action 'edit' -PolicyName 'Default notification policy' -Settings @{ esnEnabled = $false } -DryRun $true
            $res.success | Should -BeTrue
            $res.plan.action | Should -Be 'edit'
            ($res.plan.diff -join "`n") | Should -Match 'settings updated'
            $setCalled | Should -BeFalse
        }

        It 'executes edit and records audit event' {
            Mock Set-QuarantinePolicy { param($Identity) return @{ Name = $Identity } }

            $res = Invoke-SetQuarantinePolicy -TenantId 'tenant-test' -PolicyType 'notification' -Action 'edit' -PolicyName 'Default notification policy' -Settings @{ esnEnabled = $false } -DryRun $false
            $res.success | Should -BeTrue
            $res.auditEvent.action | Should -Be 'quarantine.policy.edit'
            $res.auditEvent.targetId | Should -Be 'Default notification policy'
        }

        It 'returns NotFound when the policy does not exist' {
            Mock Get-QuarantinePolicy { param($Identity) return @() }

            { Invoke-SetQuarantinePolicy -TenantId 'tenant-test' -PolicyType 'notification' -Action 'edit' -PolicyName 'Missing' -Settings @{} -DryRun $true } | Should -Throw '*not found*'
        }
    }

    Context 'Delete operation' {
        BeforeEach {
            Mock Get-QuarantinePolicy { param($Identity) return @($script:notificationPolicy) }
        }

        It 'requires confirmation to delete' {
            { Invoke-SetQuarantinePolicy -TenantId 'tenant-test' -PolicyType 'notification' -Action 'delete' -PolicyName 'Default notification policy' -Confirm $false -DryRun $false } | Should -Throw '*requires confirmation*'
        }

        It 'DryRun returns a delete plan without calling Remove-' {
            $removeCalled = $false
            Mock Remove-QuarantinePolicy { param($Identity, $Confirm) $removeCalled = $true }

            $res = Invoke-SetQuarantinePolicy -TenantId 'tenant-test' -PolicyType 'notification' -Action 'delete' -PolicyName 'Default notification policy' -Confirm $true -DryRun $true
            $res.success | Should -BeTrue
            $res.plan.action | Should -Be 'delete'
            $res.plan.requiresConfirmation | Should -BeTrue
            $removeCalled | Should -BeFalse
        }

        It 'executes delete and records audit event' {
            Mock Remove-QuarantinePolicy { param($Identity, $Confirm) return @{ Name = $Identity } }

            $res = Invoke-SetQuarantinePolicy -TenantId 'tenant-test' -PolicyType 'notification' -Action 'delete' -PolicyName 'Default notification policy' -Confirm $true -DryRun $false
            $res.success | Should -BeTrue
            $res.auditEvent.action | Should -Be 'quarantine.policy.delete'
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id, policy type, and action' {
            $jobPath = Join-Path $TestDrive 'set-quarantine-policy-job.json'
            @{
                schemaVersion = 'v1'
                jobId         = 'job-1'
                tenantId      = 'tenant-a'
                payload       = @{
                    policyType = 'notification'
                    action     = 'edit'
                    policyName = 'Default notification policy'
                    settings   = @{ esnEnabled = $false }
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-SetQuarantinePolicyJob -Path $jobPath

            $job['TenantId']   | Should -Be 'tenant-a'
            $job['PolicyType'] | Should -Be 'notification'
            $job['Action']     | Should -Be 'edit'
            $job['PolicyName'] | Should -Be 'Default notification policy'
        }

        It 'rejects envelopes with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'set-quarantine-policy-job-bad.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-SetQuarantinePolicyJob -Path $jobPath } | Should -Throw '*schemaVersion*'
        }

        It 'rejects envelopes without a tenant id, policy type, or file' {
            $jobPath = Join-Path $TestDrive 'set-quarantine-policy-job-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-SetQuarantinePolicyJob -Path $jobPath } | Should -Throw '*tenantId*'
            $noTypePath = Join-Path $TestDrive 'set-quarantine-policy-job-notype.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ action = 'edit' }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $noTypePath -Encoding UTF8
            { Read-SetQuarantinePolicyJob -Path $noTypePath } | Should -Throw '*policyType*'
            { Read-SetQuarantinePolicyJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }

        It 'rejects envelopes with an unknown policy type' {
            $jobPath = Join-Path $TestDrive 'set-quarantine-policy-job-unknown.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ policyType = 'spam'; action = 'edit' }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            { Read-SetQuarantinePolicyJob -Path $jobPath } | Should -Throw '*Unknown quarantine policy type*'
        }
    }
}
