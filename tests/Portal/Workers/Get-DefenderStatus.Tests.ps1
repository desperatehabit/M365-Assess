BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-DefenderStatus.ps1'
    $script:entrypoint = Join-Path $script:repoRoot 'portal/workers/get-defender-status.ps1'

    function global:Invoke-MgGraphRequest {
        param($Method, $Uri, $Body)
    }

    . $script:worker
}

Describe 'Get-DefenderStatus worker (T-0361)' {

    Context 'the worker files' {
        It 'ships the worker functions and the entrypoint' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            Test-Path -LiteralPath $script:entrypoint | Should -BeTrue
            (Get-Command Get-DefenderStatus -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-DefenderStatusJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues GET requests and no POST/DELETE/PATCH' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Invoke-MgGraphRequest -Method GET'
            $source | Should -Not -Match '-Method POST'
            $source | Should -Not -Match '-Method DELETE'
            $source | Should -Not -Match '-Method PATCH'
            $source | Should -Not -Match '-Method PUT'
            $entrySource = Get-Content -LiteralPath $script:entrypoint -Raw
            $entrySource | Should -Not -Match '-Method POST'
            $entrySource | Should -Not -Match '-Method DELETE'
            $entrySource | Should -Not -Match '-Method PATCH'
        }

        It 'targets the beta device-management resources (v1.0 lacks them)' {
            # Live tenant: v1.0/configurationPolicies and v1.0/intents return
            # "Resource not found for the segment"; beta returns 200 (EPIC-019).
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'beta/deviceManagement/configurationPolicies'
            $source | Should -Match 'beta/deviceManagement/intents'
            $source | Should -Not -Match 'v1\.0/deviceManagement/configurationPolicies'
            $source | Should -Not -Match 'v1\.0/deviceManagement/intents'
        }

        It 'uses only Get-* EXO cmdlets, never tenant writes' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'Get-MalwareFilterPolicy'
            $source | Should -Match 'Get-AtpPolicyForO365'
            $source | Should -Match 'Get-AntiPhishPolicy'
            $source | Should -Match 'Get-SafeLinksPolicy'
            $source | Should -Not -Match 'Invoke-Expression'
            $source | Should -Not -Match 'Set-MalwareFilterPolicy'
            $source | Should -Not -Match 'New-SafeLinksPolicy'
        }

        It 'reuses the module Defender check ids as finding provenance' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Match 'DEFENDER-ANTIMALWARE-001'
            $source | Should -Match 'DEFENDER-ZAP-001'
            $source | Should -Match 'DEFENDER-ANTIPHISH-001'
            $source | Should -Match 'DEFENDER-SAFELINKS-001'
        }
    }

    Context 'Get-DefenderStatus area reporting' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{ value = @(@{ id = 'policy-1' }) }
            }
        }

        It 'returns current vs recommended per policy area' {
            $result = Get-DefenderStatus -TenantId 'tenant-test'
            $result.tenantId | Should -Be 'tenant-test'
            $result.areas.Count | Should -Be 6
            foreach ($area in $result.areas) {
                $area.current | Should -Not -BeNullOrEmpty
                $area.recommended | Should -Not -BeNullOrEmpty
                $area.status | Should -Not -BeNullOrEmpty
            }
        }

        It 'supports AV/EDR/ASR in v1' {
            $result = Get-DefenderStatus -TenantId 'tenant-test'
            foreach ($name in @('av', 'edr', 'asr')) {
                $area = @($result.areas | Where-Object { $_.area -eq $name })[0]
                $area | Should -Not -BeNullOrEmpty
                $area.supported | Should -BeTrue
            }
        }

        It 'marks compliance, firewall, and exclusions as not yet supported' {
            $result = Get-DefenderStatus -TenantId 'tenant-test'
            foreach ($name in @('compliance', 'firewall', 'exclusions')) {
                $area = @($result.areas | Where-Object { $_.area -eq $name })[0]
                $area | Should -Not -BeNullOrEmpty
                $area.supported | Should -BeFalse
                $area.status | Should -Be 'Unsupported'
                $area.current | Should -Be 'Not yet supported in v1'
            }
        }

        It 'returns deferred areas without issuing Graph queries' {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                throw "Graph must not be queried for deferred areas"
            }

            $result = Get-DefenderStatus -TenantId 'tenant-test' -Area 'firewall'
            $result.areas.Count | Should -Be 1
            $result.areas[0].area | Should -Be 'firewall'
            $result.areas[0].supported | Should -BeFalse
        }

        It 'narrows to a single area with -Area' {
            $result = Get-DefenderStatus -TenantId 'tenant-test' -Area 'av'
            $result.areas.Count | Should -Be 1
            $result.areas[0].area | Should -Be 'av'
            $result.areas[0].supported | Should -BeTrue
        }
    }

    Context 'module Defender check reuse' {
        BeforeEach {
            Mock Invoke-MgGraphRequest {
                param($Method, $Uri, $Body)
                return @{ value = @(@{ id = 'policy-1' }) }
            }
        }

        AfterEach {
            foreach ($name in @('Get-MalwareFilterPolicy', 'Get-AntiPhishPolicy', 'Get-SafeLinksPolicy', 'Get-AtpPolicyForO365')) {
                if (Get-Command -Name $name -ErrorAction SilentlyContinue) {
                    Remove-Item -Path "Function:\$name" -ErrorAction SilentlyContinue
                }
            }
        }

        It 'maps anti-malware policies to AV findings with the module check id' {
            function global:Get-MalwareFilterPolicy { return @(
                [pscustomobject]@{ Name = 'Default'; EnableFileFilter = $true }
                [pscustomobject]@{ Name = 'Custom'; EnableFileFilter = $false }
            ) }

            $result = Get-DefenderStatus -TenantId 'tenant-test' -Area 'av'
            $result.areas[0].status | Should -Be 'Fail'
            $finding = @($result.areas[0].findings | Where-Object { $_.setting -like 'Common Attachment Filter*' })[0]
            $finding | Should -Not -BeNullOrEmpty
            $finding.checkId | Should -Be 'DEFENDER-ANTIMALWARE-001'
            $finding.recommendedValue | Should -Be 'True'
        }

        It 'maps phishing thresholds to ASR findings with the module check id' {
            function global:Get-AntiPhishPolicy { return @(
                [pscustomobject]@{ Name = 'Default'; PhishThresholdLevel = 1 }
            ) }

            $result = Get-DefenderStatus -TenantId 'tenant-test' -Area 'asr'
            $result.areas[0].status | Should -Be 'Fail'
            $finding = @($result.areas[0].findings | Where-Object { $_.setting -like 'Phishing Threshold*' })[0]
            $finding | Should -Not -BeNullOrEmpty
            $finding.checkId | Should -Be 'DEFENDER-ANTIPHISH-001'
        }
    }

    Context 'Read-DefenderStatusJob' {
        It 'parses tenantId and optional area from a job envelope' {
            $jobPath = Join-Path $TestDrive 'defender-status-job.json'
            @{ tenantId = 'tenant-test'; area = 'edr' } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            $job = Read-DefenderStatusJob -Path $jobPath
            $job['TenantId'] | Should -Be 'tenant-test'
            $job['Area'] | Should -Be 'edr'
        }

        It 'defaults area to empty when the envelope omits it' {
            $jobPath = Join-Path $TestDrive 'defender-status-job-no-area.json'
            @{ tenantId = 'tenant-test' } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            $job = Read-DefenderStatusJob -Path $jobPath
            $job['TenantId'] | Should -Be 'tenant-test'
            $job['Area'] | Should -Be ''
        }

        It 'throws when tenantId is missing' {
            $jobPath = Join-Path $TestDrive 'defender-status-job-bad.json'
            @{ area = 'av' } | ConvertTo-Json | Set-Content -LiteralPath $jobPath
            { Read-DefenderStatusJob -Path $jobPath } | Should -Throw
        }
    }
}
