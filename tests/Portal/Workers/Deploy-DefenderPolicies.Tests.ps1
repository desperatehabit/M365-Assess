BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Deploy-DefenderPolicies.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/deploy-defender-policies.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Deploy-DefenderPolicies worker (T-0364)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Invoke-DeployDefenderPolicies -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-DefenderDeployJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'targets the beta device-management resources (v1.0 lacks them)' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match '/beta/deviceManagement/configurationPolicies'
            $source | Should -Match '/beta/deviceManagement/intents'
            $source | Should -Not -Match '/v1\.0/deviceManagement/configurationPolicies'
            $source | Should -Not -Match '/v1\.0/deviceManagement/intents'
        }
    }

    Context 'plan preview per policy area' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{ value = @() }
            }
        }

        It 'returns a plan per selected area (AV/EDR/ASR first)' {
            $res = Invoke-DeployDefenderPolicies -TenantId 'tenant-test' `
                -PolicyAreas @('av', 'edr', 'asr') -DryRun $true

            $res.success | Should -BeTrue
            $res.allValid | Should -BeTrue
            @($res.plans).Count | Should -Be 3
            @($res.plans | ForEach-Object { $_.area }) | Should -Be @('av', 'edr', 'asr')
            foreach ($plan in $res.plans) {
                $plan.action | Should -Be 'create'
                $plan.conflict | Should -BeFalse
                $plan.valid | Should -BeTrue
                $plan.diff.Count | Should -BeGreaterThan 0
            }
        }

        It 'rejects unknown policy areas' {
            { Invoke-DeployDefenderPolicies -TenantId 'tenant-test' -PolicyAreas @('phishing') -DryRun $true } | Should -Throw "*unknown Defender policy area*"
        }

        It 'rejects an empty policy area selection' {
            { Invoke-DeployDefenderPolicies -TenantId 'tenant-test' -PolicyAreas @() -DryRun $true } | Should -Throw "*at least one Defender policy area*"
        }

        It 'marks deferred areas as not yet supported without querying Graph' {
            $res = Invoke-DeployDefenderPolicies -TenantId 'tenant-test' -PolicyAreas @('compliance') -DryRun $true

            $res.success | Should -BeFalse
            $res.plans[0].supported | Should -BeFalse
            $res.plans[0].action | Should -Be 'unsupported'
            $res.plans[0].conflictMessage | Should -Match 'not yet supported'
            Should -Invoke Invoke-MgGraphRequest -Times 0 -Exactly
        }

        It 'requires a template name when save-as-template is requested' {
            { Invoke-DeployDefenderPolicies -TenantId 'tenant-test' -PolicyAreas @('av') -SaveAsTemplate $true -DryRun $true } | Should -Throw '*templateName is required*'
        }

        It 'returns a template draft only when save-as-template is requested' {
            $with = Invoke-DeployDefenderPolicies -TenantId 'tenant-test' -PolicyAreas @('av', 'asr') `
                -SaveAsTemplate $true -TemplateName 'Pilot baseline' -DryRun $true
            $with.templateDraft.name | Should -Be 'Pilot baseline'
            @($with.templateDraft.policyAreas) | Should -Be @('av', 'asr')
            $with.templateDraft.policyJson.av | Should -Not -BeNullOrEmpty

            $without = Invoke-DeployDefenderPolicies -TenantId 'tenant-test' -PolicyAreas @('av') -DryRun $true
            $without.templateDraft | Should -BeNullOrEmpty
        }
    }

    Context 'conflict handling and overwrite' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'GET') {
                    return @{
                        value = @(
                            @{ id = 'existing-av-id'; name = 'Defender AV Baseline' }
                        )
                    }
                }
                return @{ id = 'new-id' }
            }
        }

        It 'flags a conflict when the policy already exists and overwrite is off' {
            $res = Invoke-DeployDefenderPolicies -TenantId 'tenant-test' -PolicyAreas @('av') -Overwrite $false -DryRun $true

            $res.plans[0].conflict | Should -BeTrue
            $res.plans[0].valid | Should -BeFalse
            $res.plans[0].conflictMessage | Should -Match 'already exists'
            $res.allValid | Should -BeFalse
        }

        It 'blocks apply when a conflict is unresolved' {
            { Invoke-DeployDefenderPolicies -TenantId 'tenant-test' -PolicyAreas @('av') -Overwrite $false -DryRun $false } | Should -Throw '*Deploy blocked*'
        }

        It 'diffs against the live policy and updates it when overwrite is on' {
            $res = Invoke-DeployDefenderPolicies -TenantId 'tenant-test' -PolicyAreas @('av') -Overwrite $true -DryRun $false

            $res.success | Should -BeTrue
            $res.plans[0].action | Should -Be 'update'
            ($res.plans[0].diff -join "`n") | Should -Match 'Overwriting existing policy'
            $res.results[0].policyId | Should -Be 'existing-av-id'
            Should -Invoke Invoke-MgGraphRequest -ParameterFilter { $Method -eq 'PATCH' } -Times 1 -Exactly
        }
    }

    Context 'apply and audit' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                if ($Method -eq 'GET') {
                    return @{ value = @() }
                }
                return @{ id = 'created-id' }
            }
        }

        It 'creates each selected policy and audits every write' {
            $res = Invoke-DeployDefenderPolicies -TenantId 'tenant-test' `
                -PolicyAreas @('av', 'edr') -DryRun $false -CreatedBy 'operator-test'

            $res.success | Should -BeTrue
            $res.state | Should -Be 'succeeded'
            @($res.results).Count | Should -Be 2
            @($res.auditEvents).Count | Should -Be 2
            foreach ($audit in $res.auditEvents) {
                $audit.action | Should -Be 'defender.deploy.create'
                $audit.tenantId | Should -Be 'tenant-test'
                $audit.actor | Should -Be 'operator-test'
                $audit.targetId | Should -Not -BeNullOrEmpty
            }
            $res.auditEvents[0].area | Should -Be 'av'
            $res.auditEvents[1].area | Should -Be 'edr'
            Should -Invoke Invoke-MgGraphRequest -ParameterFilter { $Method -eq 'POST' } -Times 2 -Exactly
        }
    }

    Context 'job envelope' {
        It 'parses the deploy job envelope' {
            $jobPath = Join-Path $TestDrive 'defender-deploy-job.json'
            @{
                tenantId       = 'tenant-test'
                policyAreas    = @('av', 'edr')
                targetScope    = 'allDevices'
                overwrite      = $false
                dryRun         = $true
                saveAsTemplate = $true
                templateName   = 'Pilot baseline'
                actor          = 'operator-test'
            } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $jobPath

            $job = Read-DefenderDeployJob -Path $jobPath
            $job['TenantId'] | Should -Be 'tenant-test'
            @($job['PolicyAreas']) | Should -Be @('av', 'edr')
            $job['SaveAsTemplate'] | Should -BeTrue
            $job['TemplateName'] | Should -Be 'Pilot baseline'
            $job['Actor'] | Should -Be 'operator-test'
        }

        It 'rejects an envelope without a tenant' {
            $jobPath = Join-Path $TestDrive 'defender-deploy-job-bad.json'
            @{ policyAreas = @('av') } | ConvertTo-Json | Set-Content -LiteralPath $jobPath

            { Read-DefenderDeployJob -Path $jobPath } | Should -Throw "*missing mandatory 'tenantId'*"
        }
    }
}
