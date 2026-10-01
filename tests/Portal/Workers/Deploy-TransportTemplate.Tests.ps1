BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Deploy-TransportTemplate.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/deploy-transport-template.ps1'

    . $script:worker

    function Get-RuleTemplateJson {
        return @{
            id        = 'tpl-rule-1'
            name      = 'Block partner mail'
            ruleJson  = @{
                name       = 'Block mail to %partnerDomain%'
                conditions = @{ recipientDomainIs = @('%partnerDomain%') }
                actions    = @{ rejectMessage = '%rejectText%' }
            }
            variables = @(
                @{ name = 'partnerDomain' },
                @{ name = 'rejectText'; defaultValue = 'Not allowed' }
            )
        } | ConvertTo-Json -Depth 10
    }

    function Get-ConnectorTemplateJson {
        return @{
            id            = 'tpl-conn-1'
            name          = 'Partner inbound'
            connectorJson = @{
                name          = 'Partner %partnerDomain%'
                type          = 'inbound'
                senderDomains = @('%partnerDomain%')
            }
            variables     = @(@{ name = 'partnerDomain' })
        } | ConvertTo-Json -Depth 10
    }
}

Describe 'Deploy-TransportTemplate worker (T-0406)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-DeployTransportTemplate -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Resolve-TransportTemplate -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-DeployTransportTemplateJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Invoke-TransportTemplateApply -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'entrypoint connects EXO, loads the per-kind workers, and emits JSON' {
            $source = Get-Content -LiteralPath $script:entrypoint -Raw
            $source | Should -Match 'Deploy-TransportTemplate\.ps1'
            $source | Should -Match 'Set-TransportRule\.ps1'
            $source | Should -Match 'Set-Connector\.ps1'
            $source | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile -Service ExchangeOnline'
            $source | Should -Match 'Invoke-DeployTransportTemplate @invokeParams'
            $source | Should -Match 'ConvertTo-Json'
        }
    }

    Context 'variable resolution' {
        It 'resolves supplied variables recursively into the payload' {
            $resolved = Resolve-TransportTemplate -Payload @{
                name   = 'Rule %domain%'
                list   = @('%domain%')
                nested = @{ to = '%domain%' }
            } -DeclaredVariables @(@{ name = 'domain' }) -Variables @{ domain = 'partner.example.invalid' }

            $resolved.Payload.name | Should -Be 'Rule partner.example.invalid'
            $resolved.Payload.list[0] | Should -Be 'partner.example.invalid'
            $resolved.Payload.nested.to | Should -Be 'partner.example.invalid'
            $resolved.Variables['domain'] | Should -Be 'partner.example.invalid'
        }

        It 'falls back to a declared default' {
            $resolved = Resolve-TransportTemplate -Payload @{ reject = '%text%' } -DeclaredVariables @(@{ name = 'text'; defaultValue = 'Not allowed' }) -Variables @{}
            $resolved.Payload.reject | Should -Be 'Not allowed'
        }

        It 'throws for a missing required variable' {
            {
                Resolve-TransportTemplate -Payload @{ name = '%domain%' } -DeclaredVariables @(@{ name = 'domain' }) -Variables @{}
            } | Should -Throw '*missing_variable*'
        }
    }

    Context 'job envelope' {
        It 'reads the tenant, kind, template, variables, and flags' {
            $path = Join-Path $TestDrive 'transport-job.json'
            @{
                tenantId  = 'tenant-a'
                kind      = 'rule'
                template  = @{ id = 'tpl-1'; name = 'Tpl'; ruleJson = @{ name = 'Rule' }; variables = @() }
                variables = @{ domain = 'partner.example.invalid' }
                actor     = 'operator-1'
                confirmed = $true
                dryRun    = $false
            } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path

            $job = Read-DeployTransportTemplateJob -Path $path
            $job['TenantId'] | Should -Be 'tenant-a'
            $job['Kind'] | Should -Be 'rule'
            $job['Variables']['domain'] | Should -Be 'partner.example.invalid'
            $job['Actor'] | Should -Be 'operator-1'
            $job['Confirmed'] | Should -BeTrue
            $job['DryRun'] | Should -BeFalse
        }

        It 'rejects an envelope without a kind or template and missing files' {
            $noKind = Join-Path $TestDrive 'no-kind.json'
            @{ tenantId = 'tenant-a'; template = @{} } | ConvertTo-Json | Set-Content -LiteralPath $noKind
            { Read-DeployTransportTemplateJob -Path $noKind } | Should -Throw '*kind*'

            $noTemplate = Join-Path $TestDrive 'no-template.json'
            @{ tenantId = 'tenant-a'; kind = 'rule' } | ConvertTo-Json | Set-Content -LiteralPath $noTemplate
            { Read-DeployTransportTemplateJob -Path $noTemplate } | Should -Throw '*template*'

            { Read-DeployTransportTemplateJob -Path (Join-Path $TestDrive 'missing.json') } | Should -Throw '*not found*'
        }
    }

    Context 'plan (DryRun)' {
        It 'resolves the payload and returns a plan without applying' {
            Mock Invoke-TransportTemplateApply { throw 'should not apply' }

            $res = Invoke-DeployTransportTemplate -TenantId 'tenant-a' -Kind 'rule' -TemplateJson (Get-RuleTemplateJson) -Variables @{ partnerDomain = 'partner.example.invalid' } -DryRun $true

            $res.success | Should -BeTrue
            $res.plan.dryRun | Should -BeTrue
            $res.plan.payload.name | Should -Be 'Block mail to partner.example.invalid'
            $res.plan.payload.actions.rejectMessage | Should -Be 'Not allowed'
            ($res.plan.diff -join "`n") | Should -Match 'Deploy transport rule'
            Should -Invoke Invoke-TransportTemplateApply -Times 0
        }
    }

    Context 'apply' {
        It 'applies through the EPIC-006 gate and surfaces before/after audit' {
            Mock Invoke-TransportTemplateApply {
                param($TenantId, $Payload)
                return [pscustomobject]@{
                    result     = @{ id = 'rule-1'; name = $Payload['name'] }
                    auditEvent = @{
                        id         = 'audit-1'
                        tenantId   = $TenantId
                        action     = 'transport.rule.create'
                        targetId   = 'rule-1'
                        targetName = $Payload['name']
                        before     = $null
                        after      = $Payload
                    }
                }
            }

            $res = Invoke-DeployTransportTemplate -TenantId 'tenant-a' -Kind 'rule' -TemplateJson (Get-RuleTemplateJson) -Variables @{ partnerDomain = 'partner.example.invalid' } -Actor 'operator-1' -Confirmed $true

            $res.success | Should -BeTrue
            $res.state | Should -Be 'succeeded'
            $res.auditEvent.action | Should -Be 'transport.rule.create'
            $res.auditEvent.after.name | Should -Be 'Block mail to partner.example.invalid'
            Should -Invoke Invoke-TransportTemplateApply -Times 1 -ParameterFilter {
                $Confirmed -eq $true -and $Payload['name'] -eq 'Block mail to partner.example.invalid'
            }
        }

        It 'requires confirmation before apply' {
            Mock Invoke-TransportTemplateApply { return [pscustomobject]@{} }

            {
                Invoke-DeployTransportTemplate -TenantId 'tenant-a' -Kind 'rule' -TemplateJson (Get-RuleTemplateJson) -Variables @{ partnerDomain = 'partner.example.invalid' }
            } | Should -Throw '*confirm_required*'
            Should -Invoke Invoke-TransportTemplateApply -Times 0
        }

        It 'rejects a missing required variable before applying' {
            Mock Invoke-TransportTemplateApply { return [pscustomobject]@{} }

            {
                Invoke-DeployTransportTemplate -TenantId 'tenant-a' -Kind 'rule' -TemplateJson (Get-RuleTemplateJson) -Variables @{} -Confirmed $true
            } | Should -Throw '*missing_variable*'
            Should -Invoke Invoke-TransportTemplateApply -Times 0
        }

        It 'reports a failed target without throwing' {
            Mock Invoke-TransportTemplateApply { throw 'EXO rejected the rule' }

            $res = Invoke-DeployTransportTemplate -TenantId 'tenant-a' -Kind 'rule' -TemplateJson (Get-RuleTemplateJson) -Variables @{ partnerDomain = 'partner.example.invalid' } -Confirmed $true

            $res.success | Should -BeFalse
            $res.state | Should -Be 'failed'
            $res.error | Should -Match 'EXO rejected'
        }

        It 'deploys a connector template through the gate' {
            Mock Invoke-TransportTemplateApply {
                param($Payload)
                return [pscustomobject]@{
                    result     = @{ id = 'conn-1' }
                    auditEvent = @{ id = 'audit-c'; action = 'connector.create'; after = $Payload }
                }
            }

            $res = Invoke-DeployTransportTemplate -TenantId 'tenant-a' -Kind 'connector' -TemplateJson (Get-ConnectorTemplateJson) -Variables @{ partnerDomain = 'partner.example.invalid' } -Confirmed $true

            $res.success | Should -BeTrue
            $res.auditEvent.action | Should -Be 'connector.create'
            Should -Invoke Invoke-TransportTemplateApply -Times 1 -ParameterFilter { $Kind -eq 'connector' }
        }
    }
}
