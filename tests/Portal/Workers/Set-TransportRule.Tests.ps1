BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-TransportRule.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-transport-rule.ps1'

    function global:Get-TransportRule {
        param($Identity)
    }
    function global:New-TransportRule {
        param($Name, $Priority, $Enabled, $Conditions, $Actions, $Exceptions)
    }
    function global:Set-TransportRule {
        param($Identity, $Name, $Priority, $Enabled, $Conditions, $Actions, $Exceptions)
    }
    function global:Remove-TransportRule {
        param($Identity, $Confirm)
    }

    . $script:worker
}

Describe 'Set-TransportRule worker entrypoint (T-0851)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-SetTransportRule -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SetTransportRuleJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'entrypoint connects EXO in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Set-TransportRule\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-SetTransportRuleJob -Path'
            $entrySource | Should -Match 'Invoke-SetTransportRule @invokeParams'
            $entrySource | Should -Match 'ConvertTo-Json'
        }

        It 'never persists rule state to disk or logs' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Not -Match 'Out-File'
            $entrySource | Should -Not -Match 'Export-Csv'
            $entrySource | Should -Not -Match 'Export-Clixml'
            $entrySource | Should -Not -Match 'Start-Transcript'
            $entrySource | Should -Not -Match 'Tee-Object'
        }
    }

    Context 'job envelope' {
        It 'parses the tenant, action, planned values, and apply flags' {
            $jobPath = Join-Path $TestDrive 'transport-rule-job.json'
            @{
                tenantId       = 'tenant-a'
                action         = 'edit'
                ruleId         = 'rule-1'
                name           = 'Block wire transfers'
                enabled        = $false
                priority       = 2
                conditionsJson = '{"subjectContainsWords":["wire"]}'
                actionsJson    = '{"rejectMessageReasonText":"Blocked"}'
                exceptionsJson = '{}'
                confirmed      = $true
                dryRun         = $false
            } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-SetTransportRuleJob -Path $jobPath

            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Action'] | Should -Be 'edit'
            $job['RuleId'] | Should -Be 'rule-1'
            $job['Name'] | Should -Be 'Block wire transfers'
            $job['Enabled'] | Should -BeFalse
            $job['Priority'] | Should -Be 2
            $job['ConditionsJson'] | Should -Be '{"subjectContainsWords":["wire"]}'
            $job['ActionsJson'] | Should -Be '{"rejectMessageReasonText":"Blocked"}'
            $job['Confirmed'] | Should -BeTrue
            $job['DryRun'] | Should -BeFalse
        }

        It 'rejects envelopes without a tenant or an action' {
            $noTenant = Join-Path $TestDrive 'transport-rule-no-tenant.json'
            @{ tenantId = ''; action = 'create' } | ConvertTo-Json | Set-Content -Path $noTenant -Encoding UTF8
            { Read-SetTransportRuleJob -Path $noTenant } | Should -Throw '*tenantId*'

            $noAction = Join-Path $TestDrive 'transport-rule-no-action.json'
            @{ tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $noAction -Encoding UTF8
            { Read-SetTransportRuleJob -Path $noAction } | Should -Throw '*action*'

            { Read-SetTransportRuleJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }
    }
}
