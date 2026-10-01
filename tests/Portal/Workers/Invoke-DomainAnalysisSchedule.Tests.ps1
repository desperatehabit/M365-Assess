# Invoke-DomainAnalysisSchedule.Tests.ps1
# Pester tests for T-0667 — scheduled domain analysis. Asserts: one DomainCheck
# per verified domain, `.onmicrosoft.com` excluded per ADR-0003, expired/removed
# and unverified domains skipped, a per-domain analysis failure skipped without
# failing the run, and the prior check handed back for change detection.

#Requires -Module Pester
Set-StrictMode -Version Latest

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Invoke-DomainAnalysisSchedule.ps1'

    . $script:worker

    $script:appended = [System.Collections.Generic.List[object]]::new()

    function script:New-CheckRepo {
        $repo = [PSCustomObject]@{ Appended = $script:appended; Count = 0 }
        Add-Member -InputObject $repo -MemberType ScriptMethod -Name 'AppendDomainCheck' -Value {
            param($checkInput)
            $this.Count = $this.Count + 1
            $row = [pscustomobject]@{
                id              = $checkInput['id']
                tenantId        = $checkInput['tenantId']
                domain          = $checkInput['domain']
                at              = $checkInput['at']
                records         = $checkInput['records']
                health          = $checkInput['health']
                recommendations = $checkInput['recommendations']
            }
            $this.Appended.Add($row)
            return $row
        }
        return $repo
    }

    function script:New-Analyser {
        param([string[]]$FailFor = @())
        return {
            param($Domain)
            if ($FailFor -contains $Domain) { throw "resolution failed for $Domain" }
            return [pscustomobject]@{
                records         = @{
                    mx   = @("$Domain.mail.protection.outlook.com")
                    spf  = 'v=spf1 include:spf.protection.outlook.com -all'
                    dmarc = 'v=DMARC1; p=reject'
                }
                health          = @{ overall = 'healthy' }
                recommendations = @()
            }
        }.GetNewClosure()
    }
}

