# Verify-Remediation.Tests.ps1
# Pester tests for T-0839 — the verify-remediation.ps1 entrypoint.
# Asserts: the entrypoint signs in from the job file's credential block
# (Connect-WorkerTenant -JobFile), runs Invoke-RemediationVerify, writes
# remediation-verify.json with the captured action update, and writes result.json.

#Requires -Module Pester
Set-StrictMode -Version Latest

Describe 'verify-remediation entrypoint (T-0839)' {
    BeforeAll {
        $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
        $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/verify-remediation.ps1'

        . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-RemediationVerify.ps1')
        . (Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Connect-WorkerTenant.ps1')

        function New-VerifyJobFile {
            @{
                schemaVersion = 'v1'
                jobId = 'verify-job-1'
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
                    operation = 'verify'
                    actionId = 'act-1'
                    check = 'ENTRA-SECDEFAULT-001'
                    section = 'Identity'
                    actor = 'user-1'
                }
            } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $script:jobFile
        }

        function New-VerifyResult {
            param(
                [object]$Action,
                [string]$TenantId,
                [string]$Section,
                [string]$Actor,
                [string]$CorrelationId,
                [bool]$Passed = $true
            )
            $actionId = [string]$Action['id']
            $checkId = [string]$Action['checkId']
            $state = if ($Passed) { 'applied' } else { 'failed' }
            $findingStatus = if ($Passed) { 'Pass' } else { 'Fail' }
            $actionUpdate = @{
                state = $state
                error = $null
                appliedAt = '2026-09-27T00:00:03.0000000Z'
                appliedBy = $Actor
                result = @{ verifiedStatus = $findingStatus }
            }
            [PSCustomObject]@{
                ActionId = $actionId
                CheckId = $checkId
                Strategy = 'section'
                FindingStatus = $findingStatus
                Passed = $Passed
                ActionState = $state
                ReEvaluated = $Passed
                Alerted = -not $Passed
            }
        }
    }

    BeforeEach {
        $script:jobFolder = Join-Path $TestDrive 'verify-job'
        New-Item -Path $script:jobFolder -ItemType Directory -Force | Out-Null
        $script:jobFile = Join-Path $script:jobFolder 'job.json'
        $script:outFolder = Join-Path $TestDrive 'out'
    }

    It 'is wired to the credential-block sign-in, remediation-verify.json, and result.json' {
        $text = Get-Content -LiteralPath $script:entrypoint -Raw
        $text | Should -Match 'Connect-WorkerTenant -JobFile \$JobFile'
        $text | Should -Match 'remediation-verify\.json'
        $text | Should -Match 'Invoke-RemediationVerify'
    }

    It 'signs in from the job file and runs Invoke-RemediationVerify' {
        New-VerifyJobFile

        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }
        Mock Invoke-RemediationVerify {
            param(
                [object]$Action,
                [string]$TenantId,
                [string]$Section,
                [string]$Actor,
                [string]$CorrelationId,
                [scriptblock]$UpdateAction
            )
            $actionId = [string]$Action['id']
            & $UpdateAction $actionId @{ state = 'applied'; error = $null; appliedAt = '2026-09-27T00:00:03.0000000Z'; appliedBy = $Actor; result = @{ verifiedStatus = 'Pass' } }
            New-VerifyResult -Action $Action -TenantId $TenantId -Section $Section -Actor $Actor -CorrelationId $CorrelationId -Passed $true
        }

        & $script:entrypoint -JobFile $script:jobFile -OutputFolder $script:outFolder | Out-Null

        Assert-MockCalled Connect-WorkerTenant -ParameterFilter { $JobFile -eq $script:jobFile }
        Assert-MockCalled Invoke-RemediationVerify -ParameterFilter {
            $Action['id'] -eq 'act-1' -and $Action['checkId'] -eq 'ENTRA-SECDEFAULT-001' -and $TenantId -eq 't-a'
        }

        $verify = Get-Content -LiteralPath (Join-Path $script:outFolder 'remediation-verify.json') -Raw | ConvertFrom-Json
        $verify.ActionId | Should -Be 'act-1'
        $verify.ActionState | Should -Be 'applied'
        $verify.Passed | Should -BeTrue
        $verify.ActionUpdates.Count | Should -Be 1
        $verify.ActionUpdates[0].update.state | Should -Be 'applied'
        $verify.ActionUpdates[0].update.appliedBy | Should -Be 'user-1'

        $result = Get-Content -LiteralPath (Join-Path $script:outFolder 'result.json') -Raw | ConvertFrom-Json
        $result.status | Should -Be 'succeeded'
        $result.exitCode | Should -Be 0
    }

    It 'captures a failed verify outcome with state failed' {
        New-VerifyJobFile

        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }
        Mock Invoke-RemediationVerify {
            param(
                [object]$Action,
                [string]$TenantId,
                [string]$Section,
                [string]$Actor,
                [string]$CorrelationId,
                [scriptblock]$UpdateAction
            )
            $actionId = [string]$Action['id']
            & $UpdateAction $actionId @{ state = 'failed'; error = "verify-failed: finding status 'Fail'"; appliedAt = '2026-09-27T00:00:04.0000000Z'; appliedBy = $Actor; result = @{ verifiedStatus = 'Fail' } }
            New-VerifyResult -Action $Action -TenantId $TenantId -Section $Section -Actor $Actor -CorrelationId $CorrelationId -Passed $false
        }

        & $script:entrypoint -JobFile $script:jobFile -OutputFolder $script:outFolder | Out-Null

        $verify = Get-Content -LiteralPath (Join-Path $script:outFolder 'remediation-verify.json') -Raw | ConvertFrom-Json
        $verify.ActionState | Should -Be 'failed'
        $verify.Passed | Should -BeFalse
        $verify.ActionUpdates[0].update.state | Should -Be 'failed'

        $result = Get-Content -LiteralPath (Join-Path $script:outFolder 'result.json') -Raw | ConvertFrom-Json
        $result.status | Should -Be 'succeeded'
    }

    It 'fails the job when the verify logic throws' {
        New-VerifyJobFile

        Mock Connect-WorkerTenant { $null }
        Mock Disconnect-WorkerTenant { }
        Mock Invoke-RemediationVerify { throw "remediation.verify_no_collector: no section collector" }

        { & $script:entrypoint -JobFile $script:jobFile -OutputFolder $script:outFolder | Out-Null } | Should -Throw

        $result = Get-Content -LiteralPath (Join-Path $script:outFolder 'result.json') -Raw | ConvertFrom-Json
        $result.status | Should -Be 'failed'
        $result.exitCode | Should -Be 1
        $result.error.code | Should -Be 'remediation.verify_failed'
    }
}
