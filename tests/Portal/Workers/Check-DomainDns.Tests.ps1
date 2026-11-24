# Check-DomainDns.Tests.ps1
# Pester tests for T-0664 (wired by T-0864) — the DNS record-resolution worker.
# Asserts: every family is resolved and evaluated; a clean domain is healthy
# with no recommendations; a p=none DMARC policy and missing SPF/DKIM fail;
# `.onmicrosoft.com` domains are excluded at source; and the worker is read-only.

#Requires -Module Pester
Set-StrictMode -Version Latest

Describe 'Check-DomainDns worker (T-0664, mounted by T-0864)' {
    BeforeAll {
        $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
        $script:workerRoot = Join-Path $script:repoRoot 'portal/workers/M365Portal.Workers'
        $script:implementation = Join-Path $script:workerRoot 'Test-DomainDns.ps1'
        . $script:implementation

        function New-DnsResolver {
            param(
                [string]$Spf = 'v=spf1 include:spf.protection.outlook.com -all',
                [string]$Dmarc = 'v=DMARC1; p=reject; rua=mailto:dmarc@example.com',
                [string[]]$Mx = @('contoso-com.mail.protection.outlook.com'),
                [string[]]$Selectors = @('selector1', 'selector2'),
                [bool]$MtaSts = $true,
                [bool]$TlsRpt = $true
            )

            return {
                param($Name, $Type)
                if ($Name -like '_dmarc.*') {
                    if ($Dmarc) { return @([pscustomobject]@{ Strings = @($Dmarc) }) }
                    return @()
                }
                if ($Name -like '_mta-sts.*') {
                    if ($MtaSts) { return @([pscustomobject]@{ Strings = @('v=STSv1; id=20261108') }) }
                    return @()
                }
                if ($Name -like '_smtp._tls.*') {
                    if ($TlsRpt) { return @([pscustomobject]@{ Strings = @('v=TLSRPTv1; rua=mailto:tls@example.com') }) }
                    return @()
                }
                if ($Name -like '*._domainkey.*') {
                    $selector = $Name.Split('._domainkey.')[0]
                    if ($Selectors -contains $selector) {
                        return @([pscustomobject]@{ NameHost = "$selector-contoso-com._domainkey.contoso.onmicrosoft.com" })
                    }
                    return @()
                }
                if ($Type -eq 'MX') {
                    return @($Mx | ForEach-Object { [pscustomobject]@{ NameExchange = $_; Preference = 10 } })
                }
                if ($Type -eq 'TXT') {
                    if ($Spf) { return @([pscustomobject]@{ Strings = @($Spf) }) }
                    return @()
                }
                return @()
            }.GetNewClosure()
        }
    }

    Context 'the worker file' {
        It 'ships the analysis and job functions' {
            Test-Path -LiteralPath $script:implementation | Should -BeTrue
            (Get-Command Test-DomainDns -CommandType Function) | Should -Not -BeNullOrEmpty
            (Get-Command Read-DomainDnsJob -CommandType Function) | Should -Not -BeNullOrEmpty
        }

        It 'is read-only: issues no tenant writes and no Graph calls' {
            $source = Get-Content -LiteralPath $script:implementation -Raw
            $source | Should -Not -Match 'Invoke-MgGraphRequest'
            $source | Should -Not -Match 'New-DkimSigningConfig'
            $source | Should -Not -Match 'Set-Dns'
        }
    }

    Context 'a clean domain' {
        It 'resolves all six families and reports healthy with no recommendations' {
            $result = Test-DomainDns -Domain 'contoso.com' -ResolveRecord (New-DnsResolver)

            ($result.records.mx -join ',') | Should -Be 'contoso-com.mail.protection.outlook.com'
            $result.records.spf.record | Should -Match 'v=spf1'
            $result.records.spf.lookupCount | Should -Be 1
            $result.records.dkim.selector1 | Should -BeTrue
            $result.records.dkim.selector2 | Should -BeTrue
            $result.records.dmarc.policy | Should -Be 'reject'
            $result.records.mtaSts.present | Should -BeTrue
            $result.records.tlsRpt.present | Should -BeTrue

            $result.health.overall | Should -Be 'healthy'
            $result.health.families.dmarc | Should -Be 'pass'
            $result.recommendations.Count | Should -Be 0
        }
    }

    Context 'misconfiguration' {
        It 'fails DMARC when the policy is none and emits a recommendation' {
            $resolver = New-DnsResolver -Dmarc 'v=DMARC1; p=none;'
            $result = Test-DomainDns -Domain 'contoso.com' -ResolveRecord $resolver

            $result.health.families.dmarc | Should -Be 'fail'
            $result.health.overall | Should -Be 'unhealthy'
            ($result.recommendations -join ' ') | Should -Match 'DMARC policy is `none`'
        }

        It 'fails SPF when no record is published' {
            $result = Test-DomainDns -Domain 'contoso.com' -ResolveRecord (New-DnsResolver -Spf '')

            $result.health.families.spf | Should -Be 'fail'
            ($result.recommendations -join ' ') | Should -Match 'No SPF record'
        }

        It 'warns for a soft-fail SPF record' {
            $result = Test-DomainDns -Domain 'contoso.com' -ResolveRecord (
                New-DnsResolver -Spf 'v=spf1 include:spf.protection.outlook.com ~all'
            )

            $result.health.families.spf | Should -Be 'warn'
            $result.health.overall | Should -Be 'degraded'
        }

        It 'fails DKIM when no selector resolves' {
            $result = Test-DomainDns -Domain 'contoso.com' -ResolveRecord (New-DnsResolver -Selectors @())

            $result.health.families.dkim | Should -Be 'fail'
            ($result.recommendations -join ' ') | Should -Match 'No DKIM selectors'
        }

        It 'warns for missing MTA-STS and TLS-RPT' {
            $result = Test-DomainDns -Domain 'contoso.com' -ResolveRecord (
                New-DnsResolver -MtaSts $false -TlsRpt $false
            )

            $result.health.families.mtaSts | Should -Be 'warn'
            $result.health.families.tlsRpt | Should -Be 'warn'
        }
    }

    Context 'excluded domains' {
        It 'returns an empty result for a Microsoft-managed onmicrosoft.com domain' {
            $result = Test-DomainDns -Domain 'contoso.onmicrosoft.com' -ResolveRecord {
                param($Name, $Type)
                throw 'resolution must not run for an excluded domain'
            }

            $result.records.Count | Should -Be 0
            $result.health.overall | Should -Be 'unknown'
            $result.recommendations.Count | Should -Be 0
        }
    }
}
