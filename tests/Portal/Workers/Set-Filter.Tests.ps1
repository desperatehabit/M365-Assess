BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-Filter.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-filter.ps1'

    function global:Get-HostedContentFilterPolicy { param($Identity) }
    function global:Get-AntiPhishPolicy { param($Identity) }
    function global:Get-MalwareFilterPolicy { param($Identity) }
    function global:Get-HostedConnectionFilterPolicy { param($Identity) }
    function global:Get-HostedContentFilterRule { param($Identity) }
    function global:Get-AntiPhishRule { param($Identity) }
    function global:Get-MalwareFilterRule { param($Identity) }
    function global:Get-HostedConnectionFilterRule { param($Identity) }
    function global:New-HostedContentFilterPolicy { param($Name, $SpamAction, $BulkThreshold) }
    function global:New-AntiPhishPolicy { param($Name) }
    function global:New-MalwareFilterPolicy { param($Name) }
    function global:New-HostedConnectionFilterPolicy { param($Name) }
    function global:Set-HostedContentFilterPolicy { param($Identity, $SpamAction) }
    function global:Set-AntiPhishPolicy { param($Identity) }
    function global:Set-MalwareFilterPolicy { param($Identity) }
    function global:Set-HostedConnectionFilterPolicy { param($Identity) }
    function global:Enable-HostedContentFilterRule { param($Identity) }
    function global:Enable-AntiPhishRule { param($Identity) }
    function global:Enable-MalwareFilterRule { param($Identity) }
    function global:Enable-HostedConnectionFilterRule { param($Identity) }
    function global:Disable-HostedContentFilterRule { param($Identity) }
    function global:Disable-AntiPhishRule { param($Identity) }
    function global:Disable-MalwareFilterRule { param($Identity) }
    function global:Disable-HostedConnectionFilterRule { param($Identity) }
    function global:Remove-HostedContentFilterPolicy { param($Identity, $Confirm) }
    function global:Remove-AntiPhishPolicy { param($Identity, $Confirm) }
    function global:Remove-MalwareFilterPolicy { param($Identity, $Confirm) }
    function global:Remove-HostedConnectionFilterPolicy { param($Identity, $Confirm) }

    . $script:worker

    $script:spamPolicy = @{
        Name                      = 'Default'
        SpamAction                = 'Quarantine'
        HighConfidenceSpamAction  = 'Quarantine'
        PhishSpamAction           = 'Quarantine'
        BulkSpamAction            = 'MoveToJmf'
        BulkThreshold             = 6
        SpamZapEnabled            = $true
        PhishZapEnabled           = $true
        Enabled                   = $true
    }
}

