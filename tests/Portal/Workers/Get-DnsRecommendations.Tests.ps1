# Get-DnsRecommendations.Tests.ps1
# Pester tests for T-0666 — actionable DNS recommendations.
# Asserts: a p=none DMARC policy and an over-limit SPF each produce a ranked
# recommendation with a CheckID and a remediation link; MTA-STS/TLS-RPT fall
# back to a portal instruction with no CheckID; a clean domain yields no
# recommendations; and the worker stays read-only.

#Requires -Module Pester
Set-StrictMode -Version Latest

Describe 'Get-DnsRecommendations worker (T-0666)' {
    BeforeAll {
        $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
        $script:worker = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers/Get-DnsRecommendations.ps1'
        . $script:worker

        function New-CleanRecordSet {
            return @{
                dmarc  = 'v=DMARC1; p=reject; rua=mailto:dmarc@example.com'
                spf    = 'v=spf1 include:spf.protection.outlook.com -all'
                dkim   = @{ selector1 = $true; selector2 = $true; enabled = $true }
                mx     = @('example-com.mail.protection.outlook.com')
                mtaSts = @{ present = $true }
                tlsRpt = @{ present = $true }
            }
        }
    }

    Context 'the worker file' {
        It 'ships the recommendation functions' {
            Test-Path -LiteralPath $script:worker | Should -BeTrue
            (Get-Command Get-DnsRecommendations -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-DnsRecommendationsJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues no tenant writes and no Graph calls' {
            $source = Get-Content -LiteralPath $script:worker -Raw
            $source | Should -Not -Match 'Invoke-MgGraphRequest'
            $source | Should -Not -Match 'New-DkimSigningConfig'
            $source | Should -Not -Match 'Set-Dns'
        }
    }

    Context 'DMARC policy is none' {
        It 'yields a high recommendation mapped to DNS-DMARC-001 with a remediation link' {
            $records = New-CleanRecordSet
            $records['dmarc'] = 'v=DMARC1; p=none; rua=mailto:dmarc@example.com'

            $result = @(Get-DnsRecommendations -Records $records)

            $result.Count | Should -Be 1
            $result[0].recordFamily | Should -Be 'DMARC'
            $result[0].severity | Should -Be 'high'
            $result[0].checkId | Should -Be 'DNS-DMARC-001'
            $result[0].explanation | Should -Match 'none'
            $result[0].remediationUrl | Should -Match '^https://'
        }
    }

    Context 'SPF exceeds 10 lookups' {
        It 'yields a recommendation mapped to DNS-SPF-001' {
            $records = New-CleanRecordSet
            $includes = (1..11 | ForEach-Object { "include:spf$_.example.com" }) -join ' '
            $records['spf'] = "v=spf1 $includes -all"

            $result = @(Get-DnsRecommendations -Records $records)

            $spf = $result | Where-Object { $_.recordFamily -eq 'SPF' }
            $spf | Should -Not -BeNullOrEmpty
            $spf.checkId | Should -Be 'DNS-SPF-001'
            $spf.severity | Should -Be 'high'
            $spf.explanation | Should -Match '10 DNS lookups'
            $spf.remediationUrl | Should -Match '^https://'
        }

        It 'does not flag an SPF record with 10 or fewer lookups' {
            $records = New-CleanRecordSet
            $records['spf'] = 'v=spf1 include:a.example.com include:b.example.com -all'

            @(Get-DnsRecommendations -Records $records) | Should -BeNullOrEmpty
        }
    }

    Context 'MX records' {
        It 'flags a missing MX record against DNS-MX-001' {
            $records = New-CleanRecordSet
            $records['mx'] = @()

            $result = @(Get-DnsRecommendations -Records $records)

            $mx = $result | Where-Object { $_.recordFamily -eq 'MX' }
            $mx | Should -Not -BeNullOrEmpty
            $mx.checkId | Should -Be 'DNS-MX-001'
            $mx.severity | Should -Be 'high'
        }

        It 'flags an MX that does not route to Exchange Online' {
            $records = New-CleanRecordSet
            $records['mx'] = @{ records = @('mail.thirdparty.example') }

            $result = @(Get-DnsRecommendations -Records $records)

            $mx = $result | Where-Object { $_.recordFamily -eq 'MX' }
            $mx | Should -Not -BeNullOrEmpty
            $mx.severity | Should -Be 'medium'
        }
    }

    Context 'families without a module check' {
        It 'falls back to a portal instruction with no CheckID for MTA-STS' {
            $records = New-CleanRecordSet
            $records['mtaSts'] = @{ present = $false }

            $result = @(Get-DnsRecommendations -Records $records)

            $mta = $result | Where-Object { $_.recordFamily -eq 'MTA-STS' }
            $mta | Should -Not -BeNullOrEmpty
            $mta.severity | Should -Be 'low'
            $mta.checkId | Should -BeNullOrEmpty
            $mta.remediation | Should -Not -BeNullOrEmpty
            $mta.remediationUrl | Should -Match '^https://'
        }
    }

    Context 'ranking' {
        It 'orders recommendations by severity, high first' {
            $records = New-CleanRecordSet
            $records['dmarc'] = 'v=DMARC1; p=none;'
            $records['spf'] = 'v=spf1 include:spf.protection.outlook.com ~all'
            $records['mtaSts'] = @{ present = $false }

            $result = @(Get-DnsRecommendations -Records $records)

            $result.Count | Should -Be 3
            $result[0].severity | Should -Be 'high'
            $result[1].severity | Should -Be 'medium'
            $result[2].severity | Should -Be 'low'
        }
    }

    Context 'a clean domain' {
        It 'yields no recommendations (not an error)' {
            $result = @(Get-DnsRecommendations -Records (New-CleanRecordSet))
            $result.Count | Should -Be 0
        }

        It 'yields no recommendations for an empty record set' {
            $result = @(Get-DnsRecommendations -Records @{})
            $result.Count | Should -Be 0
        }
    }

    Context 'job envelope' {
        It 'parses tenantId, domain, and the analysed records' {
            $tempFile = [System.IO.Path]::GetTempFileName()
            try {
                @{
                    tenantId = 'tenant-xyz'
                    domain   = 'example.com'
                    records  = @{ dmarc = 'v=DMARC1; p=none;' }
                } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tempFile

                $job = Read-DnsRecommendationsJob -Path $tempFile
                $job.TenantId | Should -Be 'tenant-xyz'
                $job.Domain | Should -Be 'example.com'
                $job.Records.dmarc | Should -Be 'v=DMARC1; p=none;'
            }
            finally {
                Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
            }
        }

        It 'rejects a job envelope without a tenantId' {
            $tempFile = [System.IO.Path]::GetTempFileName()
            try {
                @{ domain = 'example.com'; records = @{} } | ConvertTo-Json | Set-Content -LiteralPath $tempFile
                { Read-DnsRecommendationsJob -Path $tempFile } | Should -Throw
            }
            finally {
                Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
