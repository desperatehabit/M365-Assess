BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Set-AllowBlockEntry.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/set-allow-block-entry.ps1'

    function global:Get-TenantAllowBlockListItems { param($ListType, $Entry, $Allow, $Block) }
    function global:New-TenantAllowBlockListItems { param($ListType, $Entries, $Notes, $ExpirationDate, $Allow, $Block) }
    function global:Remove-TenantAllowBlockListItems { param($ListType, $Entries, $Confirm, $Allow, $Block) }

    . $script:worker

    $script:blockEntry = @{
        Value          = 'bad.example'
        ExpirationDate = $null
        Notes          = 'phishing'
    }
}

Describe 'Set-AllowBlockEntry worker (T-0427)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-SetAllowBlockEntry -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-SetAllowBlockEntryJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command ConvertTo-AllowBlockType -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'entrypoint connects EXO in the child, delegates to the worker, and emits JSON' {
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Match 'Set-AllowBlockEntry\.ps1'
            $entrySource | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $entrySource | Should -Match 'Read-SetAllowBlockEntryJob -Path'
            $entrySource | Should -Match 'Invoke-SetAllowBlockEntry -TenantId'
            $entrySource | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'entry type and action' {
        It 'accepts the four §3.4 types and the aliases' {
            ConvertTo-AllowBlockType -Type 'sender' | Should -Be 'sender'
            ConvertTo-AllowBlockType -Type 'domain' | Should -Be 'domain'
            ConvertTo-AllowBlockType -Type 'url' | Should -Be 'url'
            ConvertTo-AllowBlockType -Type 'FileHash' | Should -Be 'file'
            ConvertTo-AllowBlockAction -EntryAction 'allow' | Should -Be 'allow'
            ConvertTo-AllowBlockAction -EntryAction 'Block' | Should -Be 'block'
        }

        It 'rejects unknown types and actions' {
            { ConvertTo-AllowBlockType -Type 'spoof' } | Should -Throw '*Unknown allow/block type*'
            { ConvertTo-AllowBlockAction -EntryAction 'quarantine' } | Should -Throw '*Unknown allow/block action*'
        }

        It 'maps the logical types to the EXO list types' {
            ConvertTo-ExoAllowBlockListType -Type 'sender' | Should -Be 'Sender'
            ConvertTo-ExoAllowBlockListType -Type 'domain' | Should -Be 'Sender'
            ConvertTo-ExoAllowBlockListType -Type 'url' | Should -Be 'Url'
            ConvertTo-ExoAllowBlockListType -Type 'file' | Should -Be 'FileHash'
        }
    }

    Context 'Create operation' {
        It 'DryRun returns a plan preview without calling New-' {
            Mock New-TenantAllowBlockListItems { }

            $res = Invoke-SetAllowBlockEntry -TenantId 'tenant-test' -Type 'sender' -Action 'create' -Value 'bad.example' -EntryAction 'block' -DryRun $true
            $res.success | Should -BeTrue
            $res.plan.action | Should -Be 'create'
            $res.plan.value | Should -Be 'bad.example'
            $res.plan.after.value | Should -Be 'bad.example'
            Should -Invoke New-TenantAllowBlockListItems -Times 0
        }

        It 'executes create with New- and records an audit event' {
            Mock New-TenantAllowBlockListItems { param($ListType, $Entries) return @{ Value = $Entries } }

            $res = Invoke-SetAllowBlockEntry -TenantId 'tenant-test' -Type 'sender' -Action 'create' -Value 'bad.example' -EntryAction 'block' -DryRun $false
            $res.success | Should -BeTrue
            $res.auditEvent.action | Should -Be 'allow-block.entry.create'
            $res.auditEvent.targetId | Should -Be 'sender:bad.example:block'
        }

        It 'applies an optional expiry to the EXO entry' {
            Mock New-TenantAllowBlockListItems { param($ListType, $Entries, $ExpirationDate) return @{ Value = $Entries } }

            $res = Invoke-SetAllowBlockEntry -TenantId 'tenant-test' -Type 'sender' -Action 'create' -Value 'good@example.test' -EntryAction 'allow' -ExpiresOn '2026-12-31T00:00:00Z' -DryRun $false
            $res.success | Should -BeTrue
            $res.plan.after.expiresOn | Should -Be '2026-12-31T00:00:00.0000000Z'
            Should -Invoke New-TenantAllowBlockListItems -Times 1 -ParameterFilter { $ExpirationDate -ne $null }
        }
    }

    Context 'Edit operation' {
        BeforeEach {
            Mock Get-TenantAllowBlockListItems { param($ListType, $Entry, $Allow, $Block) return @($script:blockEntry) }
        }

        It 'DryRun returns a diff preview without calling Remove- or New-' {
            Mock Remove-TenantAllowBlockListItems { }
            Mock New-TenantAllowBlockListItems { }

            $res = Invoke-SetAllowBlockEntry -TenantId 'tenant-test' -Type 'sender' -Action 'edit' -Value 'bad.example' -EntryAction 'block' -ExpiresOn '2027-01-01T00:00:00Z' -DryRun $true
            $res.success | Should -BeTrue
            $res.plan.action | Should -Be 'edit'
            $res.plan.before.value | Should -Be 'bad.example'
            $res.plan.after.expiresOn | Should -Be '2027-01-01T00:00:00.0000000Z'
            Should -Invoke Remove-TenantAllowBlockListItems -Times 0
            Should -Invoke New-TenantAllowBlockListItems -Times 0
        }

        It 'executes edit by removing the old entry and adding the new one' {
            Mock Remove-TenantAllowBlockListItems { }
            Mock New-TenantAllowBlockListItems { param($ListType, $Entries) return @{ Value = $Entries } }

            $res = Invoke-SetAllowBlockEntry -TenantId 'tenant-test' -Type 'sender' -Action 'edit' -Value 'bad.example' -EntryAction 'block' -Notes 'updated' -DryRun $false
            $res.success | Should -BeTrue
            $res.auditEvent.action | Should -Be 'allow-block.entry.edit'
            Should -Invoke Remove-TenantAllowBlockListItems -Times 1
            Should -Invoke New-TenantAllowBlockListItems -Times 1
        }

        It 'returns NotFound when the entry does not exist' {
            Mock Get-TenantAllowBlockListItems { param($ListType, $Entry, $Allow, $Block) return @() }

            { Invoke-SetAllowBlockEntry -TenantId 'tenant-test' -Type 'sender' -Action 'edit' -Value 'missing.example' -EntryAction 'block' -DryRun $true } | Should -Throw '*not found*'
        }
    }

    Context 'Delete operation' {
        BeforeEach {
            Mock Get-TenantAllowBlockListItems { param($ListType, $Entry, $Allow, $Block) return @($script:blockEntry) }
        }

        It 'executes delete and records an audit event' {
            Mock Remove-TenantAllowBlockListItems { }

            $res = Invoke-SetAllowBlockEntry -TenantId 'tenant-test' -Type 'sender' -Action 'delete' -Value 'bad.example' -EntryAction 'block' -DryRun $false
            $res.success | Should -BeTrue
            $res.auditEvent.action | Should -Be 'allow-block.entry.delete'
            Should -Invoke Remove-TenantAllowBlockListItems -Times 1
        }
    }

    Context 'job envelope' {
        It 'parses the tenant id, type, action, value, and entry action' {
            $jobPath = Join-Path $TestDrive 'set-allow-block-entry-job.json'
            @{
                schemaVersion = 'v1'
                jobId         = 'job-1'
                tenantId      = 'tenant-a'
                payload       = @{
                    type        = 'sender'
                    action      = 'create'
                    value       = 'bad.example'
                    entryAction = 'block'
                    expiresOn   = '2026-12-31T00:00:00Z'
                    notes       = 'campaign'
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $jobPath -Encoding UTF8

            $job = Read-SetAllowBlockEntryJob -Path $jobPath

            $job['TenantId']    | Should -Be 'tenant-a'
            $job['Type']        | Should -Be 'sender'
            $job['Action']      | Should -Be 'create'
            $job['Value']       | Should -Be 'bad.example'
            $job['EntryAction'] | Should -Be 'block'
            $job['ExpiresOn']   | Should -Be '2026-12-31T00:00:00.0000000Z'
            $job['Notes']       | Should -Be 'campaign'
        }

        It 'rejects envelopes with an unsupported schema version' {
            $jobPath = Join-Path $TestDrive 'set-allow-block-entry-job-bad.json'
            @{ schemaVersion = 'v9'; tenantId = 'tenant-a' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-SetAllowBlockEntryJob -Path $jobPath } | Should -Throw '*schemaVersion*'
        }

        It 'rejects envelopes without a tenant id, type, or file' {
            $jobPath = Join-Path $TestDrive 'set-allow-block-entry-job-empty.json'
            @{ schemaVersion = 'v1'; tenantId = '' } | ConvertTo-Json | Set-Content -Path $jobPath -Encoding UTF8

            { Read-SetAllowBlockEntryJob -Path $jobPath } | Should -Throw '*tenantId*'
            $noTypePath = Join-Path $TestDrive 'set-allow-block-entry-job-notype.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ action = 'create' }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $noTypePath -Encoding UTF8
            { Read-SetAllowBlockEntryJob -Path $noTypePath } | Should -Throw '*type*'
            { Read-SetAllowBlockEntryJob -Path (Join-Path $TestDrive 'does-not-exist.json') } | Should -Throw '*not found*'
        }

        It 'rejects envelopes without an entry action or value' {
            $noEntryActionPath = Join-Path $TestDrive 'set-allow-block-entry-job-noaction.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ type = 'sender'; action = 'create'; value = 'bad.example' }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $noEntryActionPath -Encoding UTF8
            { Read-SetAllowBlockEntryJob -Path $noEntryActionPath } | Should -Throw '*entryAction*'

            $noValuePath = Join-Path $TestDrive 'set-allow-block-entry-job-novalue.json'
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                payload       = @{ type = 'sender'; action = 'create'; entryAction = 'block' }
            } | ConvertTo-Json -Depth 10 | Set-Content -Path $noValuePath -Encoding UTF8
            { Read-SetAllowBlockEntryJob -Path $noValuePath } | Should -Throw '*value*'
        }
    }
}