Describe 'Invoke-DomainAnalysisSchedule worker (T-0667)' {

    BeforeEach {
        $script:appended.Clear()
    }

    Context 'the worker file' {
        It 'ships the worker functions' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            (Get-Command Invoke-DomainAnalysisSchedule -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-DomainAnalysisScheduleJob -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Test-OnMicrosoftDomain -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Get-DomainAnalysisSkipReason -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'never mirrors user data to disk' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Out-File'
            $source | Should -Not -Match 'Set-Content'
            $source | Should -Not -Match 'Add-Content'
            $source | Should -Not -Match 'Export-Csv'
            $source | Should -Not -Match 'Start-Transcript'
            $source | Should -Not -Match 'Invoke-Expression'
        }
    }

    Context 'ADR-0003 onmicrosoft exclusion' {
        It 'treats .onmicrosoft.com and its subdomains as Microsoft-managed' {
            Test-OnMicrosoftDomain -Name 'contoso.onmicrosoft.com' | Should -BeTrue
            Test-OnMicrosoftDomain -Name 'CONTOSO.ONMICROSOFT.COM' | Should -BeTrue
            Test-OnMicrosoftDomain -Name 'onmicrosoft.com' | Should -BeTrue
            Test-OnMicrosoftDomain -Name 'contoso.com' | Should -BeFalse
            Test-OnMicrosoftDomain -Name 'onmicrosoft.com.evil.example' | Should -BeFalse
        }

        It 'skips .onmicrosoft.com domains without calling the analyser' {
            $calls = [System.Collections.Generic.List[string]]::new()
            $analyser = {
                param($Domain)
                $calls.Add($Domain)
                return [pscustomobject]@{ records = @{}; health = @{}; recommendations = @() }
            }.GetNewClosure()

            $result = Invoke-DomainAnalysisSchedule -TenantId 'tenant-a' `
                -Domains @([pscustomobject]@{ name = 'contoso.onmicrosoft.com'; isVerified = $true }) `
                -Analyse $analyser -CheckRepo (New-CheckRepo)

            $result.Results.Count | Should -Be 0
            $result.Skipped[0].Reason | Should -Be 'onmicrosoft'
            $calls.Count | Should -Be 0
            $script:appended.Count | Should -Be 0
        }
    }

    Context 'scheduled run persistence' {
        BeforeEach {
            $script:domains = @(
                [pscustomobject]@{ name = 'contoso.com'; isVerified = $true; isInitial = $false },
                [pscustomobject]@{ name = 'fabrikam.com'; isVerified = $true; isInitial = $false },
                [pscustomobject]@{ name = 'unverified.example.com'; isVerified = $false },
                [pscustomobject]@{ name = 'expired.example.com'; isVerified = $true; verification = 'expired' },
                [pscustomobject]@{ name = 'removed.example.com'; isVerified = $true; status = 'removed' },
                [pscustomobject]@{ name = 'contoso.onmicrosoft.com'; isVerified = $true; isInitial = $true }
            )
        }

        It 'persists one DomainCheck per verified domain and skips the rest' {
            $result = Invoke-DomainAnalysisSchedule -TenantId 'tenant-a' `
                -Domains $script:domains -Analyse (New-Analyser) -CheckRepo (New-CheckRepo)

            $script:appended.Count | Should -Be 2
            $result.Results.Count | Should -Be 2
            ($result.Results | ForEach-Object { $_.Domain } | Sort-Object) | Should -Be @('contoso.com', 'fabrikam.com')

            $skipped = @{}
            foreach ($entry in $result.Skipped) { $skipped[$entry.Domain] = $entry.Reason }
            $skipped['unverified.example.com'] | Should -Be 'unverified'
            $skipped['expired.example.com'] | Should -Be 'expired'
            $skipped['removed.example.com'] | Should -Be 'removed'
            $skipped['contoso.onmicrosoft.com'] | Should -Be 'onmicrosoft'
        }

        It 'persists records, health, recommendations, and the run timestamp' {
            $at = '2026-10-01T06:00:00.000Z'
            $null = Invoke-DomainAnalysisSchedule -TenantId 'tenant-a' `
                -Domains @([pscustomobject]@{ name = 'contoso.com'; isVerified = $true }) `
                -Analyse (New-Analyser) -CheckRepo (New-CheckRepo) -At $at

            $row = $script:appended[0]
            $row.tenantId | Should -Be 'tenant-a'
            $row.domain | Should -Be 'contoso.com'
            $row.at | Should -Be $at
            $row.records.mx | Should -Contain 'contoso.com.mail.protection.outlook.com'
            $row.health.overall | Should -Be 'healthy'
            $row.recommendations | Should -Be @()
            $row.id | Should -Not -BeNullOrEmpty
        }

        It 'returns the prior check so the caller can diff it' {
            $prior = @(
                [pscustomobject]@{ domain = 'contoso.com'; records = @{ mx = @('old.mail.example.com') } }
            )
            $result = Invoke-DomainAnalysisSchedule -TenantId 'tenant-a' `
                -Domains @(
                    [pscustomobject]@{ name = 'contoso.com'; isVerified = $true },
                    [pscustomobject]@{ name = 'fabrikam.com'; isVerified = $true }
                ) `
                -PriorChecks $prior -Analyse (New-Analyser) -CheckRepo (New-CheckRepo)

            $contoso = $result.Results | Where-Object { $_.Domain -eq 'contoso.com' }
            $fabrikam = $result.Results | Where-Object { $_.Domain -eq 'fabrikam.com' }
            $contoso.Prior.domain | Should -Be 'contoso.com'
            $contoso.Prior.records.mx | Should -Contain 'old.mail.example.com'
            $fabrikam.Prior | Should -BeNullOrEmpty
        }

        It 'skips a domain whose analysis fails without failing the run' {
            $result = Invoke-DomainAnalysisSchedule -TenantId 'tenant-a' `
                -Domains @(
                    [pscustomobject]@{ name = 'ok.example.com'; isVerified = $true },
                    [pscustomobject]@{ name = 'bad.example.com'; isVerified = $true }
                ) `
                -Analyse (New-Analyser -FailFor @('bad.example.com')) -CheckRepo (New-CheckRepo)

            $script:appended.Count | Should -Be 1
            $script:appended[0].domain | Should -Be 'ok.example.com'
            $failed = $result.Skipped | Where-Object { $_.Domain -eq 'bad.example.com' }
            $failed.Reason | Should -Be 'analysis_failed'
            $failed.Error | Should -Match 'resolution failed'
        }

        It 'rejects a check repository without AppendDomainCheck' {
            {
                Invoke-DomainAnalysisSchedule -TenantId 'tenant-a' -Domains @() `
                    -Analyse (New-Analyser) -CheckRepo ([pscustomobject]@{})
            } | Should -Throw '*check_repo_invalid*'
        }
    }

    Context 'job envelope' {
        It 'reads the prefetched domains and prior checks from the envelope' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ('domain-analysis-job-{0}.json' -f [guid]::NewGuid())
            @{
                schemaVersion = 'v1'
                tenantId      = 'tenant-a'
                correlationId = 'corr-1'
                payload       = @{
                    at          = '2026-10-01T06:00:00.000Z'
                    domains     = @(
                        @{ name = 'contoso.com'; isVerified = $true }
                    )
                    priorChecks = @(
                        @{ domain = 'contoso.com'; records = @{ mx = @('old.mail.example.com') } }
                    )
                }
            } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8
            try {
                $job = Read-DomainAnalysisScheduleJob -Path $path
                $job['TenantId'] | Should -Be 'tenant-a'
                $job['CorrelationId'] | Should -Be 'corr-1'
                $job['At'] | Should -Be '2026-10-01T06:00:00.000Z'
                $job['Domains'].Count | Should -Be 1
                $job['Domains'][0].name | Should -Be 'contoso.com'
                $job['PriorChecks'].Count | Should -Be 1
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects an envelope with no tenant' {
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ('domain-analysis-job-{0}.json' -f [guid]::NewGuid())
            @{ schemaVersion = 'v1'; payload = @{ domains = @() } } |
                ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding UTF8
            try {
                { Read-DomainAnalysisScheduleJob -Path $path } | Should -Throw '*tenantId*'
            }
            finally {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
