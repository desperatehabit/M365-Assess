# Apply-Remediation.Tests.ps1
# Pester tests for T-0838 — the apply-remediation.ps1 entrypoint.
# Asserts: the entrypoint signs in from the job file's credential block
# (Connect-WorkerTenant -JobFile), reads the plan from -PlanFile (the plan job's
# folder), writes remediation-apply.json with each action's state and result, and
# records dry-run results without applying.

#Requires -Module Pester
Set-StrictMode -Version Latest

Describe 'apply-remediation entrypoint (T-0838)' {
    BeforeAll {
        $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
        $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/apply-remediation.ps1'

        . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-RemediationApply.ps1')
        . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

        function New-ApplyJobFile {
            param([bool]$DryRun = $false)
            @{
                schemaVersion = 'v1'
                jobId = 'apply-job-1'
                jobType = 'remediation'
                tenantId = 't-a'
                runId = 'run-1'
                requestId = 'req-1'
                correlationId = 'corr-1'
                createdAt = '2026-09-27T00:00:00.000Z'
                credential = @{
                    credentialRef = 'tenants/t-a/credential'
                    record = @{
                        tenantId = 't-a'
                        authMethod = 'certificate-thumbprint'
                        clientId = 'app-1'
                        secretRef = $null
                        thumbprint = 'ABC'
                        environment = 'commercial'
                    }
                }
                payload = @{
                    operation = 'apply'
                    planId = 'plan-7'
                    dryRun = $DryRun
                    continueOnFailure = $false
                    actor = 'user-1'
                    actionIds = @()
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $script:jobFile
        }

        function New-PlanFile {
            param([string[]]$ActionIds = @('act-1'))
            $actions = @($ActionIds | ForEach-Object {
                [PSCustomObject]@{ id = $_; checkId = 'ENTRA-SECDEFAULT-001'; command = 'Set-EntraSecurityDefaultsState' }
            })
            @{
                Plan = @{ id = 'plan-7'; tenantId = 't-a' }
                Actions = $actions
            } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $script:planFile
        }

        function Mock-ApplyResult {
            param(
                [object[]]$Actions,
                [string]$PlanId,
                [string]$TenantId,
                [bool]$DryRun,
                [bool]$ContinueOnFailure,
                [string]$Actor,
                [string]$CorrelationId,
                [string]$State = 'applied',
                [string]$Error = $null
            )
            $results = @($Actions | ForEach-Object {
                [PSCustomObject]@{
                    actionId = [string]$_.id
                    state = $State
                    before = if ($State -eq 'applied') { @{ enabled = $false } } else { $null }
                    after = if ($State -eq 'applied') { @{ enabled = $true } } else { $null }
                    appliedAt = if ($State -eq 'applied') { '2026-09-27T00:00:01.0000000Z' } else { $null }
                    actor = $Actor
                    result = if ($State -eq 'applied') { @{ enabled = $true } } else { $null }
                    error = $Error
                    dryRun = $DryRun
                }
            })
            [PSCustomObject]@{
                Results = $results
                Summary = @{
                    total = $results.Count
                    applied = @($results | Where-Object { $_.state -eq 'applied' }).Count
                    skipped = @($results | Where-Object { $_.state -eq 'skipped' }).Count
                    failed = @($results | Where-Object { $_.state -eq 'failed' }).Count
                    dryrun = @($results | Where-Object { $_.dryRun }).Count
                }
            }
        }
    }

    BeforeEach {
        $script:jobFolder = Join-Path $TestDrive 'apply-job'
        $script:planFolder = Join-Path $TestDrive 'plan-job'
        New-Item -Path $script:jobFolder -ItemType Directory -Force | Out-Null
        New-Item -Path $script:planFolder -ItemType Directory -Force | Out-Null
        $script:jobFile = Join-Path $script:jobFolder 'job.json'
        $script:planFile = Join-Path $script:planFolder 'remediation-plan.json'
        $script:outFolder = Join-Path $TestDrive 'out'
    }

    It 'is wired to the credential-block sign-in, -PlanFile, and remediation-apply.json' {
        $text = Get-Content -LiteralPath $script:entrypoint -Raw
        $text | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile'
        $text | Should -Match '\$PlanFile'
        $text | Should -Match 'remediation-apply\.json'
    }

    It 'signs in from the job file and applies the plan read from -PlanFile' {
        New-ApplyJobFile
        New-PlanFile -ActionIds @('act-1', 'act-2')

        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }
        Mock Invoke-RemediationApply {
            param(
                [object[]]$Actions,
                [string]$PlanId,
                [string]$TenantId,
                [bool]$DryRun,
                [bool]$ContinueOnFailure,
                [string]$Actor,
                [string]$CorrelationId
            )
            Mock-ApplyResult -Actions $Actions -PlanId $PlanId -TenantId $TenantId -DryRun $DryRun `
                -ContinueOnFailure $ContinueOnFailure -Actor $Actor -CorrelationId $CorrelationId
        }

        & $script:entrypoint -JobFile $script:jobFile -OutputFolder $script:outFolder -PlanFile $script:planFile | Out-Null

        Assert-MockCalled Connect-WorkerTenant -ParameterFilter { $JobFile -eq $script:jobFile }
        Assert-MockCalled Invoke-RemediationApply -ParameterFilter {
            $PlanId -eq 'plan-7' -and @($Actions).Count -eq 2 -and $Actions[0].id -eq 'act-1' -and $Actions[1].id -eq 'act-2'
        }

        $apply = Get-Content -LiteralPath (Join-Path $script:outFolder 'remediation-apply.json') -Raw | ConvertFrom-Json
        $apply.Results.Count | Should -Be 2
        $row = $apply.Results[0]
        $row.state | Should -Be 'applied'
        $row.before.enabled | Should -BeFalse
        $row.after.enabled | Should -BeTrue
        $row.appliedAt.ToString('o') | Should -Be '2026-09-27T00:00:01.0000000Z'
        $row.actor | Should -Be 'user-1'
        $row.dryRun | Should -BeFalse

        $result = Get-Content -LiteralPath (Join-Path $script:outFolder 'result.json') -Raw | ConvertFrom-Json
        $result.status | Should -Be 'succeeded'
        $result.exitCode | Should -Be 0
    }

    It 'reads the plan from its own output folder when -PlanFile is omitted' {
        New-ApplyJobFile
        New-PlanFile
        New-Item -Path $script:outFolder -ItemType Directory -Force | Out-Null
        Copy-Item -LiteralPath $script:planFile -Destination (Join-Path $script:outFolder 'remediation-plan.json')

        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }
        Mock Invoke-RemediationApply {
            param(
                [object[]]$Actions,
                [string]$PlanId,
                [string]$TenantId,
                [bool]$DryRun,
                [bool]$ContinueOnFailure,
                [string]$Actor,
                [string]$CorrelationId
            )
            Mock-ApplyResult -Actions $Actions -PlanId $PlanId -TenantId $TenantId -DryRun $DryRun `
                -ContinueOnFailure $ContinueOnFailure -Actor $Actor -CorrelationId $CorrelationId
        }

        & $script:entrypoint -JobFile $script:jobFile -OutputFolder $script:outFolder | Out-Null

        Assert-MockCalled Invoke-RemediationApply -ParameterFilter { @($Actions).Count -eq 1 -and $Actions[0].id -eq 'act-1' }
        $apply = Get-Content -LiteralPath (Join-Path $script:outFolder 'remediation-apply.json') -Raw | ConvertFrom-Json
        $apply.Results[0].actionId | Should -Be 'act-1'
    }

    It 'records a failed action and fails the job with remediation.apply_failed' {
        New-ApplyJobFile
        New-PlanFile

        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }
        Mock Invoke-RemediationApply {
            param(
                [object[]]$Actions,
                [string]$PlanId,
                [string]$TenantId,
                [bool]$DryRun,
                [bool]$ContinueOnFailure,
                [string]$Actor,
                [string]$CorrelationId
            )
            Mock-ApplyResult -Actions $Actions -PlanId $PlanId -TenantId $TenantId -DryRun $DryRun `
                -ContinueOnFailure $ContinueOnFailure -Actor $Actor -CorrelationId $CorrelationId `
                -State 'failed' -Error 'boom'
        }

        & $script:entrypoint -JobFile $script:jobFile -OutputFolder $script:outFolder -PlanFile $script:planFile | Out-Null

        $apply = Get-Content -LiteralPath (Join-Path $script:outFolder 'remediation-apply.json') -Raw | ConvertFrom-Json
        $apply.Results[0].state | Should -Be 'failed'
        $apply.Results[0].error | Should -Be 'boom'

        $result = Get-Content -LiteralPath (Join-Path $script:outFolder 'result.json') -Raw | ConvertFrom-Json
        $result.status | Should -Be 'failed'
        $result.exitCode | Should -Be 1
        $result.error.code | Should -Be 'remediation.apply_failed'
    }

    It 'records dry-run results without applying' {
        New-ApplyJobFile -DryRun $true
        New-PlanFile

        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }
        Mock Invoke-RemediationApply {
            param(
                [object[]]$Actions,
                [string]$PlanId,
                [string]$TenantId,
                [bool]$DryRun,
                [bool]$ContinueOnFailure,
                [string]$Actor,
                [string]$CorrelationId
            )
            Mock-ApplyResult -Actions $Actions -PlanId $PlanId -TenantId $TenantId -DryRun $DryRun `
                -ContinueOnFailure $ContinueOnFailure -Actor $Actor -CorrelationId $CorrelationId -State 'dryrun'
        }

        & $script:entrypoint -JobFile $script:jobFile -OutputFolder $script:outFolder -PlanFile $script:planFile | Out-Null

        Assert-MockCalled Invoke-RemediationApply -ParameterFilter { $DryRun -eq $true }
        $apply = Get-Content -LiteralPath (Join-Path $script:outFolder 'remediation-apply.json') -Raw | ConvertFrom-Json
        $apply.Results[0].dryRun | Should -BeTrue
        $apply.Results[0].state | Should -Be 'dryrun'
        $apply.Results[0].appliedAt | Should -BeNullOrEmpty

        $result = Get-Content -LiteralPath (Join-Path $script:outFolder 'result.json') -Raw | ConvertFrom-Json
        $result.status | Should -Be 'succeeded'
    }
}