Describe 'Set-Filter worker (T-0422)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-SetFilter -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SetFilterJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-FilterType -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'entrypoint connects EXO in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Set-Filter\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-SetFilterJob -Path'
            $entrySource | Should -Match 'Invoke-SetFilter -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'filter type' {
        It 'accepts the four §3.1 types and the anti-phish alias' {
            ConvertTo-FilterType -FilterType 'spam' | Should -Be 'spam'
            ConvertTo-FilterType -FilterType 'antiphish' | Should -Be 'antiphish'
            ConvertTo-FilterType -FilterType 'anti-phish' | Should -Be 'antiphish'
            ConvertTo-FilterType -FilterType 'malware' | Should -Be 'malware'
            ConvertTo-FilterType -FilterType 'connection' | Should -Be 'connection'
        }

        It 'rejects unknown filter types' {
            { ConvertTo-FilterType -FilterType 'quarantine' } | Should -Throw '*Unknown filter type*'
        }
    }

    Context 'Create operation' {
        It 'DryRun returns a plan preview without calling New-' {
            $newCalled = $false
            Mock New-HostedContentFilterPolicy { $newCalled = $true }

            $res = Invoke-SetFilter -TenantId 'tenant-test' -FilterType 'spam' -Action 'create' -PolicyName 'Strict' -Settings @{ spamAction = 'Quarantine' } -DryRun $true
            $res.success | Should -BeTrue
            $res.plan.action | Should -Be 'create'
            $res.plan.policyName | Should -Be 'Strict'
            $res.plan.after.name | Should -Be 'Strict'
            $res.plan.diff.Count | Should -BeGreaterThan 0
            $newCalled | Should -BeFalse
        }

        It 'executes create with New- and records audit event' {
            Mock New-HostedContentFilterPolicy { param($Name, $SpamAction, $BulkThreshold) return @{ Name = $Name } }

            $res = Invoke-SetFilter -TenantId 'tenant-test' -FilterType 'spam' -Action 'create' -PolicyName 'Strict' -Settings @{ spamAction = 'Quarantine' } -DryRun $false
            $res.success | Should -BeTrue
            $res.auditEvent | Should -Not -BeNullOrEmpty
            $res.auditEvent.action | Should -Be 'filters.policy.create'
            $res.auditEvent.targetId | Should -Be 'Strict'
        }

        It 'requires policyName for create' {
            { Invoke-SetFilter -TenantId 'tenant-test' -FilterType 'spam' -Action 'create' -PolicyName '' -Settings @{} -DryRun $true } | Should -Throw '*policyName is required for create*'
        }
    }

    Context 'Edit operation' {
        BeforeEach {
            Mock Get-HostedContentFilterPolicy { param($Identity) return $script:spamPolicy }
        }

        It 'DryRun returns diff preview without calling Set-' {
            $setCalled = $false
            Mock Set-HostedContentFilterPolicy { param($Identity, $SpamAction) $setCalled = $true }

            $res = Invoke-SetFilter -TenantId 'tenant-test' -FilterType 'spam' -Action 'edit' -PolicyName 'Default' -Settings @{ spamAction = 'MoveToJmf' } -DryRun $true
            $res.success | Should -BeTrue
            $res.plan.action | Should -Be 'edit'
            ($res.plan.diff -join "`n") | Should -Match 'settings updated'
            $setCalled | Should -BeFalse
        }

        It 'executes edit and records audit event' {
            Mock Set-HostedContentFilterPolicy { param($Identity, $SpamAction) return @{ Name = $Identity } }

            $res = Invoke-SetFilter -TenantId 'tenant-test' -FilterType 'spam' -Action 'edit' -PolicyName 'Default' -Settings @{ spamAction = 'MoveToJmf' } -DryRun $false
            $res.success | Should -BeTrue
            $res.auditEvent.action | Should -Be 'filters.policy.edit'
            $res.auditEvent.targetId | Should -Be 'Default'
        }

        It 'returns 404 when the policy does not exist' {
            Mock Get-HostedContentFilterPolicy { param($Identity) return $null }

            { Invoke-SetFilter -TenantId 'tenant-test' -FilterType 'spam' -Action 'edit' -PolicyName 'Missing' -Settings @{} -DryRun $true } | Should -Throw '*not found*'
        }
    }

    Context 'Disable operation' {
        BeforeEach {
            Mock Get-HostedContentFilterPolicy { param($Identity) return $script:spamPolicy }
        }

        It 'requires confirmation to disable' {
            { Invoke-SetFilter -TenantId 'tenant-test' -FilterType 'spam' -Action 'disable' -PolicyName 'Default' -Confirm $false -DryRun $false } | Should -Throw '*requires confirmation*'
        }

        It 'DryRun returns a disable plan without calling Disable-' {
            $disableCalled = $false
            Mock Disable-HostedContentFilterRule { param($Identity) $disableCalled = $true }

            $res = Invoke-SetFilter -TenantId 'tenant-test' -FilterType 'spam' -Action 'disable' -PolicyName 'Default' -Confirm $true -DryRun $true
            $res.success | Should -BeTrue
            $res.plan.action | Should -Be 'disable'
            $res.plan.after.enabled | Should -BeFalse
            $res.plan.requiresConfirmation | Should -BeTrue
            $disableCalled | Should -BeFalse
        }

        It 'executes disable and records audit event' {
            Mock Disable-HostedContentFilterRule { param($Identity) return @{ Name = $Identity } }

            $res = Invoke-SetFilter -TenantId 'tenant-test' -FilterType 'spam' -Action 'disable' -PolicyName 'Default' -Confirm $true -DryRun $false
            $res.success | Should -BeTrue
            $res.auditEvent.action | Should -Be 'filters.policy.disable'
        }
    }

    Context 'Delete operation' {
        BeforeEach {
            Mock Get-HostedContentFilterPolicy { param($Identity) return $script:spamPolicy }
        }

        It 'requires confirmation to delete' {
            { Invoke-SetFilter -TenantId 'tenant-test' -FilterType 'spam' -Action 'delete' -PolicyName 'Default' -Confirm $false -DryRun $false } | Should -Throw '*requires confirmation*'
        }

        It 'executes delete and records audit event' {
            Mock Remove-HostedContentFilterPolicy { param($Identity, $Confirm) return @{ Name = $Identity } }

            $res = Invoke-SetFilter -TenantId 'tenant-test' -FilterType 'spam' -Action 'delete' -PolicyName 'Default' -Confirm $true -DryRun $false
            $res.success | Should -BeTrue
            $res.auditEvent.action | Should -Be 'filters.policy.delete'
        }
    }

    Context 'Enable operation' {
        BeforeEach {
            $disabledPolicy = $script:spamPolicy.Clone()
            $disabledPolicy['Enabled'] = $false
            Mock Get-HostedContentFilterPolicy { param($Identity) return $disabledPolicy }
        }

        It 'executes enable without confirmation' {
            Mock Enable-HostedContentFilterRule { param($Identity) return @{ Name = $Identity } }

            $res = Invoke-SetFilter -TenantId 'tenant-test' -FilterType 'spam' -Action 'enable' -PolicyName 'Default' -Confirm $false -DryRun $false
            $res.success | Should -BeTrue
            $res.plan.requiresConfirmation | Should -BeFalse
            $res.auditEvent.action | Should -Be 'filters.policy.enable'
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id, filter type, and action' {
            $jobPath = Join-Path $TestDrive 'set-filter-job.json'
            @{
                schemaVersion = 'v1'
                jobId         = 'job-1'
                tenantId      = 'tenant-a'
                payload       = @{
                    filterType = 'spam'
                    action     = 'disable'
                    policyName = 'Default'
                    confirm    = $true
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-SetFilterJob -Path $jobPath

            $job['TenantId']   | Should -Be 'tenant-a'
            $job['FilterType'] | Should -Be 'spam'
            $job['Action']     | Should -Be 'disable'
            $job['PolicyName'] | Should -Be 'Default'
            $job['Confirm']    | Should -BeTrue
        }

        It 'rejects envelopes with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'set-filter-job-bad.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-SetFilterJob -Path $jobPath } | Should -Throw '*schemaVersion*'
        }

        It 'rejects envelopes without a tenant id, filter type, or file' {
            $jobPath = Join-Path $TestDrive 'set-filter-job-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-SetFilterJob -Path $jobPath } | Should -Throw '*tenantId*'
            $noTypePath = Join-Path $TestDrive 'set-filter-job-notype.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ action = 'disable' }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $noTypePath -Encoding UTF8
            { Read-SetFilterJob -Path $noTypePath } | Should -Throw '*filterType*'
            { Read-SetFilterJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }

        It 'rejects envelopes with an unknown filter type' {
            $jobPath = Join-Path $TestDrive 'set-filter-job-unknown.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ filterType = 'quarantine'; action = 'disable' }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            { Read-SetFilterJob -Path $jobPath } | Should -Throw '*Unknown filter type*'
        }
    }
}
